/**
 * groq-engine.js — 3-Model Cascade Engine
 *
 * Cascade order:
 *  1. GPT-OSS 120B  → primary (highest quality, strict JSON support)
 *  2. Qwen 3.6 27B  → first fallback (different family = separate rate-limit quota)
 *  3. GPT-OSS 20B   → final fallback (fast, lightweight)
 *
 * Each model ID has its OWN rate-limit quota, so the cascade multiplies the
 * free-tier throughput.
 *
 * Every request pins:
 *   - temperature 0                        → reproducible scores (same prospect → same result)
 *   - response_format {type:'json_object'} → guaranteed syntactically-valid JSON (all Groq models)
 *   - max_completion_tokens 3500           → headroom for the full breakdown JSON + reasoning
 *
 * Rate-limit handling:
 *   - RPM/TPM (per-minute) → model disabled for Groq's retry-after (default 60s)
 *   - RPD/TPD (per-day)    → model disabled until midnight UTC
 *   - Unknown 429          → treated as RPM (60s — safe default)
 *   - If every model is blocked and at least one only per-minute, waits for the
 *     soonest per-minute block to lapse (≤30s) and retries (up to 2×). Daily
 *     blocks are never cleared by the retry.
 *
 * Each request times out after 30s, and a response that fails the caller's
 * `validate` check falls through to the next model like any other failure.
 *
 * Model IDs verified against Groq's live catalog on 2026-07-23. The previous
 * cascade (llama-3.3-70b-versatile + llama-3.1-8b-instant) is scheduled for
 * shutdown on 2026-08-16; Groq's own recommended replacements are the GPT-OSS
 * models used below, so this cascade survives that deprecation.
 */

import {
  getApiKey,
  getModelLimit,
  setModelExhausted,
} from './storage-manager.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_MS  = 30_000;   // longest we'll wait for a per-minute block to lapse
const PER_MINUTE_LIMITS  = new Set(['RPM', 'TPM']);

export const CASCADE_MODELS = Object.freeze([
  {
    id:              'openai/gpt-oss-120b',   // Groq's recommended replacement for llama-3.3-70b
    name:            'GPT-OSS 120B',
    emoji:           '⚡',
    maxTokens:       3500,
    temperature:     0,
    reasoningEffort: 'low',                   // keep latency + token use down; JSON output unaffected
  },
  {
    id:          'qwen/qwen3.6-27b',          // separate model family → independent rate-limit quota
    name:        'Qwen 3.6 27B',
    emoji:       '🧠',
    maxTokens:   3500,
    temperature: 0,
  },
  {
    id:              'openai/gpt-oss-20b',    // Groq's recommended replacement for llama-3.1-8b
    name:            'GPT-OSS 20B',
    emoji:           '🔮',
    maxTokens:       3500,
    temperature:     0,
    reasoningEffort: 'low',
  },
]);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run messages through the cascade.
 *
 * @param  {Array}    messages            OpenAI-style messages array
 * @param  {Object}   [opts]
 * @param  {Function} [opts.validate]     (content) => parsed; throw to reject the
 *                                        response and try the next model
 * @return {Object}   { result, parsed, modelUsed, cascadeAttempts }
 * @throws {{ code, message, attempts }} when ALL models are exhausted
 */
export async function scoreWithCascade(messages, { validate } = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw Object.assign(new Error('No API key configured.'), { code: 'NO_API_KEY' });
  }

  const MAX_WAIT_ROUNDS = 2;

  for (let round = 0; round <= MAX_WAIT_ROUNDS; round++) {
    const attempts = [];

    for (const model of CASCADE_MODELS) {
      /* ---------- skip if already rate-limited ---------- */
      const limit = await getModelLimit(model.id);
      if (limit) {
        attempts.push({ model: model.name, status: 'SKIPPED', reason: limit.reason, expiresAt: limit.expiresAt });
        continue;
      }

      /* ---------- call Groq ---------- */
      try {
        const result = await _callWithRetry(model, messages, apiKey);
        let parsed;
        try {
          parsed = validate ? validate(result) : undefined;
        } catch (e) {
          throw Object.assign(new Error(`Invalid response: ${e.message}`), { code: 'INVALID_RESPONSE' });
        }
        return {
          success:         true,
          result,
          parsed,
          modelUsed:       model,
          cascadeAttempts: attempts.length + 1,
        };
      } catch (err) {
        if (err.status === 429) {
          const limitType = _detectLimitType(err.message);
          console.warn(`[groq-engine] ${model.name} hit ${limitType} rate limit.`);
          await setModelExhausted(model.id, limitType, err.retryAfter);
          const entry = await getModelLimit(model.id);
          attempts.push({ model: model.name, status: 'RATE_LIMITED', reason: limitType, expiresAt: entry?.expiresAt });
          continue;
        }

        if (err.status === 404) {
          console.warn(`[groq-engine] Model ${model.id} not found (404), skipping.`);
          attempts.push({ model: model.name, status: 'NOT_FOUND', reason: '404' });
          continue;
        }

        if (err.status === 400) {
          console.warn(`[groq-engine] Model ${model.id} returned 400, skipping.`);
          attempts.push({ model: model.name, status: 'BAD_REQUEST', reason: err.message });
          continue;
        }

        if (err.code === 'INVALID_KEY') throw err;

        console.warn(`[groq-engine] Model ${model.id} error: ${err.message}`);
        attempts.push({ model: model.name, status: err.code || 'ERROR', reason: err.message });
        continue;
      }
    }

    /* ---------- all failed — wait out a per-minute block if one is close ---------- */
    const allLimited = attempts.every(a => a.status === 'SKIPPED' || a.status === 'RATE_LIMITED');
    const soonest = Math.min(
      ...attempts
        .filter(a => PER_MINUTE_LIMITS.has(a.reason) && a.expiresAt)
        .map(a => a.expiresAt),
    );
    const waitMs = soonest - Date.now() + 250;

    if (allLimited && Number.isFinite(soonest) && waitMs <= MAX_RETRY_WAIT_MS && round < MAX_WAIT_ROUNDS) {
      const delay = Math.max(waitMs, 0);
      console.log(`[groq-engine] All models rate-limited. Retrying in ${Math.ceil(delay / 1000)}s (round ${round + 2}/${MAX_WAIT_ROUNDS + 1})…`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    /* ---------- permanent failure ---------- */
    const reasons = attempts.map(a => `${a.model}: ${a.status} (${a.reason})`).join(' ');
    const error = new Error(
      `All ${CASCADE_MODELS.length} cascade models failed. ${reasons} Try "Reset Rate Limit Cache" or wait and retry.`,
    );
    error.code     = 'ALL_MODELS_EXHAUSTED';
    error.attempts = attempts;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Rate limit type detection                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse Groq's 429 error message to determine the limit type.
 * Defaults to RPM (short-lived) to avoid disabling models for a whole day.
 */
function _detectLimitType(msg = '') {
  const lower = msg.toLowerCase();
  if (lower.includes('(rpm)') || lower.includes('requests per minute'))  return 'RPM';
  if (lower.includes('(tpm)') || lower.includes('tokens per minute'))    return 'TPM';
  if (lower.includes('(rpd)') || lower.includes('requests per day'))     return 'RPD';
  if (lower.includes('(tpd)') || lower.includes('tokens per day'))       return 'TPD';
  return 'RPM'; // safe default — 60s cooldown, not midnight
}

/* ------------------------------------------------------------------ */
/*  Internal fetch wrapper                                            */
/* ------------------------------------------------------------------ */

async function _callWithRetry(model, messages, apiKey, maxRetries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await _call(model, messages, apiKey);
    } catch (err) {
      lastError = err;
      // Network blips and 5xx are worth one more try on the same model. A
      // timeout, truncation or empty completion would just repeat at
      // temperature 0, so those go straight to the next model.
      const isTransient = !err.code && (err.status >= 500 || err.message?.includes('fetch'));
      if (!isTransient || attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000));
      console.log(`[groq-engine] Retrying ${model.name} (attempt ${attempt + 2})…`);
    }
  }
  throw lastError;
}

async function _call(model, messages, apiKey) {
  // The timeout covers the whole exchange, including reading the body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await _request(model, messages, apiKey, controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`), { code: 'TIMEOUT' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function _request(model, messages, apiKey, signal) {
  const body = {
    model:                 model.id,
    messages,
    temperature:           model.temperature,
    max_completion_tokens: model.maxTokens,
    // JSON Object Mode is supported on all Groq models and guarantees the
    // response is syntactically valid JSON. The prompt already contains the
    // literal word "JSON", which Groq requires when this flag is set.
    response_format:       { type: 'json_object' },
  };

  // Reasoning models (GPT-OSS) accept a reasoning_effort knob; keep it low so
  // reasoning tokens don't eat the completion budget or slow scoring down.
  if (model.reasoningEffort) body.reasoning_effort = model.reasoningEffort;

  console.log(`[groq-engine] → ${model.id}`);

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const msg     = payload?.error?.message || `HTTP ${res.status}`;
    console.warn(`[groq-engine] ← ${model.id} ${res.status}: ${msg}`);

    if (res.status === 429) {
      const err      = new Error(msg);
      err.status     = 429;
      err.retryAfter = parseFloat(res.headers.get('retry-after')) || null;
      throw err;
    }

    if (res.status === 401) {
      const err = new Error('Invalid API key — check your Groq key.');
      err.code  = 'INVALID_KEY';
      throw err;
    }

    const err = new Error(`Groq ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }

  const data    = await res.json();
  const choice  = data.choices?.[0];
  let   content = choice?.message?.content ?? '';

  // Strip Qwen <think> blocks and markdown fences
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Truncation → the JSON is almost certainly incomplete/invalid. Fall through
  // to the next model rather than surfacing a misleading JSON.parse error.
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('Response truncated (hit max_completion_tokens).'), { code: 'TRUNCATED' });
  }

  // An empty completion (e.g. reasoning consumed the whole budget) likewise
  // falls through to the next model.
  if (!content) {
    throw Object.assign(new Error('Empty completion from model.'), { code: 'EMPTY' });
  }

  return content;
}
