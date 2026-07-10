/**
 * groq-engine.js — 3-Model Cascade Engine
 *
 * Cascade order (and why):
 *
 *  1. Llama 4 Scout   — 30 000 TPM, highest throughput  → primary
 *  2. Llama 3.3 70B   — 12 000 TPM, strong reasoning    → first fallback
 *  3. Qwen 3 32B      —  6 000 TPM, independent quota   → final fallback
 *
 * Each model has its OWN 1 000 RPD quota, so the cascade gives you up to
 * 3 000 AI scoring calls per day on the free tier.
 *
 * Rate-limit flags are stored per-model in chrome.storage.local and
 * auto-expire at midnight UTC.
 */

import {
  getApiKey,
  isModelExhausted,
  setModelExhausted,
} from './storage-manager.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const CASCADE_MODELS = Object.freeze([
  {
    id:          'meta-llama/llama-4-scout-17b-16e-instruct',
    name:        'Llama 4 Scout',
    emoji:       '⚡',
    rpm: 30,  rpd: 1000,  tpm: 30_000,
    maxTokens:   2048,
    temperature: 0.3,
  },
  {
    id:          'llama-3.3-70b-versatile',
    name:        'Llama 3.3 70B',
    emoji:       '🧠',
    rpm: 30,  rpd: 1000,  tpm: 12_000,
    maxTokens:   2048,
    temperature: 0.3,
  },
  {
    id:          'qwen/qwen3-32b',
    name:        'Qwen 3 32B',
    emoji:       '🔮',
    rpm: 60,  rpd: 1000,  tpm: 6_000,
    maxTokens:   2048,
    temperature: 0.3,
  },
]);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run messages through the cascade.
 *
 * @param  {Array}  messages  OpenAI-style messages array
 * @return {Object}           { result, modelUsed, cascadeAttempts }
 * @throws {{ code, message, attempts }} when ALL models are exhausted
 */
export async function scoreWithCascade(messages) {
  const apiKey = await getApiKey();
  if (!apiKey) throw Object.assign(new Error('No API key configured.'), { code: 'NO_API_KEY' });

  const attempts = [];

  for (const model of CASCADE_MODELS) {
    /* ---------- skip if already 429'd today ---------- */
    if (await isModelExhausted(model.id)) {
      attempts.push({ model: model.name, status: 'SKIPPED', reason: 'exhausted' });
      continue;
    }

    /* ---------- call Groq ---------- */
    try {
      const result = await _call(model, messages, apiKey);
      return {
        success:         true,
        result,
        modelUsed:       model,
        cascadeAttempts: attempts.length + 1,
      };
    } catch (err) {
      if (err.status === 429) {
        const limitType = err.limitType || 'RPD';
        await setModelExhausted(model.id, limitType);
        attempts.push({ model: model.name, status: 'RATE_LIMITED', reason: limitType });
        continue;                        // ← waterfall to next model
      }
      // Non-rate-limit error — don't swallow it
      throw err;
    }
  }

  /* ---------- all 3 exhausted ---------- */
  const error = new Error(
    'All 3 cascade models have hit their daily limits. ' +
    'Click "Reset Rate Limit Cache" if you\'re starting a new day.',
  );
  error.code     = 'ALL_MODELS_EXHAUSTED';
  error.attempts = attempts;
  throw error;
}

/* ------------------------------------------------------------------ */
/*  Internal fetch wrapper                                            */
/* ------------------------------------------------------------------ */

async function _call(model, messages, apiKey) {
  const body = {
    model:       model.id,
    messages,
    temperature: model.temperature,
    max_tokens:  model.maxTokens,
    response_format: { type: 'json_object' },
  };

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  /* ---- Error branch ---- */
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const msg     = payload?.error?.message || `HTTP ${res.status}`;

    if (res.status === 429) {
      const err       = new Error(msg);
      err.status      = 429;
      err.limitType   = msg.toLowerCase().includes('token') ? 'TPM' : 'RPD';
      err.retryAfter  = res.headers.get('retry-after');
      throw err;
    }

    if (res.status === 401) {
      const err  = new Error('Invalid API key — please check your Groq key.');
      err.code   = 'INVALID_KEY';
      throw err;
    }

    throw new Error(`Groq error ${res.status}: ${msg}`);
  }

  /* ---- Success branch ---- */
  const data    = await res.json();
  let   content = data.choices?.[0]?.message?.content ?? '';

  // Qwen 3 32B sometimes wraps its answer in <think>…</think> tags
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return content;
}
