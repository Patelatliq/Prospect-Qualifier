/**
 * StorageManager — chrome.storage.local abstraction
 *
 * Manages:
 *  - Groq API key
 *  - Per-model rate-limit exhaustion flags (auto-expire on new UTC day)
 *  - Cascade health snapshot
 *  - Score cache (keyed by profile URL)
 *  - ICP profiles (multiple, with auto-switch by region)
 */

const KEYS = {
  API_KEY:         'groq_api_key',
  RATE_LIMITS:     'rate_limits',
  SCORE_CACHE:     'score_cache',
  ICP_PROFILES:    'icp_profiles',
  ACTIVE_ICP_ID:   'active_icp_id',
  ICP_AUTO_SWITCH: 'icp_auto_switch',
};

/** Return today's date string in UTC (YYYY-MM-DD) */
function utcToday() {
  return new Date().toISOString().split('T')[0];
}

/* ------------------------------------------------------------------ */
/*  API Key                                                           */
/* ------------------------------------------------------------------ */

export async function getApiKey() {
  const result = await chrome.storage.local.get(KEYS.API_KEY);
  return result[KEYS.API_KEY] || null;
}

export async function setApiKey(key) {
  await chrome.storage.local.set({ [KEYS.API_KEY]: key.trim() });
}

export async function removeApiKey() {
  await chrome.storage.local.remove(KEYS.API_KEY);
}

/* ------------------------------------------------------------------ */
/*  Rate-limit flags                                                  */
/* ------------------------------------------------------------------ */

async function _getLimits() {
  const result = await chrome.storage.local.get(KEYS.RATE_LIMITS);
  return result[KEYS.RATE_LIMITS] || {};
}

async function _setLimits(limits) {
  await chrome.storage.local.set({ [KEYS.RATE_LIMITS]: limits });
}

/**
 * Mark a model as exhausted for today.
 * @param {string} modelId   e.g. "meta-llama/llama-4-scout-17b-16e-instruct"
 * @param {string} reason    "RPD" | "RPM" | "TPM"
 */
export async function setModelExhausted(modelId, reason = 'RPD') {
  const limits = await _getLimits();
  limits[modelId] = {
    exhausted:     true,
    exhaustedAt:   Date.now(),
    exhaustedDate: utcToday(),
    reason,
  };
  await _setLimits(limits);
}

/**
 * Check whether a model is currently marked as exhausted.
 * Automatically clears stale flags from previous UTC days.
 */
export async function isModelExhausted(modelId) {
  const limits = await _getLimits();
  const entry  = limits[modelId];
  if (!entry?.exhausted) return false;

  // Auto-reset if the flag is from a previous day
  if (entry.exhaustedDate !== utcToday()) {
    delete limits[modelId];
    await _setLimits(limits);
    return false;
  }
  return true;
}

/**
 * Manually clear **all** rate-limit flags.
 * Wired to the "Reset Rate Limit Cache" button.
 */
export async function clearAllRateLimits() {
  await _setLimits({});
}

/**
 * Returns a { modelId → status } map for every flagged model.
 * Only includes models flagged *today* (stale entries are pruned).
 */
export async function getCascadeHealth() {
  const limits = await _getLimits();
  const today  = utcToday();
  const health = {};
  let   dirty  = false;

  for (const [id, entry] of Object.entries(limits)) {
    if (entry.exhausted && entry.exhaustedDate === today) {
      health[id] = { exhausted: true, reason: entry.reason };
    } else if (entry.exhausted) {
      // Stale — clean up
      delete limits[id];
      dirty = true;
    }
  }

  if (dirty) await _setLimits(limits);
  return health;
}

/* ------------------------------------------------------------------ */
/*  Score cache                                                       */
/* ------------------------------------------------------------------ */

/** Normalize a LinkedIn URL so the same profile always matches. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip query, hash, trailing slashes
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return url;
  }
}

async function _getCache() {
  const result = await chrome.storage.local.get(KEYS.SCORE_CACHE);
  return result[KEYS.SCORE_CACHE] || {};
}

async function _setCache(cache) {
  await chrome.storage.local.set({ [KEYS.SCORE_CACHE]: cache });
}

/**
 * Scoring version — bump this whenever the scoring prompt or logic changes.
 * Old cached scores with a different version are automatically invalidated.
 */
const SCORING_VERSION = 4;

/**
 * Cache a score result for a URL.
 * @param {string} url     The profile URL
 * @param {Object} result  The full scoring result
 */
export async function cacheScore(url, result) {
  const cache = await _getCache();
  const key = normalizeUrl(url);
  cache[key] = {
    result,
    timestamp: Date.now(),
    version: SCORING_VERSION,
  };
  await _setCache(cache);
}

/**
 * Retrieve a cached score for a URL.
 * Returns null if the cached score is from an older version (stale).
 * @param  {string}      url  The profile URL
 * @return {Object|null}      { result, timestamp } or null
 */
export async function getCachedScore(url) {
  const cache = await _getCache();
  const key = normalizeUrl(url);
  const entry = cache[key];

  if (!entry) return null;

  // Invalidate stale cache from older scoring versions
  if (entry.version !== SCORING_VERSION) {
    delete cache[key];
    await _setCache(cache);
    return null;
  }

  return entry;
}

/**
 * Clear all cached scores.
 */
export async function clearScoreCache() {
  await _setCache({});
}

/* ------------------------------------------------------------------ */
/*  ICP Profiles                                                      */
/* ------------------------------------------------------------------ */

/**
 * 3 built-in ICP presets. Users can modify these and create more.
 */
function getDefaultProfiles() {
  return [
    {
      id:        'global-default',
      name:      '🌐 Global Default',
      isDefault: true,
      regions:   [],  // matches everything when no other profile matches
      weights: {
        titleFit:       20,
        companySize:    15,
        industry:       15,
        techSignals:    15,
        aiFit:          10,
        companyRevenue: 25,
      },
      revenueThreshold: 2_500_000,
      tierThresholds:   { hot: 80, warm: 50 },
      targetTitles:     ['CEO', 'CTO', 'Founder', 'Co-Founder', 'VP', 'Director', 'Head of'],
      targetIndustries: ['SaaS', 'Cloud', 'FinTech', 'E-commerce', 'Dev-tools'],
      adjacentIndustries: ['HealthTech', 'EdTech', 'MarTech', 'Cybersecurity', 'AI/ML', 'BioTech',
                           'Consulting', 'Legal Services', 'Professional Services', 'Real Estate Tech',
                           'InsurTech', 'Logistics', 'Media', 'Recruitment Tech'],
      excludedIndustries: ['Government', 'Non-profit', 'Academia'],
    },
    {
      id:        'north-america',
      name:      '🇺🇸 North America',
      isDefault: false,
      regions:   ['United States', 'USA', 'US', 'Canada', 'North America',
                  'California', 'New York', 'Texas', 'Florida', 'Illinois',
                  'Washington', 'Massachusetts', 'Colorado', 'Georgia', 'Toronto',
                  'Vancouver', 'Montreal', 'San Francisco', 'Los Angeles',
                  'Chicago', 'Boston', 'Seattle', 'Austin', 'Denver', 'Miami',
                  'Atlanta', 'Dallas', 'Houston', 'Phoenix', 'Philadelphia'],
      weights: {
        titleFit:       20,
        companySize:    15,
        industry:       15,
        techSignals:    15,
        aiFit:          10,
        companyRevenue: 25,
      },
      revenueThreshold: 2_500_000,
      tierThresholds:   { hot: 80, warm: 50 },
      targetTitles:     ['CEO', 'CTO', 'Founder', 'Co-Founder', 'VP Engineering',
                         'VP Product', 'Director of Engineering', 'Head of Product'],
      targetIndustries: ['SaaS', 'Cloud', 'FinTech', 'E-commerce', 'Dev-tools'],
      adjacentIndustries: ['HealthTech', 'EdTech', 'MarTech', 'Cybersecurity', 'AI/ML',
                           'Consulting', 'Legal Services', 'Professional Services', 'Real Estate Tech',
                           'InsurTech', 'Logistics', 'Media', 'Recruitment Tech'],
      excludedIndustries: ['Government', 'Non-profit', 'Academia'],
    },
    {
      id:        'apac',
      name:      '🇮🇳 APAC',
      isDefault: false,
      regions:   ['India', 'Singapore', 'Indonesia', 'Thailand', 'Vietnam',
                  'Philippines', 'Malaysia', 'Bangladesh', 'Sri Lanka',
                  'Mumbai', 'Delhi', 'Bangalore', 'Bengaluru', 'Hyderabad',
                  'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Gurugram',
                  'Noida', 'Gurgaon', 'Asia', 'Southeast Asia'],
      weights: {
        titleFit:       25,
        companySize:    10,
        industry:       20,
        techSignals:    15,
        aiFit:          10,
        companyRevenue: 20,
      },
      revenueThreshold: 500_000,
      tierThresholds:   { hot: 75, warm: 45 },
      targetTitles:     ['CEO', 'CTO', 'Founder', 'Co-Founder', 'Managing Director',
                         'VP', 'Director', 'Head of'],
      targetIndustries: ['SaaS', 'FinTech', 'HealthTech', 'EdTech', 'E-commerce'],
      adjacentIndustries: ['Logistics', 'AgriTech', 'InsurTech', 'Cloud', 'AI/ML', 'BioTech',
                           'Consulting', 'Legal Services', 'Professional Services', 'Real Estate Tech',
                           'Media', 'Recruitment Tech', 'MarTech'],
      excludedIndustries: ['Government', 'Non-profit'],
    },
  ];
}

/**
 * Initialize ICP profiles on first install.
 * Only seeds defaults if no profiles exist yet.
 */
export async function initializeIcpProfiles() {
  const existing = await _getProfiles();
  if (existing.length === 0) {
    await _setProfiles(getDefaultProfiles());
    await setActiveIcpId('global-default');
    await setIcpAutoSwitch(true);
  }
}

/* ---- Internal helpers ---- */

async function _getProfiles() {
  const result = await chrome.storage.local.get(KEYS.ICP_PROFILES);
  return result[KEYS.ICP_PROFILES] || [];
}

async function _setProfiles(profiles) {
  await chrome.storage.local.set({ [KEYS.ICP_PROFILES]: profiles });
}

/* ---- Public CRUD ---- */

/**
 * Get all ICP profiles.
 * @return {Array} Array of profile objects
 */
export async function getIcpProfiles() {
  const profiles = await _getProfiles();
  // If empty, seed defaults
  if (profiles.length === 0) {
    const defaults = getDefaultProfiles();
    await _setProfiles(defaults);
    return defaults;
  }
  return profiles;
}

/**
 * Save (create or update) an ICP profile.
 * @param {Object} profile  Profile object with id field
 */
export async function saveIcpProfile(profile) {
  const profiles = await _getProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);

  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }

  // Ensure only one default
  if (profile.isDefault) {
    profiles.forEach(p => {
      if (p.id !== profile.id) p.isDefault = false;
    });
  }

  await _setProfiles(profiles);
}

/**
 * Delete an ICP profile by id.
 * Cannot delete the last profile or the active default.
 * @param  {string}  id
 * @return {boolean} true if deleted
 */
export async function deleteIcpProfile(id) {
  const profiles = await _getProfiles();
  if (profiles.length <= 1) return false;

  const filtered = profiles.filter(p => p.id !== id);
  if (filtered.length === profiles.length) return false; // not found

  // If we deleted the default, make the first remaining one default
  if (!filtered.some(p => p.isDefault)) {
    filtered[0].isDefault = true;
  }

  await _setProfiles(filtered);

  // If we deleted the active profile, switch to default
  const activeId = await getActiveIcpId();
  if (activeId === id) {
    const def = filtered.find(p => p.isDefault) || filtered[0];
    await setActiveIcpId(def.id);
  }

  return true;
}

/**
 * Reset all profiles to factory defaults.
 */
export async function resetIcpProfiles() {
  await _setProfiles(getDefaultProfiles());
  await setActiveIcpId('global-default');
  await setIcpAutoSwitch(true);
}

/* ---- Active profile + auto-switch ---- */

/**
 * Get the manually selected active ICP profile id.
 */
export async function getActiveIcpId() {
  const result = await chrome.storage.local.get(KEYS.ACTIVE_ICP_ID);
  return result[KEYS.ACTIVE_ICP_ID] || 'global-default';
}

/**
 * Set the active ICP profile id.
 */
export async function setActiveIcpId(id) {
  await chrome.storage.local.set({ [KEYS.ACTIVE_ICP_ID]: id });
}

/**
 * Get whether auto-switch by region is enabled.
 */
export async function getIcpAutoSwitch() {
  const result = await chrome.storage.local.get(KEYS.ICP_AUTO_SWITCH);
  // Default to true if not set
  return result[KEYS.ICP_AUTO_SWITCH] !== false;
}

/**
 * Set whether auto-switch by region is enabled.
 */
export async function setIcpAutoSwitch(enabled) {
  await chrome.storage.local.set({ [KEYS.ICP_AUTO_SWITCH]: !!enabled });
}

/**
 * Resolve which ICP profile to use for a given prospect.
 *
 * If auto-switch is ON:
 *   1. Check prospect's location against each profile's regions
 *   2. First match wins
 *   3. Fall back to the default profile if no region matches
 *
 * If auto-switch is OFF:
 *   Use the manually selected active profile.
 *
 * @param  {string}  location  Prospect's location string (e.g. "San Francisco, CA")
 * @return {Object}  { profile, reason: 'auto'|'manual'|'default' }
 */
export async function resolveIcpProfile(location = '') {
  const profiles  = await getIcpProfiles();
  const autoSwitch = await getIcpAutoSwitch();

  if (autoSwitch && location) {
    const locLower = location.toLowerCase();

    for (const profile of profiles) {
      if (!profile.regions?.length) continue; // skip profiles with no regions (default)

      const matched = profile.regions.some(region =>
        locLower.includes(region.toLowerCase())
      );

      if (matched) {
        return { profile, reason: 'auto', matchedRegion: location };
      }
    }

    // No region match — fall back to default
    const def = profiles.find(p => p.isDefault) || profiles[0];
    return { profile: def, reason: 'default' };
  }

  // Manual mode — use the active profile
  const activeId = await getActiveIcpId();
  const active   = profiles.find(p => p.id === activeId)
                || profiles.find(p => p.isDefault)
                || profiles[0];
  return { profile: active, reason: 'manual' };
}
