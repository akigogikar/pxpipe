/**
 * Regression tests for DashboardState.fitCosts() — the empirical
 * α (chars/token) + β (pixels/token) regression that powers honest
 * `saved_pct` in the live dashboard.
 *
 * Specifically locks in: warm-cache-hit requests MUST seed the fit ring.
 * Anthropic's tokenizer is deterministic on input bytes; cache state
 * changes billing, not token count. An earlier version of the gate
 * required `cache_read === 0` ("true cold miss") which locked the fit
 * out of all normal traffic — these tests prevent that regression.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DashboardState } from '../src/dashboard.js';
import type { SessionsPaths } from '../src/sessions.js';
import type { ProxyEvent } from '../src/core/proxy.js';

function makeTmp(): SessionsPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpipe-fit-'));
  return {
    eventsFile: path.join(dir, 'events.jsonl'),
    sidecarDir: path.join(dir, '4xx-bodies'),
  };
}

/** Build a synthetic ProxyEvent at the level fitCosts cares about. The
 *  numbers are toy — what matters for the gate is shape (compressed, full
 *  usage triple, both new measurements present, totalTokens > 1000). */
function ev(args: {
  textChars: number;
  pixels: number;
  input: number;
  cacheCreate: number;
  cacheRead: number;
}): ProxyEvent {
  return {
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    durationMs: 100,
    info: {
      compressed: true,
      origChars: args.textChars + 50_000,
      compressedChars: 50_000,
      imageCount: 5,
      imageBytes: 200_000,
      imagePixels: args.pixels,
      outgoingTextChars: args.textChars,
      staticChars: 30_000,
      dynamicChars: 200,
      dynamicBlockCount: 1,
    },
    usage: {
      input_tokens: args.input,
      output_tokens: 50,
      cache_creation_input_tokens: args.cacheCreate,
      cache_read_input_tokens: args.cacheRead,
    },
  };
}

let dash: DashboardState;
beforeEach(() => {
  // Tmp paths so the fit-ring isn't seeded from any real history.
  const tmp = makeTmp();
  dash = new DashboardState(tmp, async () => new Map());
});

describe('DashboardState.fitCosts() — empirical α/β regression', () => {
  it('returns null with fewer than 3 samples', () => {
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 10, cacheCreate: 5_000, cacheRead: 0 }));
    dash.update(ev({ textChars: 132_000, pixels: 21_000_000, input: 10, cacheCreate: 0, cacheRead: 130_000 }));
    expect(dash.fitCosts()).toBeNull();
  });

  it('seeds the ring from warm cache hits (cache_read > 0)', () => {
    // The bug we're locking against: the old gate `cache_read === 0` rejected
    // every warm hit, leaving the fit forever null in normal traffic. Sample
    // tokens are tuned to a synthetic α ≈ 1/3.5 (= 0.286), β ≈ 5e-3.
    //   sample 1: 130k text, 21M px, tokens = 0.286*130k + 5e-3*21M ≈ 142_180
    //   sample 2: 132k text, 21M px, tokens ≈ 142_752
    //   sample 3: 134k text, 21M px, tokens ≈ 143_324
    // All three are warm hits (cache_read > 0) — old gate would reject all.
    // Pixels constant is fine: OLS no-intercept det = p̄²·(n·Σx² − (Σx)²) > 0
    // when text_chars varies (Cauchy-Schwarz).
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 5,  cacheCreate: 500,   cacheRead: 141_680 }));
    dash.update(ev({ textChars: 132_000, pixels: 21_000_000, input: 5,  cacheCreate: 300,   cacheRead: 142_447 }));
    dash.update(ev({ textChars: 134_000, pixels: 21_000_000, input: 5,  cacheCreate: 200,   cacheRead: 143_119 }));

    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    expect(fit!.n).toBe(3);
    // α ≈ 0.286 → chars_per_token ≈ 3.5; allow ±50% for noise on near-collinear data.
    expect(fit!.chars_per_token).toBeGreaterThan(2);
    expect(fit!.chars_per_token).toBeLessThan(6);
    // β should be positive and surface a sane tokens/image estimate.
    expect(fit!.beta).toBeGreaterThan(0);
    expect(fit!.single_col_tokens_per_img).toBeGreaterThan(0);
  });

  it('uses input + cache_create + cache_read as the LHS (full body tokenization)', () => {
    // Two requests with IDENTICAL body shape but different cache splits:
    // one fully cold, one fully warm. The fit's LHS must treat them as the
    // same token cost. We sneak in a third sample with varying text to make
    // the design matrix non-degenerate.
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 0,  cacheCreate: 142_180, cacheRead: 0 }));
    dash.update(ev({ textChars: 130_000, pixels: 21_000_000, input: 0,  cacheCreate: 0,       cacheRead: 142_180 }));
    dash.update(ev({ textChars: 134_000, pixels: 21_000_000, input: 0,  cacheCreate: 0,       cacheRead: 143_324 }));

    const fit = dash.fitCosts();
    expect(fit).not.toBeNull();
    // Both same-body samples should land on the same regression line, so
    // chars_per_token resolves cleanly to ~3.5 (= 1/0.286 from the construction).
    expect(fit!.chars_per_token).toBeGreaterThan(2);
    expect(fit!.chars_per_token).toBeLessThan(6);
  });

  it('skips requests below the 1000-token floor (filters trivial no-system traffic)', () => {
    // total_tokens = input + cc + cr = 200 + 50 + 100 = 350 < 1000 → not sampled.
    dash.update(ev({ textChars: 500, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    dash.update(ev({ textChars: 600, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    dash.update(ev({ textChars: 700, pixels: 200_000, input: 200, cacheCreate: 50,  cacheRead: 100 }));
    expect(dash.fitCosts()).toBeNull();
  });

  it('skips passthrough (compressed=false) requests', () => {
    const passthroughEvent = (textChars: number): ProxyEvent => ({
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      durationMs: 50,
      info: {
        compressed: false,
        origChars: textChars,
        compressedChars: 0,
        imageCount: 0,
        imageBytes: 0,
        imagePixels: 0,
        outgoingTextChars: textChars,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        reason: 'below_threshold',
      },
      usage: {
        input_tokens: 0,
        output_tokens: 10,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 100_000,
      },
    });
    dash.update(passthroughEvent(130_000));
    dash.update(passthroughEvent(132_000));
    dash.update(passthroughEvent(134_000));
    expect(dash.fitCosts()).toBeNull();
  });
});
