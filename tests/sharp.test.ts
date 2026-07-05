/**
 * Tests for src/core/sharp.ts — exact-string ("sharp") span detection, the
 * primitive behind content-aware keep-sharp (lever B of the Opus unlock).
 *
 * Two properties matter and pull in opposite directions:
 *   - RECALL: every exact-critical class (hex/hash, uuid, path, flag, token,
 *     identifier, port, url) must be flagged — a missed span is a silent,
 *     unrecoverable mis-OCR risk.
 *   - PRECISION: ordinary prose must NOT be flagged — every false positive is a
 *     span forced back to text, i.e. leaked savings.
 */

import { describe, expect, it } from 'vitest';
import {
  findSharpSpans,
  sharpDensity,
  extractSharp,
  restoreSharp,
  renderSidecar,
  type SharpKind,
} from '../src/core/sharp.js';

/** Convenience: the set of matched substrings (order-independent). */
function hits(text: string): string[] {
  return findSharpSpans(text).map((s) => s.text);
}
function kindsOf(text: string): SharpKind[] {
  return findSharpSpans(text).map((s) => s.kind);
}

describe('findSharpSpans — recall (must flag exact-critical content)', () => {
  it('flags a 12-char hex cache key', () => {
    expect(hits('The token cache key is a3f9c1e0b7d2.')).toContain('a3f9c1e0b7d2');
  });

  it('flags an all-letter hex hash of length >= 12', () => {
    expect(hits('marker deadbeefcafe end')).toContain('deadbeefcafe');
  });

  it('flags a git-style short sha containing digits', () => {
    expect(hits('at commit 4dae94a now')).toContain('4dae94a');
  });

  it('flags a UUID', () => {
    const u = 'ad09eac3-7e2f-4baf-80be-6995f7826101';
    const s = findSharpSpans(`session ${u} started`);
    expect(s.map((x) => x.text)).toContain(u);
    expect(s.find((x) => x.text === u)?.kind).toBe('uuid');
  });

  it('flags a multi-segment file path with extension', () => {
    const h = hits('moved into src/core/anthropic-vision.ts today');
    expect(h).toContain('src/core/anthropic-vision.ts');
  });

  it('flags an absolute path', () => {
    expect(hits('see /Users/foo/.claude/settings.json here')).toContain(
      '/Users/foo/.claude/settings.json',
    );
  });

  it('flags a CLI flag', () => {
    expect(hits('pass --max-visual-tokens to it')).toContain('--max-visual-tokens');
  });

  it('flags a single-dash short flag', () => {
    expect(hits('run with -v enabled')).toContain('-v');
  });

  it('flags a camelCase identifier', () => {
    expect(hits('renamed field to tokenLedgerShard here')).toContain('tokenLedgerShard');
  });

  it('flags SCREAMING_SNAKE env vars', () => {
    expect(hits('unset NODE_EXTRA_CA_CERTS first')).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('flags a letter+digit mixed identifier', () => {
    expect(hits('encode as utf8 stream')).toContain('utf8');
  });

  it('flags a 5-digit port', () => {
    expect(hits('proxy stays on port 47821 ok')).toContain('47821');
  });

  it('flags a URL', () => {
    const url = 'https://api.anthropic.com/v1/messages';
    expect(hits(`POST ${url} now`)).toContain(url);
  });

  it('flags a long opaque base64-ish token', () => {
    const tok = 'sk-ant-Ab12Cd34Ef56Gh78Ij90';
    // contains a dash-run; token detector or ident should cover it
    expect(findSharpSpans(`key ${tok} set`).length).toBeGreaterThan(0);
  });
});

describe('findSharpSpans — precision (must NOT flag prose)', () => {
  const proseCases = [
    'The retry budget was three attempts, backing off gently.',
    'This is a perfectly normal English sentence about caching.',
    'We should decide whether and/or when to proceed.',
    'A state-of-the-art approach to the well-known problem.',
    'It took about 250 ms to complete the request.',
    'Please review the design and share your feedback soon.',
    'The quick brown fox jumps over the lazy dog.',
  ];
  for (const s of proseCases) {
    it(`leaves prose untouched: "${s.slice(0, 32)}…"`, () => {
      expect(findSharpSpans(s)).toEqual([]);
    });
  }

  it('does not flag a 3-digit number', () => {
    expect(hits('backing off 250 ms')).not.toContain('250');
  });

  it('does not flag a short version like 4.8', () => {
    expect(hits('running Opus 4.8 now')).toEqual([]);
  });

  it('does not treat hyphenated prose as flags', () => {
    expect(kindsOf('a state-of-the-art result')).not.toContain('flag');
  });
});

describe('extractSharp / restoreSharp — round-trip and sidecar', () => {
  const text =
    'Done. Cache key a3f9c1e0b7d2 in src/core/anthropic-vision.ts; ' +
    'renamed to tokenLedgerShard; flag --max-visual-tokens; port 47821.';

  it('replaces every span with a marker in the body', () => {
    const { body, sidecar } = extractSharp(text);
    expect(sidecar.length).toBeGreaterThanOrEqual(5);
    // None of the exact strings remain in the imaged body.
    for (const e of sidecar) expect(body).not.toContain(e.text);
    // Each marker appears in the body.
    for (const e of sidecar) expect(body).toContain(e.marker);
  });

  it('round-trips exactly', () => {
    const { body, sidecar } = extractSharp(text);
    expect(restoreSharp(body, sidecar)).toBe(text);
  });

  it('de-duplicates repeated spans to one sidecar entry', () => {
    const dup = 'first a3f9c1e0b7d2 then a3f9c1e0b7d2 again';
    const { sidecar, body } = extractSharp(dup);
    const hexEntries = sidecar.filter((e) => e.text === 'a3f9c1e0b7d2');
    expect(hexEntries.length).toBe(1);
    // Marker used twice in the body.
    const marker = hexEntries[0]!.marker;
    expect(body.split(marker).length - 1).toBe(2);
    expect(restoreSharp(body, sidecar)).toBe(dup);
  });

  it('markers [#1].. do not shadow [#11] on restore', () => {
    const many = Array.from({ length: 12 }, (_, i) => `id${i}a1b2c3d4e5f6`).join(' ');
    const { body, sidecar } = extractSharp(many);
    expect(sidecar.length).toBe(12);
    expect(restoreSharp(body, sidecar)).toBe(many);
  });

  it('no-op body when there is nothing sharp', () => {
    const prose = 'A perfectly ordinary sentence with no identifiers.';
    const { body, sidecar } = extractSharp(prose);
    expect(body).toBe(prose);
    expect(sidecar).toEqual([]);
  });

  it('renderSidecar emits a labelled verbatim block', () => {
    const { sidecar } = extractSharp(text);
    const block = renderSidecar(sidecar);
    expect(block).toContain('read verbatim');
    for (const e of sidecar) expect(block).toContain(e.text);
  });
});

describe('sharpDensity — block-level signal', () => {
  it('is high for an ID-dominated block', () => {
    const dense = 'a3f9c1e0b7d2 ad09eac3-7e2f-4baf-80be-6995f7826101 /a/b/c.ts --flag-x 47821';
    expect(sharpDensity(dense)).toBeGreaterThan(0.5);
  });

  it('is ~0 for prose', () => {
    expect(sharpDensity('This is a normal sentence with ordinary words.')).toBe(0);
  });

  it('is modest for mixed prose with a couple of identifiers', () => {
    const mixed =
      'We wired the retry path and set the cache key to a3f9c1e0b7d2 after review.';
    const d = sharpDensity(mixed);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(0.4);
  });
});
