/**
 * Offline glyph-confusability analyzer — the lever-C ("font is a lever") analog
 * of the opus-density dry-run. NO API KEY NEEDED.
 *
 * Decodes the REAL production font (Spleen 5x8, src/core/atlas.ts) and the AA
 * grayscale atlas (src/core/atlas-gray.ts), simulates the vision encoder's
 * low-pass (a 3x3 box blur on the 5x8 cell — the encoder sees each tiny glyph
 * at ~sub-patch resolution), and ranks glyph pairs by post-blur shape distance.
 *
 * Purpose: cheaply screen WHICH glyphs a legibility-hardened font must fix
 * (lever C3), and whether AA (token-free, lever C1) separates confusables
 * better than the 1-bit atlas. This is a PROXY: pixel distance != VLM confusion.
 * Ground truth still needs the scored run. Its job is to focus that run.
 */
import {
  ATLAS_PIXELS, ATLAS_OFFSETS, ATLAS_WIDE_FLAGS,
  ATLAS_CELL_W, ATLAS_CELL_H, atlasRank,
} from '../../src/core/atlas.js';
import {
  ATLAS_GRAY_PIXELS, ATLAS_GRAY_OFFSETS, ATLAS_GRAY_WIDE_FLAGS,
  ATLAS_GRAY_CELL_W, ATLAS_GRAY_CELL_H, atlasGrayRank,
} from '../../src/core/atlas-gray.js';

// --- decode a glyph to a Float32 [0..1] cell -------------------------------
function decode1bit(cp) {
  const rank = atlasRank(cp);
  if (rank < 0 || ATLAS_WIDE_FLAGS[rank] === 1) return null;
  const w = ATLAS_CELL_W, h = ATLAS_CELL_H, off = ATLAS_OFFSETS[rank];
  const px = new Float32Array(w * h);
  for (let gy = 0; gy < h; gy++)
    for (let gx = 0; gx < w; gx++) {
      const bit = off + gy * w + gx;
      px[gy * w + gx] = (ATLAS_PIXELS[bit >>> 3] >>> (7 - (bit & 7))) & 1;
    }
  return { w, h, px };
}
function decodeGray(cp) {
  const rank = atlasGrayRank(cp);
  if (rank < 0 || ATLAS_GRAY_WIDE_FLAGS[rank] === 1) return null;
  const w = ATLAS_GRAY_CELL_W, h = ATLAS_GRAY_CELL_H, off = ATLAS_GRAY_OFFSETS[rank];
  const px = new Float32Array(w * h);
  for (let gy = 0; gy < h; gy++)
    for (let gx = 0; gx < w; gx++)
      px[gy * w + gx] = ATLAS_GRAY_PIXELS[off + gy * w + gx] / 255;
  return { w, h, px };
}

// --- 3x3 box blur (edge-clamped) = cheap vision-encoder low-pass -----------
function blur({ w, h, px }) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          s += px[yy * w + xx]; n++;
        }
      out[y * w + x] = s / n;
    }
  return out;
}
// cosine distance in [0,2]; 0 = identical shape. Magnitude-independent so
// sparse (`.`) and dense (`M`) glyphs are compared on shape, not ink amount.
function cosDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return 1 - dot / Math.sqrt(na * nb);
}
const disp = (cp) => cp === 0x20 ? "␠" : String.fromCodePoint(cp);

function buildBlurred(decode) {
  const m = new Map();
  for (let cp = 0x21; cp <= 0x7e; cp++) { // printable ASCII (skip space)
    const g = decode(cp);
    if (!g) continue;
    const b = blur(g);
    let ink = 0; for (const v of b) ink += v;
    if (ink < 1e-6) continue;
    m.set(cp, b);
  }
  return m;
}
function allPairs(blurred) {
  const cps = [...blurred.keys()], pairs = [];
  for (let i = 0; i < cps.length; i++)
    for (let j = i + 1; j < cps.length; j++) {
      const d = cosDist(blurred.get(cps[i]), blurred.get(cps[j]));
      if (d != null) pairs.push([cps[i], cps[j], d]);
    }
  pairs.sort((a, b) => a[2] - b[2]);
  return pairs;
}

const oneBit = buildBlurred(decode1bit);
const gray = buildBlurred(decodeGray);
const pairs1 = allPairs(oneBit);
const percentile = (arr, p) => arr[Math.floor((arr.length - 1) * p)][2];
const p10 = percentile(pairs1, 0.10);

console.log(`\n=== FONT-LEVER SCREEN — Spleen 5x8, ${oneBit.size} ASCII glyphs, ${pairs1.length} pairs ===`);
console.log(`(post-blur cosine distance; lower = more confusable. proxy, not ground truth)\n`);

console.log(`--- 24 most-confusable glyph pairs (globally, 1-bit prod atlas) ---`);
for (const [a, b, d] of pairs1.slice(0, 24))
  console.log(`  '${disp(a)}' ~ '${disp(b)}'   dist=${d.toFixed(4)}`);

// classic OCR confusable classes that matter for exact-string recall
const CLASSES = [
  ['0','O'],['0','o'],['0','D'],['0','Q'],['O','o'],['O','Q'],
  ['1','l'],['1','I'],['1','i'],['l','I'],['l','i'],['I','i'],['1','|'],['l','|'],['I','|'],
  ['5','S'],['5','s'],['S','s'],['8','B'],['6','G'],['6','b'],['9','g'],['9','q'],['g','q'],
  ['2','Z'],['2','z'],['Z','z'],['c','e'],['c','o'],['n','h'],['u','v'],['v','y'],
  [':',';'],['.',','],['`',"'"],["'",'"'],['{','('],['(','['],['-','_'],['/','\\'],
];
const distOf = (blurred, a, b) => {
  const x = blurred.get(a.codePointAt(0)), y = blurred.get(b.codePointAt(0));
  return x && y ? cosDist(x, y) : null;
};
console.log(`\n--- classic confusable classes: 1-bit vs AA-gray (RISK = below 10th pct = ${p10.toFixed(4)}) ---`);
let sum1 = 0, sumG = 0, nCmp = 0, risk1 = 0, riskG = 0;
for (const [a, b] of CLASSES) {
  const d1 = distOf(oneBit, a, b), dg = distOf(gray, a, b);
  if (d1 == null) continue;
  const f1 = d1 < p10 ? 'RISK' : 'ok  ';
  const gStr = dg == null ? '  n/a ' : dg.toFixed(4);
  const better = dg != null ? (dg > d1 ? '↑AA-safer' : dg < d1 ? '↓AA-worse' : '=') : '';
  console.log(`  '${a}'~'${b}'  1bit=${d1.toFixed(4)} [${f1}]  aa=${gStr}  ${better}`);
  sum1 += d1; if (dg != null) { sumG += dg; nCmp++; } if (d1 < p10) risk1++;
  if (dg != null && dg < p10) riskG++;
}
console.log(`\n  mean separation  1-bit=${(sum1 / CLASSES.length).toFixed(4)}  AA-gray=${(sumG / nCmp).toFixed(4)}`);
console.log(`  classes flagged RISK  1-bit=${risk1}  AA-gray=${riskG}   (higher separation / fewer RISK = better)`);
console.log(`\nNote: multi-char merges (rn/m, cl/d, vv/w) are invisible to single-glyph`);
console.log(`distance — those remain for the scored run. This screens single glyphs only.\n`);
