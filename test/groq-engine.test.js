/**
 * groq-engine.test.js — the model cascade against a fake fetch:
 *   - fall-through on 429 / 404 / invalid response / truncation / timeout
 *   - retry-after handling and the "wait for a per-minute block" retry
 *   - daily limits are never cleared by the auto-retry
 *
 * Run with:  npm test
 */

import { test, beforeEach, afterEach, mock as nodeMock } from 'node:test';
import assert from 'node:assert/strict';

import { installChromeMock } from './helpers/chrome-mock.js';

const store = installChromeMock();
const sm = await import('../storage-manager.js');
const { scoreWithCascade, CASCADE_MODELS } = await import('../groq-engine.js');

const [M1, M2, M3] = CASCADE_MODELS.map(m => m.id);
const MESSAGES = [{ role: 'user', content: 'hi' }];

/** Queue of per-model responders: model id → array of handlers, consumed in order. */
let plan;
let calls;

function ok(content, finish = 'stop') {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });
}
function fail(status, message, headers = {}) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

beforeEach(async () => {
  store.reset();
  await sm.setApiKey('test-key');
  plan  = {};
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    const next = plan[body.model]?.shift();
    if (!next) throw new Error(`unexpected call to ${body.model}`);
    return next(init);
  };
});

afterEach(() => nodeMock.timers.reset());

/** With faked timers on, advance the clock in `stepMs` steps until `p` settles. */
async function drive(p, stepMs) {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    await new Promise(r => setImmediate(r));
    nodeMock.timers.tick(stepMs);
  }
  return p;
}

test('cascade: first model answers → used directly', async () => {
  plan[M1] = [() => ok('{"a":1}')];
  const r = await scoreWithCascade(MESSAGES);
  assert.equal(r.modelUsed.id, M1);
  assert.equal(r.result, '{"a":1}');
  assert.equal(r.cascadeAttempts, 1);
});

test('cascade: 429 flags the model (with retry-after) and falls through', async () => {
  plan[M1] = [() => fail(429, 'Rate limit reached ... requests per minute (RPM)', { 'retry-after': '12' })];
  plan[M2] = [() => ok('{"ok":true}')];
  const before = Date.now();
  const r = await scoreWithCascade(MESSAGES);
  assert.equal(r.modelUsed.id, M2);
  const limit = await sm.getModelLimit(M1);
  assert.equal(limit.reason, 'RPM');
  assert.ok(limit.expiresAt - before >= 12_000 && limit.expiresAt - before < 13_000);
});

test('cascade: a response failing validate() falls through to the next model', async () => {
  plan[M1] = [() => ok('{"breakdown":{}}')];
  plan[M2] = [() => ok('{"breakdown":{"x":1}}')];
  const validate = (raw) => {
    const p = JSON.parse(raw);
    if (!Object.keys(p.breakdown).length) throw new Error('empty breakdown');
    return p;
  };
  const r = await scoreWithCascade(MESSAGES, { validate });
  assert.equal(r.modelUsed.id, M2);
  assert.deepEqual(r.parsed, { breakdown: { x: 1 } });
});

test('cascade: truncated response is NOT retried on the same model', async () => {
  plan[M1] = [() => ok('{"half":', 'length')];
  plan[M2] = [() => ok('{}')];
  const r = await scoreWithCascade(MESSAGES);
  assert.equal(r.modelUsed.id, M2);
  assert.deepEqual(calls, [M1, M2]);
});

test('cascade: 5xx is retried once on the same model', async () => {
  nodeMock.timers.enable({ apis: ['setTimeout'] });
  plan[M1] = [() => fail(503, 'busy'), () => ok('{}')];
  const r = await drive(scoreWithCascade(MESSAGES), 500);
  assert.equal(r.modelUsed.id, M1);
  assert.deepEqual(calls, [M1, M1]);
});

test('cascade: a hung request times out and falls through', async () => {
  nodeMock.timers.enable({ apis: ['setTimeout'] });
  plan[M1] = [(init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })];
  plan[M2] = [() => ok('{}')];
  const r = await drive(scoreWithCascade(MESSAGES), 5_000);
  assert.equal(r.modelUsed.id, M2);
  assert.deepEqual(calls, [M1, M2], 'timeout is not retried on the same model');
});

test('cascade: invalid key stops immediately', async () => {
  plan[M1] = [() => fail(401, 'bad key')];
  await assert.rejects(scoreWithCascade(MESSAGES), { code: 'INVALID_KEY' });
  assert.deepEqual(calls, [M1]);
});

test('cascade: no API key → NO_API_KEY without calling Groq', async () => {
  await sm.removeApiKey();
  await assert.rejects(scoreWithCascade(MESSAGES), { code: 'NO_API_KEY' });
  assert.deepEqual(calls, []);
});

test('cascade: all daily-limited → fails at once and keeps the daily flags (regression)', async () => {
  for (const id of [M1, M2, M3]) await sm.setModelExhausted(id, 'RPD');
  await assert.rejects(scoreWithCascade(MESSAGES), { code: 'ALL_MODELS_EXHAUSTED' });
  assert.deepEqual(calls, []);
  for (const id of [M1, M2, M3]) assert.equal(await sm.isModelExhausted(id), true, `${id} still blocked`);
});

test('cascade: waits for the soonest per-minute block, then retries', async () => {
  await sm.setModelExhausted(M1, 'RPD');
  await sm.setModelExhausted(M2, 'RPM', 1);   // lapses in ~1s
  await sm.setModelExhausted(M3, 'RPD');
  plan[M2] = [() => ok('{"late":true}')];
  const started = Date.now();
  const r = await scoreWithCascade(MESSAGES);
  assert.equal(r.modelUsed.id, M2);
  assert.ok(Date.now() - started >= 1000, 'waited for the block to lapse');
  assert.equal(await sm.isModelExhausted(M1), true, 'daily flag untouched');
});

test('cascade: per-minute block longer than the wait cap → fails instead of waiting', async () => {
  await sm.setModelExhausted(M1, 'RPM', 120);
  await sm.setModelExhausted(M2, 'RPD');
  await sm.setModelExhausted(M3, 'RPD');
  const started = Date.now();
  await assert.rejects(scoreWithCascade(MESSAGES), { code: 'ALL_MODELS_EXHAUSTED' });
  assert.ok(Date.now() - started < 1000);
});
