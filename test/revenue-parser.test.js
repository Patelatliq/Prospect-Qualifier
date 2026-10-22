/**
 * revenue-parser.test.js — what the scraper is allowed to call "revenue".
 *
 * A wrong revenue figure is passed to the model as fact and lifts the revenue
 * confidence cap, so false positives matter more than misses here.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../revenue-parser.js';

const { extractRevenue, isRevenueLabel, isRevenueValue } = globalThis.LQRevenue;

test('extractRevenue: labelled figures and ranges', () => {
  assert.equal(extractRevenue('Revenue: $1M - $7.5M+'), '$1M - $7.5M+');
  assert.equal(extractRevenue('Annual revenue\n$5M to $10M'), '$5M to $10M');
  assert.equal(extractRevenue('Revenue range $10M–$50M'), '$10M–$50M');
  assert.equal(extractRevenue('$1M - $7.5M+ revenue'), '$1M - $7.5M+');
  assert.equal(extractRevenue('$20M in annual revenue'), '$20M');
  assert.equal(extractRevenue('We passed $5 million revenue this year'), '$5 million');
});

test('extractRevenue: job titles and team names are not revenue (regression)', () => {
  assert.equal(extractRevenue('Chief Revenue Officer | Raised $10M Series A'), '');
  assert.equal(extractRevenue('Head of Revenue $5M'), '');
  assert.equal(extractRevenue('VP, Revenue $3M'), '');
  assert.equal(extractRevenue('Revenue Operations lead, comp $150K - $200K'), '');
  assert.equal(extractRevenue('Revenue Team Lead — closed $2M ARR'), '');
});

test('extractRevenue: unlabelled amounts (salary, funding, prices) are ignored (regression)', () => {
  assert.equal(extractRevenue('Salary $120K - $150K'), '');
  assert.equal(extractRevenue('Raised $25M Series B led by Acme Ventures'), '');
  assert.equal(extractRevenue('Plans from $5 to $50 per seat'), '');
});

test('extractRevenue: empty input', () => {
  assert.equal(extractRevenue(''), '');
  assert.equal(extractRevenue(null), '');
});

test('isRevenueLabel: only a bare revenue label qualifies', () => {
  assert.equal(isRevenueLabel('Revenue'), true);
  assert.equal(isRevenueLabel(' Annual revenue: '), true);
  assert.equal(isRevenueLabel('Revenue range'), true);
  assert.equal(isRevenueLabel('Chief Revenue Officer'), false);
  assert.equal(isRevenueLabel('Revenue Operations'), false);
});

test('isRevenueValue: a short dollar amount or range only', () => {
  assert.equal(isRevenueValue('$1M - $7.5M+'), true);
  assert.equal(isRevenueValue('Under $1M'), true);
  assert.equal(isRevenueValue('$500M+'), true);
  assert.equal(isRevenueValue('Head of Revenue Operations'), false);
  assert.equal(isRevenueValue('Grew revenue from $1M to $5M in two years at a fast pace'), false);
  assert.equal(isRevenueValue(''), false);
});
