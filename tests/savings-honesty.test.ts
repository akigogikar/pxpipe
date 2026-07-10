/**
 * Dashboard HONESTY invariants — the savings math can never OVERCLAIM.
 *
 * dashboard-api.test.ts checks specific hand-picked scenarios with hardcoded
 * expected numbers. This file is the categorical complement: it sweeps a grid of
 * inputs through the pure cost/baseline functions and asserts universal honesty
 * properties that must hold for EVERY input — so a regression that overclaims in
 * a case nobody thought to hardcode still goes red.
 *
 * The displayed "Saved" = baseline_eff − actual_eff. The two ways to overclaim:
 *   (a) inflate the baseline (the "as text" counterfactual), or
 *   (b) price the counterfactual WARM when this turn was actually COLD (claiming
 *       savings on a prefix that would have been cached as text anyway).
 * The invariants below pin both down on the Anthropic and GPT paths.
 *
 * These are the pure formula functions (no dashboard plumbing) on purpose — they
 * ARE the honesty math; testing them directly makes the guarantees categorical.
 *
 * Run just this file:  pnpm vitest run tests/savings-honesty.test.ts
 */
import { describe, expect, it } from 'vitest';
import { computeBaselineInputEff, computeActualInputEff, CACHE_CREATE_RATE, CACHE_CREATE_1H_RATE, CACHE_READ_RATE } from '../src/core/baseline.js';
import {
  computeOpenAIBaselineInputEff,
  computeOpenAIActualInputEff,
  computeOpenAIBaselineRawTokens,
  openAICacheReadRate,
} from '../src/core/openai-savings.js';

const GPT = 'gpt-5.6';

// ===========================================================================
describe('GPT savings honesty (vs the real o200k cached-rate model)', () => {
  const inputs = [0, 1_000, 10_000];
  const cacheds = [0, 500, 2_000, 50_000]; // last exceeds input → must clamp
  const imageToks = [0, 800, 8_000];
  const baselineImaged = [0, 5_000, 50_000];

  const sweep = (f: (i: number, c: number, im: number, b: number) => void) => {
    for (const i of inputs) for (const c of cacheds) for (const im of imageToks) for (const b of baselineImaged) f(i, c, im, b);
  };

  it('credits ZERO when nothing was imaged (no phantom savings on passthrough)', () => {
    sweep((i, c, im, b) => {
      if (im > 0 && b > 0 && i > 0) return; // imaging-active case handled elsewhere
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      expect(baseline - actual).toBe(0);
    });
  });

  it('saved == (textTokens − imageTokens) × cache-weight, EXACTLY (no inflation)', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      const saved = baseline - actual;
      const weight = c > 0 ? openAICacheReadRate(GPT) : 1.0;
      expect(saved).toBeCloseTo((b - im) * weight, 6);
    });
  });

  it('OVERCLAIM GUARD: a warm turn never claims more savings than the same turn cold', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      if (b - im < 0) return; // post-gate reality: imaging is only chosen when it saves
      const savedWarm =
        computeOpenAIBaselineInputEff(i, Math.max(1, c), im, b, GPT) -
        computeOpenAIActualInputEff(i, Math.max(1, c), GPT);
      const savedCold =
        computeOpenAIBaselineInputEff(i, 0, im, b, GPT) - computeOpenAIActualInputEff(i, 0, GPT);
      expect(savedWarm).toBeLessThanOrEqual(savedCold + 1e-9);
    });
  });

  it('saved sign is honest: a real win is positive, a (hypothetical) loss is negative — never fabricated', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const saved = computeOpenAIBaselineInputEff(i, c, im, b, GPT) - computeOpenAIActualInputEff(i, c, GPT);
      expect(Math.sign(saved)).toBe(Math.sign(b - im));
      // Ceiling: the cache weight is ≤ 1, so |saved| can never exceed the raw delta.
      expect(Math.abs(saved)).toBeLessThanOrEqual(Math.abs(b - im) + 1e-9);
    });
  });

  it('raw-token counterfactual has MORE tokens than what we sent (when imaging saved)', () => {
    sweep((i, c, im, b) => {
      if (!(i > 0)) return;
      const raw = computeOpenAIBaselineRawTokens(i, im, b);
      expect(raw).toBeGreaterThanOrEqual(0);
      if (b - im >= 0) expect(raw).toBeGreaterThanOrEqual(i);
    });
  });
});

// ===========================================================================
describe('Anthropic savings honesty (cache-create / cache-read aware)', () => {
  const baselines = [0, 1_000, 30_000];
  const cacheables = [0, 5_000, 20_000];
  const inputs = [100, 10_000];
  const ccs = [0, 20_000];
  const crs = [0, 20_000];
  const prevs = [0, 10_000, 25_000];

  const sweep = (
    f: (baseline: number, cacheable: number, input: number, cc: number, cr: number, prev: number) => void,
  ) => {
    for (const baseline of baselines)
      for (const cacheable of cacheables)
        for (const input of inputs)
          for (const cc of ccs) for (const cr of crs) for (const prev of prevs) f(baseline, cacheable, input, cc, cr, prev);
  };

  it('no cache_control markers: baseline priced COLD-UNCACHED (1.0× full body), never collapsed to actual', () => {
    // Rows whose request legitimately carried no cache_control still have a real
    // text counterfactual: the whole baseline at the cold input rate. The old
    // early-return substituted actual_eff here, zeroing legitimate savings.
    // (Probe-MISS rows are excluded upstream by the baselineProbeStatus gate —
    // they never reach this function with a credited baseline.)
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (cacheable > 0) return;
      const cold = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      const warm = computeBaselineInputEff(baseline, cacheable, input, cc, cr, true, prev);
      if (baseline <= 0) {
        expect(cold).toBe(0);
        expect(warm).toBe(0);
      } else {
        expect(cold).toBe(baseline); // cacheable=0 ⇒ whole body is cold tail × 1.0
        expect(warm).toBe(baseline); // nothing to reuse/grow either
      }
    });
  });

  it('OVERCLAIM GUARD: pricing the text counterfactual WARM never claims more than COLD', () => {
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (!(baseline > 0 && cacheable > 0)) return;
      const warm = computeBaselineInputEff(baseline, cacheable, input, cc, cr, true, prev);
      const cold = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      expect(warm).toBeLessThanOrEqual(cold + 1e-9); // warm counterfactual is cheaper → less saved
    });
  });

  it('baseline-eff is non-negative and never exceeds re-creating the whole baseline at 1.25×', () => {
    sweep((baseline, cacheable, input, cc, cr, prev) => {
      if (!(baseline > 0 && cacheable > 0)) return;
      const cold = computeBaselineInputEff(baseline, cacheable, input, cc, cr, false, prev);
      expect(cold).toBeGreaterThanOrEqual(0);
      expect(cold).toBeLessThanOrEqual(baseline * 1.25 + 1e-9); // can't fabricate a bigger counterfactual
    });
  });
});

// ===========================================================================
// 1h cache-create tier: Anthropic bills ttl:'1h' creates at 2×, not 1.25×.
// Pricing them at 1.25× undercharges actual_eff by 0.75×cc1h and inflates
// reported savings by exactly that amount.
describe('1h cache-create tier honesty (2× not 1.25×)', () => {
  it('rate constant matches Anthropic 1h pricing', () => {
    expect(CACHE_CREATE_1H_RATE).toBe(2.0);
  });

  it('synthetic 1h-TTL row: actual_eff rises by (2.0−1.25)×cc1h', () => {
    const cc = 20_000;
    const cc1h = 8_000;
    const without = computeActualInputEff(1_000, cc, 5_000);
    const with1h = computeActualInputEff(1_000, cc, 5_000, cc1h);
    expect(with1h - without).toBeCloseTo((CACHE_CREATE_1H_RATE - CACHE_CREATE_RATE) * cc1h, 6);
  });

  it('cc1h is clamped to [0, cc] — malformed usage cannot corrupt the row', () => {
    expect(computeActualInputEff(0, 100, 0, 500)).toBe(100 * CACHE_CREATE_1H_RATE);
    expect(computeActualInputEff(0, 100, 0, -5)).toBe(100 * CACHE_CREATE_RATE);
    expect(computeActualInputEff(0, 0, 0, 500)).toBe(0);
  });

  it('text counterfactual creates at the observed 5m/1h blend (client TTL policy carries over)', () => {
    // cold, baseline 30k with 20k cacheable + 10k tail
    const all5m = computeBaselineInputEff(30_000, 20_000, 0, 10_000, 0, false, 0, 0);
    const all1h = computeBaselineInputEff(30_000, 20_000, 0, 10_000, 0, false, 0, 10_000);
    const half = computeBaselineInputEff(30_000, 20_000, 0, 10_000, 0, false, 0, 5_000);
    expect(all5m).toBe(20_000 * CACHE_CREATE_RATE + 10_000);
    expect(all1h).toBe(20_000 * CACHE_CREATE_1H_RATE + 10_000);
    expect(half).toBe(20_000 * ((CACHE_CREATE_RATE + CACHE_CREATE_1H_RATE) / 2) + 10_000);
  });

  it('1h rows do not fabricate savings: saving delta vs 5m-only is bounded by the blend on cacheable', () => {
    // Same event priced as 1h must not report MORE saved than as 5m when the
    // actual path created the same tokens the counterfactual creates.
    const cc = 20_000;
    const cc1h = cc;
    const actual5m = computeActualInputEff(1_000, cc, 0);
    const actual1h = computeActualInputEff(1_000, cc, 0, cc1h);
    const base5m = computeBaselineInputEff(30_000, 20_000, 1_000, cc, 0, false, 0);
    const base1h = computeBaselineInputEff(30_000, 20_000, 1_000, cc, 0, false, 0, cc1h);
    expect(base1h - actual1h).toBeCloseTo(base5m - actual5m, 6);
  });
});

// ===========================================================================
// Different models price/tokenize differently — the savings math must use the
// RIGHT per-model figures, or the dashboard silently misprices a family.
describe('per-model pricing is applied correctly (Fable vs Opus vs GPT)', () => {
  it('Anthropic cache multipliers are SHARED policy across Claude models (Fable AND Opus)', () => {
    // 1.25× create / 0.1× read is Anthropic ephemeral-cache POLICY, identical for
    // every Claude model — so the Anthropic baseline math is intentionally model-
    // independent. (Per-model TEXT token counts come from the real count_tokens
    // probe, NOT a static tokenizer — so Fable-vs-Opus tokenizer differences are
    // resolved upstream, not here.)
    expect(CACHE_CREATE_RATE).toBe(1.25);
    expect(CACHE_READ_RATE).toBe(0.1);
  });

  it('GPT cached-read discount is model-GATED: gpt-5.x → 0.1×, others must NOT get it', () => {
    // pxpipe images gpt-5.x only; pricing a non-gpt-5 row at the aggressive 0.1×
    // would overstate its cache savings. The gate keeps families from bleeding
    // each other's rates.
    expect(openAICacheReadRate('gpt-5.6')).toBe(0.1);
    expect(openAICacheReadRate('gpt-5.5')).toBe(0.1);
    expect(openAICacheReadRate('gpt-4o')).not.toBe(0.1);
    expect(openAICacheReadRate(undefined)).not.toBe(0.1);
  });

  it('GPT and Anthropic read rates happen to coincide (0.1×) but are sourced independently', () => {
    // Guard against a refactor that unifies them: they are the same number today
    // for different reasons (GPT cached-input vs Anthropic cache_read). If one
    // provider changes, only its own constant should move.
    expect(openAICacheReadRate('gpt-5.6')).toBe(CACHE_READ_RATE);
  });
});
