/**
 * src/core/sharp.ts — exact-string ("sharp") span detection for content-aware
 * keep-sharp (lever B of the Opus/lower-model unlock).
 *
 * Higher-capability general models (Opus 4.8, GPT) read *imaged* prose almost
 * as well as Fable, but mis-read dense exact strings — hashes, IDs, paths — at
 * a rate that is (a) silent and (b) unrecoverable (applicability.ts documents
 * Opus at 6/15 dense-hex recall vs Fable 100/100). Those are exactly the tokens
 * where a wrong character is a wrong answer with no way to notice.
 *
 * This module finds those spans so the transform can keep them as TEXT while
 * still imaging the surrounding prose (savings preserved, correctness protected).
 * Ordinary prose is deliberately NOT flagged — false positives leak savings.
 *
 * Two consumption modes:
 *   - block-level: `sharpDensity(text)` → a caller can keep a whole
 *     exact-dense block as text (drop-in for `TransformOptions.keepSharp`).
 *   - span-level:  `extractSharp(text)` → imaged `body` with compact markers +
 *     a small verbatim `sidecar` carrying only the sharp spans. Best for mixed
 *     prose+identifier blocks (typical Claude-Code tool_result / history).
 *
 * Pure and dependency-free so it is trivially unit-testable and reusable by both
 * the eval harness and production.
 */

export type SharpKind =
  | 'url'
  | 'uuid'
  | 'path'
  | 'flag'
  | 'hex'
  | 'base64'
  | 'ident'
  | 'num';

export interface SharpSpan {
  /** Start offset in the source string (inclusive). */
  readonly start: number;
  /** End offset in the source string (exclusive). */
  readonly end: number;
  /** The exact matched substring. */
  readonly text: string;
  /** Which detector class matched. */
  readonly kind: SharpKind;
}

interface RawMatch {
  start: number;
  end: number;
  text: string;
  kind: SharpKind;
  /** Lower = higher priority when spans overlap. */
  prio: number;
}

// --- helpers ----------------------------------------------------------------

function hasDigit(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) return true;
  }
  return false;
}

/** Count how many of {lowercase, uppercase, digit} appear in `s`. */
function classCount(s: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) lower = true;
    else if (c >= 65 && c <= 90) upper = true;
    else if (c >= 48 && c <= 57) digit = true;
  }
  return (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0);
}

function countSlashes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 47 /* / */) n++;
  return n;
}

const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/;

// --- detector patterns ------------------------------------------------------
//
// Each pattern is scanned globally; overlaps are resolved by priority (index
// order below: earlier = higher priority) then by longer span. `accept`
// post-filters raw regex hits to suppress prose false positives.

interface Detector {
  kind: SharpKind;
  prio: number;
  re: RegExp;
  /** Return false to reject a raw regex hit (prose guard). */
  accept?: (m: string) => boolean;
}

const DETECTORS: readonly Detector[] = [
  // URLs — flag the whole thing; a single wrong char breaks the link.
  { kind: 'url', prio: 0, re: /https?:\/\/[^\s'"<>)\]}]+/gi },

  // UUID / RFC-4122 — pure structure, always exact-critical.
  {
    kind: 'uuid',
    prio: 1,
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },

  // File paths — a run containing at least one "/". Kept only when it has ≥2
  // segments (≥2 slashes) OR ends in a file extension, so prose "and/or" and
  // fractions are not flagged.
  {
    kind: 'path',
    prio: 2,
    re: /(?:\.{0,2}\/)?(?:[A-Za-z0-9._@~+-]+\/)+[A-Za-z0-9._@~+-]+/g,
    accept: (m) => countSlashes(m) >= 2 || HAS_EXT.test(m),
  },

  // CLI flags — a leading "-" / "--" at a token boundary followed by a letter.
  // The lookbehind stops hyphenated prose ("state-of-the-art") from matching.
  {
    kind: 'flag',
    prio: 3,
    re: /(?<![A-Za-z0-9])--?[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/g,
  },

  // Hex / hashes — 7+ hex chars. Kept only when it contains a digit OR is long
  // (≥12), so all-letter English words that happen to be hex ("defaced") pass.
  {
    kind: 'hex',
    prio: 4,
    re: /\b[0-9a-fA-F]{7,}\b/g,
    accept: (m) => hasDigit(m) || m.length >= 12,
  },

  // base64 / opaque tokens — 20+ char no-space run mixing ≥2 char classes.
  // (No "/" so this never competes with paths.)
  {
    kind: 'base64',
    prio: 5,
    re: /\b[A-Za-z0-9+_-]{20,}={0,2}/g,
    accept: (m) => classCount(m) >= 2,
  },

  // Identifiers — camelCase, snake_case/SCREAMING_CASE, or any letter+digit
  // mixed token. The content classes where a silent char flip is a wrong
  // symbol name.
  { kind: 'ident', prio: 6, re: /\b[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*\b/g }, // camelCase
  { kind: 'ident', prio: 6, re: /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g }, // snake / SCREAMING
  {
    kind: 'ident',
    prio: 6,
    re: /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}\b/g, // letter+digit mix
  },

  // Bare long digit runs — ports, PIDs, line numbers, large counts.
  { kind: 'num', prio: 7, re: /\b\d{4,}\b/g },
];

// --- core scan --------------------------------------------------------------

/**
 * Find non-overlapping exact-string spans in `text`, sorted by start offset.
 * Overlapping raw hits are resolved by detector priority, then by length.
 */
export function findSharpSpans(text: string): SharpSpan[] {
  if (typeof text !== 'string' || text.length === 0) return [];

  const raw: RawMatch[] = [];
  for (const d of DETECTORS) {
    // Fresh lastIndex each call — regexes are module-scoped and stateful.
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = d.re.exec(text)) !== null) {
      const s = m[0];
      if (s.length === 0) {
        d.re.lastIndex++; // guard against zero-width loops
        continue;
      }
      if (d.accept && !d.accept(s)) continue;
      raw.push({ start: m.index, end: m.index + s.length, text: s, kind: d.kind, prio: d.prio });
    }
  }

  // Greedy non-overlap: prefer earlier start, then higher priority (lower prio),
  // then longer span.
  raw.sort((a, b) =>
    a.start - b.start || a.prio - b.prio || b.end - a.end || b.text.length - a.text.length,
  );

  const out: SharpSpan[] = [];
  let cursor = -1;
  for (const r of raw) {
    if (r.start < cursor) continue; // overlaps an already-accepted span
    out.push({ start: r.start, end: r.end, text: r.text, kind: r.kind });
    cursor = r.end;
  }
  return out;
}

/**
 * Fraction of characters (0..1) covered by sharp spans. A block-level signal:
 * high density means most of the block is exact-critical content that should
 * stay as text rather than be imaged. Callers threshold this to build a
 * `TransformOptions.keepSharp` predicate.
 */
export function sharpDensity(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const spans = findSharpSpans(text);
  let covered = 0;
  for (const s of spans) covered += s.end - s.start;
  return covered / text.length;
}

export interface ExtractSharpOptions {
  /** Build the marker inserted in the imaged body for span index `i` (1-based). */
  marker?: (i: number) => string;
}

export interface SidecarEntry {
  /** Marker string that appears in `body` where this span was lifted out. */
  readonly marker: string;
  readonly kind: SharpKind;
  /** Exact original text — the model reads this verbatim. */
  readonly text: string;
}

export interface ExtractSharpResult {
  /** Source with each sharp span replaced by its marker — this is what gets imaged. */
  readonly body: string;
  /** Ordered, de-duplicated verbatim spans — emitted as a small TEXT block. */
  readonly sidecar: SidecarEntry[];
  /** The accepted spans, for telemetry. */
  readonly spans: SharpSpan[];
}

const DEFAULT_MARKER = (i: number): string => `[#${i}]`;

/**
 * Split `text` into an imageable `body` (sharp spans replaced by compact
 * markers) and a `sidecar` of the exact spans (verbatim text). Identical span
 * texts share one marker/entry, so a repeated hash costs the sidecar once.
 *
 * Round-trips: `restoreSharp(body, sidecar) === text` when markers do not
 * collide with source content (see restoreSharp).
 */
export function extractSharp(text: string, opts: ExtractSharpOptions = {}): ExtractSharpResult {
  const spans = findSharpSpans(text);
  if (spans.length === 0) return { body: text, sidecar: [], spans };

  const marker = opts.marker ?? DEFAULT_MARKER;
  const byText = new Map<string, SidecarEntry>();
  const sidecar: SidecarEntry[] = [];

  let body = '';
  let last = 0;
  for (const s of spans) {
    body += text.slice(last, s.start);
    let entry = byText.get(s.text);
    if (entry === undefined) {
      entry = { marker: marker(sidecar.length + 1), kind: s.kind, text: s.text };
      byText.set(s.text, entry);
      sidecar.push(entry);
    }
    body += entry.marker;
    last = s.end;
  }
  body += text.slice(last);

  return { body, sidecar, spans };
}

/**
 * Inverse of `extractSharp`: substitute each sidecar marker back with its exact
 * text. Longer markers are applied first so `[#1]` cannot shadow `[#11]`.
 */
export function restoreSharp(body: string, sidecar: readonly SidecarEntry[]): string {
  let out = body;
  const ordered = [...sidecar].sort((a, b) => b.marker.length - a.marker.length);
  for (const e of ordered) out = out.split(e.marker).join(e.text);
  return out;
}

/**
 * Render the sidecar as a compact verbatim text block for the model. Kept small
 * and label-led so the model treats it as an exact-value key, not prose.
 */
export function renderSidecar(sidecar: readonly SidecarEntry[]): string {
  if (sidecar.length === 0) return '';
  const lines = sidecar.map((e) => `${e.marker} = ${e.text}`);
  return `Exact values (read verbatim; the image uses these markers):\n${lines.join('\n')}`;
}
