/**
 * scoring.test.js — unit tests for the deterministic scoring layer.
 *
 * Run with:  node --test        (or: npm test)
 *
 * These cover the pure, reproducible parts of the pipeline — the arithmetic and
 * parsing that turn a model response into the headline score. The Groq call and
 * DOM scraping are intentionally out of scope (they need a browser + network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWeightedScore,
  deriveTier,
  parseResponse,
  clamp,
  formatMoney,
} from '../icp-scorer.js';

const DEFAULT_WEIGHTS = {
  titleFit: 20, companySize: 15, industry: 15,
  techSignals: 15, aiFit: 10, companyRevenue: 25,
};

/** Build a full breakdown object from a {category: score} map. */
function bd(scores) {
  const out = {};
  for (const [k, v] of Object.entries(scores)) out[k] = { score: v, reason: '', confidence: 'HIGH' };
  return out;
}

/* ------------------------------------------------------------------ */
/*  computeWeightedScore                                              */
/* ------------------------------------------------------------------ */

test('computeWeightedScore: all-100 categories → 100', () => {
  const breakdown = bd({
    titleFit: 100, companySize: 100, industry: 100,
    techSignals: 100, aiFit: 100, companyRevenue: 100,
  });
  assert.equal(computeWeightedScore(breakdown, DEFAULT_WEIGHTS), 100);
});

test('computeWeightedScore: known weighted mix rounds correctly', () => {
  // 90*20 + 80*15 + 70*15 + 60*15 + 50*10 + 40*25 = 6450 → /100 = 64.5 → 65
  const breakdown = bd({
    titleFit: 90, companySize: 80, industry: 70,
    techSignals: 60, aiFit: 50, companyRevenue: 40,
  });
  assert.equal(computeWeightedScore(breakdown, DEFAULT_WEIGHTS), 65);
});

test('computeWeightedScore: missing category defaults to neutral 50', () => {
  // Only titleFit present (100); remaining 80% of weight → 50.
  // 100*20 + 50*80 = 6000 → /100 = 60
  const breakdown = bd({ titleFit: 100 });
  assert.equal(computeWeightedScore(breakdown, DEFAULT_WEIGHTS), 60);
});

test('computeWeightedScore: weights are normalized by their own sum', () => {
  // Weights sum to 2, not 100 — result must still be a proper weighted average.
  // (80*1 + 40*1) / 2 = 60
  const breakdown = bd({ titleFit: 80, companySize: 40 });
  const weights = { titleFit: 1, companySize: 1 };
  assert.equal(computeWeightedScore(breakdown, weights), 60);
});

test('computeWeightedScore: zero-weight category is ignored even if scored', () => {
  const breakdown = bd({ titleFit: 100, companySize: 0 });
  const weights = { titleFit: 30, companySize: 0 };
  assert.equal(computeWeightedScore(breakdown, weights), 100);
});

test('computeWeightedScore: no positive weights → 0', () => {
  const breakdown = bd({ titleFit: 90 });
  assert.equal(computeWeightedScore(breakdown, { titleFit: 0 }), 0);
});

test('computeWeightedScore: falls back to default weights when none provided', () => {
  const breakdown = bd({
    titleFit: 70, companySize: 70, industry: 70,
    techSignals: 70, aiFit: 70, companyRevenue: 70,
  });
  assert.equal(computeWeightedScore(breakdown, undefined), 70);
});

test('computeWeightedScore: out-of-range category scores are clamped first', () => {
  // 150 clamps to 100 across the board → 100
  const breakdown = bd({
    titleFit: 150, companySize: 150, industry: 150,
    techSignals: 150, aiFit: 150, companyRevenue: 150,
  });
  assert.equal(computeWeightedScore(breakdown, DEFAULT_WEIGHTS), 100);
});

/* ------------------------------------------------------------------ */
/*  deriveTier                                                        */
/* ------------------------------------------------------------------ */

test('deriveTier: default thresholds (80/50)', () => {
  assert.equal(deriveTier(85), 'HOT');
  assert.equal(deriveTier(80), 'HOT');   // boundary inclusive
  assert.equal(deriveTier(79), 'WARM');
  assert.equal(deriveTier(50), 'WARM');  // boundary inclusive
  assert.equal(deriveTier(49), 'COLD');
  assert.equal(deriveTier(0),  'COLD');
});

test('deriveTier: custom thresholds (75/45)', () => {
  const t = { hot: 75, warm: 45 };
  assert.equal(deriveTier(75, t), 'HOT');
  assert.equal(deriveTier(74, t), 'WARM');
  assert.equal(deriveTier(45, t), 'WARM');
  assert.equal(deriveTier(44, t), 'COLD');
});

test('deriveTier: null/partial thresholds fall back to defaults', () => {
  assert.equal(deriveTier(80, null), 'HOT');
  assert.equal(deriveTier(60, {}), 'WARM');
});

/* ------------------------------------------------------------------ */
/*  parseResponse                                                     */
/* ------------------------------------------------------------------ */

const MINIMAL = JSON.stringify({
  overallScore: 42,
  tier: 'WARM',
  breakdown: { titleFit: { score: 90 } },
});

test('parseResponse: plain JSON', () => {
  const r = parseResponse(MINIMAL);
  assert.equal(r.breakdown.titleFit.score, 90);
});

test('parseResponse: strips ```json fences', () => {
  const r = parseResponse('```json\n' + MINIMAL + '\n```');
  assert.equal(r.overallScore, 42);
});

test('parseResponse: strips <think> reasoning blocks', () => {
  const r = parseResponse('<think>let me reason about this</think>' + MINIMAL);
  assert.equal(r.tier, 'WARM');
});

test('parseResponse: clamps category scores into 0-100', () => {
  const raw = JSON.stringify({ breakdown: { titleFit: { score: 150 }, aiFit: { score: -20 } } });
  const r = parseResponse(raw);
  assert.equal(r.breakdown.titleFit.score, 100);
  assert.equal(r.breakdown.aiFit.score, 0);
});

test('parseResponse: overallScore is optional (recomputed downstream)', () => {
  const raw = JSON.stringify({ breakdown: { titleFit: { score: 60 } } });
  assert.doesNotThrow(() => parseResponse(raw));
});

test('parseResponse: throws when breakdown is missing', () => {
  assert.throws(() => parseResponse(JSON.stringify({ overallScore: 50, tier: 'WARM' })));
});

/* ------------------------------------------------------------------ */
/*  clamp + formatMoney                                               */
/* ------------------------------------------------------------------ */

test('clamp: bounds and rounding', () => {
  assert.equal(clamp(150), 100);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(64.5), 65);
  assert.equal(clamp(64.4), 64);
});

test('formatMoney: human-readable currency', () => {
  assert.equal(formatMoney(2_500_000), '$2.5M');
  assert.equal(formatMoney(2_000_000), '$2M');
  assert.equal(formatMoney(500_000), '$500K');
  assert.equal(formatMoney(10_000_000), '$10M');
  assert.equal(formatMoney(1_000_000_000), '$1B');
});

/* ------------------------------------------------------------------ */
/*  computeWeightedScore — confidence weighting (low-data-aware)       */
/* ------------------------------------------------------------------ */

/** breakdown from {category: [score, confidence]} */
const bdc = (m) => {
  const o = {};
  for (const [k, [score, confidence]] of Object.entries(m)) o[k] = { score, confidence };
  return o;
};

test('confidence-weighting: strong title + all-else-unknown rises above the flat mean', () => {
  // Only title is HIGH-confidence; unknowns (LOW) are down-weighted ×0.25.
  // (95*20 + 48*20)/40 = 2860/40 = 71.5 -> 72   (vs. flat mean 57)
  const b = bdc({
    titleFit: [95, 'HIGH'], companySize: [48, 'LOW'], industry: [48, 'LOW'],
    techSignals: [48, 'LOW'], aiFit: [48, 'LOW'], companyRevenue: [48, 'LOW'],
  });
  assert.equal(computeWeightedScore(b, DEFAULT_WEIGHTS), 72);
});

test('confidence-weighting: same scores all-HIGH give the flat weighted mean', () => {
  const b = bdc({
    titleFit: [95, 'HIGH'], companySize: [48, 'HIGH'], industry: [48, 'HIGH'],
    techSignals: [48, 'HIGH'], aiFit: [48, 'HIGH'], companyRevenue: [48, 'HIGH'],
  });
  assert.equal(computeWeightedScore(b, DEFAULT_WEIGHTS), 57);
});

test('confidence-weighting: weak title + unknowns sinks (list-view spread)', () => {
  // (35*20 + 48*20)/40 = 1660/40 = 41.5 -> 42
  const b = bdc({
    titleFit: [35, 'HIGH'], companySize: [48, 'LOW'], industry: [48, 'LOW'],
    techSignals: [48, 'LOW'], aiFit: [48, 'LOW'], companyRevenue: [48, 'LOW'],
  });
  assert.equal(computeWeightedScore(b, DEFAULT_WEIGHTS), 42);
});

test('confidence-weighting: missing confidence = full weight (backcompat with plain mean)', () => {
  const withHigh = bdc({ titleFit: [80, 'HIGH'], companySize: [40, 'HIGH'] });
  const noConf   = { titleFit: { score: 80 }, companySize: { score: 40 } };
  const w = { titleFit: 50, companySize: 50 };
  assert.equal(computeWeightedScore(noConf, w), computeWeightedScore(withHigh, w));
  assert.equal(computeWeightedScore(noConf, w), 60);
});
