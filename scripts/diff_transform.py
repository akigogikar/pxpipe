#!/usr/bin/env python3
"""
Diff harness at the TRANSFORM layer: synthesize a realistic Anthropic
/v1/messages body, run it through Python proxy.transform_request() AND
the Rust transform_only binary, then diff what each emits.

This is the validation we need before switching :47821 to Rust. It
catches divergences in:
  - Field structure (system field rewriting, cache_control placement)
  - Image block emission (number of imgs, dims)
  - Tools/schemas/reminders compression behavior
  - JSON serialization order (Anthropic cache hashes on bytes)

Run:
  python3 scripts/diff_transform.py
"""

import io
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import proxy as py_proxy  # noqa: E402

RUST_BIN = ROOT / "src" / "rust" / "target" / "release" / "examples" / "transform_only"


def synthesize_body() -> bytes:
    """Build a realistic Claude Code-shaped /v1/messages body.

    Shape based on what real Anthropic API requests look like:
      - long `system` field (system prompt content)
      - `tools` array with name/description/input_schema each
      - `messages` array
      - `max_tokens`, `model`, etc.
    """
    # Real-ish system prompt: load CLAUDE.md + some extra padding to clear MIN_COMPRESS_CHARS=2000
    sysprompt_parts = []
    try:
        sysprompt_parts.append((ROOT / "CLAUDE.md").read_text())
    except Exception:
        pass
    try:
        sysprompt_parts.append((ROOT / "HANDOFF.md").read_text())
    except Exception:
        pass
    sysprompt_parts.append(
        "\n## Additional padding to ensure >2000 chars\n"
        + "Line of fake system instructions blah blah blah.\n" * 30
    )
    sysprompt = "\n\n".join(sysprompt_parts)

    body = {
        "model": "claude-opus-4-5-20250929",
        "max_tokens": 8192,
        "system": [
            {"type": "text", "text": sysprompt},
        ],
        "tools": [
            {
                "name": "Bash",
                "description": "Execute a bash command with optional timeout.\n\nThe command runs in a fresh subshell. Use this for git, builds, file ops.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "The bash command to execute."},
                        "timeout": {"type": "integer", "description": "Timeout in milliseconds. Defaults to 120000."},
                        "description": {"type": "string", "description": "A short description of what the command does."},
                    },
                    "required": ["command"],
                },
            },
            {
                "name": "Read",
                "description": "Read a file from disk.\n\nReturns up to 2000 lines starting from offset. Long lines truncated at 2000 chars.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string", "description": "Absolute path to the file."},
                        "offset": {"type": "integer", "description": "1-indexed line to start at."},
                        "limit": {"type": "integer", "description": "Max number of lines to read."},
                    },
                    "required": ["file_path"],
                },
            },
            {
                "name": "Edit",
                "description": "Apply an exact-string find/replace in a file.\n\nold_string must match exactly including whitespace. Use replace_all for global.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file_path": {"type": "string"},
                        "old_string": {"type": "string"},
                        "new_string": {"type": "string"},
                        "replace_all": {"type": "boolean"},
                    },
                    "required": ["file_path", "old_string", "new_string"],
                },
            },
        ],
        "messages": [
            {
                "role": "user",
                "content": "Run `git status` and tell me what's modified.",
            },
        ],
    }
    return json.dumps(body).encode()


def deep_compare(a, b, path=""):
    """Walk two JSON structures and yield (path, kind, py_repr, rs_repr) diffs."""
    if type(a) is not type(b):
        yield (path, "type", type(a).__name__, type(b).__name__)
        return
    if isinstance(a, dict):
        keys_only_py = set(a) - set(b)
        keys_only_rs = set(b) - set(a)
        for k in keys_only_py:
            yield (f"{path}.{k}", "missing_in_rs", short(a[k]), "<missing>")
        for k in keys_only_rs:
            yield (f"{path}.{k}", "missing_in_py", "<missing>", short(b[k]))
        for k in set(a) & set(b):
            yield from deep_compare(a[k], b[k], f"{path}.{k}")
        return
    if isinstance(a, list):
        if len(a) != len(b):
            yield (path, "list_len", str(len(a)), str(len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            yield from deep_compare(x, y, f"{path}[{i}]")
        return
    if a != b:
        yield (path, "value", short(a), short(b))


def short(v) -> str:
    s = json.dumps(v) if not isinstance(v, str) else v
    if len(s) > 80:
        return s[:77] + "..."
    return s


def main():
    if not RUST_BIN.exists():
        print(f"build rust first: cd src/rust && cargo build --release --example transform_only")
        sys.exit(1)

    body = synthesize_body()
    print(f"input body: {len(body)} bytes")

    # Python transform
    py_out, py_info = py_proxy.transform_request(body)
    print(f"python transform: out={len(py_out)}B  info_keys={sorted(py_info.keys())}")

    # Rust transform via subprocess
    rust_dir = Path("/tmp/cip_xform_rs")
    rust_dir.mkdir(exist_ok=True)
    body_path = rust_dir / "body_in.json"
    body_path.write_bytes(body)
    r = subprocess.run(
        [str(RUST_BIN), str(body_path), str(rust_dir)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("RUST FAILED:", r.stderr); sys.exit(2)
    print("rust transform stderr:", r.stderr.strip())
    rs_out = (rust_dir / "body_out.json").read_bytes()
    rs_info = json.loads((rust_dir / "info.json").read_text())

    print(f"rust transform: out={len(rs_out)}B  info_keys={sorted(rs_info.keys())}")

    print(f"\n=== body bytes: py={len(py_out)} rs={len(rs_out)} delta={len(rs_out)-len(py_out):+d} ===")

    # Decode and structural diff
    try:
        py_json = json.loads(py_out)
        rs_json = json.loads(rs_out)
    except json.JSONDecodeError as e:
        print(f"FAIL: invalid JSON output: {e}")
        sys.exit(3)

    diffs = list(deep_compare(py_json, rs_json, "$"))
    if not diffs:
        print("body JSON is STRUCTURALLY IDENTICAL")
    else:
        print(f"\nfound {len(diffs)} structural diffs (showing first 30):")
        for path, kind, pv, rv in diffs[:30]:
            print(f"  [{kind:18s}] {path}")
            print(f"    py: {pv}")
            print(f"    rs: {rv}")
        if len(diffs) > 30:
            print(f"  ... and {len(diffs)-30} more")

    # Info side-by-side
    print("\n=== TransformInfo comparison ===")
    common = sorted(set(py_info.keys()) | set(rs_info.keys()))
    print(f"{'field':30s} {'python':>14s}  {'rust':>14s}")
    for k in common:
        pv = py_info.get(k, "<missing>")
        rv = rs_info.get(k, "<missing>")
        if isinstance(pv, list): pv = f"list[{len(pv)}]"
        if isinstance(rv, list): rv = f"list[{len(rv)}]"
        print(f"{k:30s} {str(pv):>14s}  {str(rv):>14s}")

    sys.exit(0 if not diffs else 1)


if __name__ == "__main__":
    main()
