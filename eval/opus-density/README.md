# Opus 4.8 lower-density / larger-cell read sweep

**Question (issue #6):** the known Opus misread rate on pxpipe images was measured
at the production **5×8** cell density. If the same text is rendered *less dense*
(bigger cells → fewer chars/page → more pages), does Opus 4.8 read exact strings
reliably enough to be worth enabling — and at what token cost?

This harness answers that with a measurement, **not** a default change. It does
not touch production code or the model allowlist. Fable 5 stays the only default
reader unless the numbers below clear the acceptance bar.

## What it does

For each render **variant** (cell size) it renders one synthetic "session"
transcript to PNG(s) via the production renderer, then asks each **model** a
fixed battery of questions against the image and scores the answers.

- **Variants** (cell = 5+wBonus × 8+hBonus px, all via `RenderStyle`):
  - `5x8` — production density (`{cellWBonus:0, cellHBonus:0}`)
  - `7x10` — `{cellWBonus:2, cellHBonus:2}`
  - `9x12` — `{cellWBonus:4, cellHBonus:4}`
  - `5x8+sharp` — production density **+ lever B** (below)
  - `7x10+sharp` — larger cell **+ lever B**
  Each variant keeps the ≤1568×728 page cap, so images stay in Anthropic's
  linear-billing window (no server-side downscale) and page count rises as
  density drops.

**Lever A (density)** trades savings for OCR fidelity on *everything*.
**Lever B (content-aware keep-sharp, `+sharp`)** targets only the failure class:
`src/core/sharp.ts` detects exact-string spans (hex/hash, UUID, file path, CLI
flag, camel/snake identifier, port/long-number, URL) and lifts them out of the
imaged body into a small **verbatim text sidecar** the model reads exactly —
prose stays imaged, so savings are largely preserved. B mechanically guarantees
correct recall for every *detected* span (it is text, not pixels); the residual
risk is detector recall on real content, which the scored run + `tests/sharp.test.ts`
measure. A and B compose.

### Dry-run cost accounting (measured, no API key)

`tsx run.mjs` with no `ANTHROPIC_API_KEY` prints the token math (savings gate #3).
On the built-in fixture (baseline text = 1335 tok):

| Variant | dims | img tok | sidecar | total | savings |
|---|---|---|---|---|---|
| `5x8` (prod, image-all) | 1568×128 | 280 | – | 280 | **79%** |
| `7x10` (A) | 1562×228 | 504 | – | 504 | 62% |
| `9x12` (A) | 1565×344 | 728 | – | 728 | 45% |
| `5x8+sharp` (B) | 1568×120 | 280 | +56 (6 spans) | 336 | **75%** |
| `7x10+sharp` (A+B) | 1562×198 | 448 | +56 (6 spans) | 504 | 62% |

**Read:** B lifts all 6 exact-string spans to verbatim text for only ~4pp of
savings (79→75%), vs A burning 17–34pp on a blunt cell enlargement. B is the
high-leverage lever — it spends savings *only* on the content that actually
breaks OCR. Final variant choice is **gated on the scored run** (gist==baseline,
zero silent-wrong exact strings); enabling Opus in production stays out of scope
until those numbers clear.
- **Models:** `claude-opus-4-8`, `claude-fable-5` (both high-res tier).
- **Tasks** (each answer committed before ground truth is revealed):
  1. exact 12-char hex recall
  2. camelCase identifier recall
  3. file path / CLI flag / number recall
  4. gist recall (a decision / value / state that survives lossy reads)
  5. never-stated-fact guard — the correct answer is "not stated / UNKNOWN"

## Metrics (per model × variant)

- exact-match accuracy (tasks 1–3)
- **confabulation count** — a confident *wrong* exact string (the dangerous mode)
- abstain / "not safe to quote" count
- gist accuracy (task 4) and false-answer rate on the guard (task 5)
- image tokens (28-px patch count), text-baseline tokens, and savings %
- rough wall-clock latency

## Acceptance — do NOT claim "Opus works" unless, for a variant:

- gist recall == the text baseline (or within a pre-declared tolerance), AND
- every exact-identifier question is either answered correctly OR abstains /
  refers to the factsheet — **zero silent wrong exact strings** on the protected
  exact tasks, AND
- token savings stay positive on token-dense Claude-Code-like content.

Only a variant that clears all three is a candidate for an opt-in Opus render
profile. Enabling Opus in `DEFAULT_MODEL_BASES` is explicitly out of scope until
then.

## Run

```bash
# Dry run — renders every variant and prints the token/savings accounting.
# No API key needed; no model is called.
pnpm exec tsx eval/opus-density/run.mjs

# Full run — also calls the models and scores the battery.
ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx eval/opus-density/run.mjs
```

Results are written to `eval/opus-density/results.json`. This directory holds no
committed results yet — it is the harness only; fill it in on a machine with API
access.
