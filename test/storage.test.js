/**
 * storage.test.js — storage-manager.js against an in-memory chrome.storage:
 *   - region auto-switch (whole-word matching)
 *   - URL normalization (Sales Navigator search context)
 *   - score cache (versioning, concurrent writes, LRU cap)
 *   - rate-limit flags (TTL, retry-after, daily expiry)
 *
 * Run with:  npm test
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeMock } from './helpers/chrome-mock.js';

const mock = installChromeMock();
const sm = await import('../storage-manager.js');

beforeEach(() => mock.reset());

/* ------------------------------------------------------------------ */
/*  matchesRegion                                                     */
/* ------------------------------------------------------------------ */

const NA = ['United States', 'USA', 'US', 'Canada', 'California', 'Washington', 'San Francisco'];

test('matchesRegion: "US" no longer matches inside other words', () => {
  for (const loc of ['Sydney, New South Wales, Australia', 'Moscow, Russia', 'Brussels, Belgium',
                     'Nicosia, Cyprus', 'Columbus, Ohio', 'Mauritius']) {
    assert.equal(sm.matchesRegion(loc, NA), false, loc);
  }
});

test('matchesRegion: real North America locations still match', () => {
  for (const loc of ['San Francisco Bay Area', 'Austin, Texas, United States', 'Toronto, Ontario, Canada',
                     'Seattle, Washington, US', 'Los Angeles, California', 'New York, NY, USA']) {
    assert.equal(sm.matchesRegion(loc, NA), true, loc);
  }
});

test('matchesRegion: "India" does not match "Indiana"; case-insensitive', () => {
  assert.equal(sm.matchesRegion('Indianapolis, Indiana, United States', ['India']), false);
  assert.equal(sm.matchesRegion('Pune, Maharashtra, INDIA', ['India']), true);
});

test('matchesRegion: regex characters in keywords are treated literally', () => {
  assert.equal(sm.matchesRegion('Remote (EU)', ['(EU)']), true);
  assert.equal(sm.matchesRegion('Remote EU', ['E.U']), false);
});

test('matchesRegion: empty inputs never match', () => {
  assert.equal(sm.matchesRegion('', NA), false);
  assert.equal(sm.matchesRegion('Berlin', []), false);
  assert.equal(sm.matchesRegion('Berlin', ['  ']), false);
});

test('resolveIcpProfile: Australia falls back to the default, not North America', async () => {
  await sm.initializeIcpProfiles();
  const r = await sm.resolveIcpProfile('Sydney, New South Wales, Australia');
  assert.equal(r.reason, 'default');
  assert.equal(r.profile.id, 'global-default');
});

test('resolveIcpProfile: Tbilisi, Georgia (country) is not routed to North America', async () => {
  await sm.initializeIcpProfiles();
  const r = await sm.resolveIcpProfile('Tbilisi, Georgia');
  assert.equal(r.profile.id, 'global-default');
  const us = await sm.resolveIcpProfile('Atlanta, Georgia, United States');
  assert.equal(us.profile.id, 'north-america');
});

test('resolveIcpProfile: manual mode ignores location', async () => {
  await sm.initializeIcpProfiles();
  await sm.setIcpAutoSwitch(false);
  await sm.setActiveIcpId('apac');
  const r = await sm.resolveIcpProfile('Austin, Texas, United States');
  assert.equal(r.reason, 'manual');
  assert.equal(r.profile.id, 'apac');
});

/* ------------------------------------------------------------------ */
/*  normalizeUrl                                                      */
/* ------------------------------------------------------------------ */

test('normalizeUrl: strips query, hash and trailing slash', () => {
  assert.equal(sm.normalizeUrl('https://www.linkedin.com/in/jane-doe/?trk=x#about'),
               'https://www.linkedin.com/in/jane-doe');
});

test('normalizeUrl: Sales Nav lead URLs from different searches share one key', () => {
  const a = sm.normalizeUrl('https://www.linkedin.com/sales/lead/ACwAAA123,NAME_SEARCH,abcd?_ntb=1');
  const b = sm.normalizeUrl('https://www.linkedin.com/sales/lead/ACwAAA123,NAME_SEARCH,zzzz');
  const c = sm.normalizeUrl('https://www.linkedin.com/sales/lead/ACwAAA123');
  assert.equal(a, c);
  assert.equal(b, c);
});

test('normalizeUrl: commas outside /sales/ are left alone', () => {
  assert.equal(sm.normalizeUrl('https://www.linkedin.com/in/a,b'), 'https://www.linkedin.com/in/a,b');
});

/* ------------------------------------------------------------------ */
/*  Score cache                                                       */
/* ------------------------------------------------------------------ */

test('cache: round-trips a result under the normalized URL', async () => {
  await sm.cacheScore('https://www.linkedin.com/in/jane/?x=1', { overallScore: 70 });
  const hit = await sm.getCachedScore('https://www.linkedin.com/in/jane');
  assert.equal(hit.result.overallScore, 70);
});

test('cache: overlapping writes are not lost (regression: read-modify-write race)', async () => {
  const urls = Array.from({ length: 10 }, (_, i) => `https://www.linkedin.com/in/p${i}`);
  await Promise.all(urls.map((u, i) => sm.cacheScore(u, { overallScore: i })));
  for (const [i, u] of urls.entries()) {
    const hit = await sm.getCachedScore(u);
    assert.ok(hit, `missing ${u}`);
    assert.equal(hit.result.overallScore, i);
  }
});

test('cache: entries from an older scoring version are dropped', async () => {
  mock.store.score_cache = {
    'https://www.linkedin.com/in/old': { result: { overallScore: 1 }, timestamp: 1, version: 1 },
  };
  assert.equal(await sm.getCachedScore('https://www.linkedin.com/in/old'), null);
  assert.deepEqual(mock.store.score_cache, {});
});

test('cache: evicts the oldest entries beyond the 500 cap', async () => {
  const current = await (async () => {
    await sm.cacheScore('https://www.linkedin.com/in/probe', {});
    return mock.store.score_cache['https://www.linkedin.com/in/probe'].version;
  })();
  const seeded = {};
  for (let i = 0; i < 500; i++) {
    seeded[`https://www.linkedin.com/in/s${i}`] = { result: {}, timestamp: 1000 + i, version: current };
  }
  mock.store.score_cache = seeded;
  await sm.cacheScore('https://www.linkedin.com/in/newest', {});
  const keys = Object.keys(mock.store.score_cache);
  assert.equal(keys.length, 500);
  assert.ok(!keys.includes('https://www.linkedin.com/in/s0'), 'oldest evicted');
  assert.ok(keys.includes('https://www.linkedin.com/in/newest'));
});

/* ------------------------------------------------------------------ */
/*  Rate limits                                                       */
/* ------------------------------------------------------------------ */

test('rate limits: RPM flag uses retry-after when given, 60s otherwise', async () => {
  const before = Date.now();
  await sm.setModelExhausted('m1', 'RPM', 7);
  await sm.setModelExhausted('m2', 'TPM');
  const l1 = await sm.getModelLimit('m1');
  const l2 = await sm.getModelLimit('m2');
  assert.ok(l1.expiresAt - before >= 7000 && l1.expiresAt - before < 8000);
  assert.ok(l2.expiresAt - before >= 60_000 && l2.expiresAt - before < 61_000);
});

test('rate limits: daily flag has no TTL and lapses on a new UTC day', async () => {
  await sm.setModelExhausted('m1', 'RPD', 5);
  const entry = await sm.getModelLimit('m1');
  assert.equal(entry.expiresAt, null);
  mock.store.rate_limits.m1.exhaustedDate = '2000-01-01';
  assert.equal(await sm.isModelExhausted('m1'), false);
  assert.equal(mock.store.rate_limits.m1, undefined, 'expired flag pruned');
});

test('rate limits: expired TTL flags are pruned and health agrees', async () => {
  await sm.setModelExhausted('m1', 'RPM');
  await sm.setModelExhausted('m2', 'RPD');
  mock.store.rate_limits.m1.expiresAt = Date.now() - 1;
  const health = await sm.getCascadeHealth();
  assert.deepEqual(Object.keys(health), ['m2']);
  assert.equal(await sm.isModelExhausted('m1'), false);
  assert.equal(await sm.isModelExhausted('m2'), true);
});

test('rate limits: concurrent flags on different models are all kept', async () => {
  await Promise.all(['a', 'b', 'c', 'd'].map(id => sm.setModelExhausted(id, 'RPM')));
  assert.deepEqual(Object.keys(mock.store.rate_limits).sort(), ['a', 'b', 'c', 'd']);
});
