/**
 * popup.js — LeadQualify Chrome Extension
 *
 * Flow:
 *   1. On popup open, ask content script for current page data
 *   2. If LinkedIn profile or list → show prospect card + Score button
 *   3. User clicks Score → call icp-scorer.js → groq-engine.js → render
 *   4. Show breakdown bars, decision-maker badge, insights
 *   5. If list view → show all leads + batch Score All button
 *   6. ICP profile management via collapsible settings section
 *   7. Score cache (show cached results instantly)
 *
 *  Cascade health panel shows which of the 3 models are available.
 */

/* ================================================================= */
/*  Industry Catalog — comprehensive list organized by category       */
/* ================================================================= */

const INDUSTRY_CATALOG = [
  { category: '💻 Technology', items: [
    'SaaS', 'Cloud Computing', 'Dev-tools', 'AI / Machine Learning',
    'Cybersecurity', 'Data Analytics', 'IoT', 'Blockchain',
    'AR / VR', 'Robotics', 'Quantum Computing', 'IT Services',
    'Semiconductor', 'Software Development', 'Web3',
  ]},
  { category: '💰 Finance', items: [
    'FinTech', 'Banking', 'Insurance', 'InsurTech',
    'Payments', 'Wealth Management', 'Investment Management',
    'Capital Markets', 'Private Equity', 'Venture Capital',
    'Accounting', 'Financial Services', 'RegTech',
  ]},
  { category: '🏥 Healthcare', items: [
    'HealthTech', 'Telemedicine', 'BioTech', 'Pharmaceutical',
    'Medical Devices', 'Mental Health', 'Clinical Research',
    'Health IT', 'Dental', 'Veterinary', 'Life Sciences',
    'Digital Health',
  ]},
  { category: '🛒 Commerce & Retail', items: [
    'E-commerce', 'Retail', 'D2C (Direct to Consumer)',
    'Marketplace', 'Luxury Goods', 'Consumer Goods', 'CPG',
    'Fashion & Apparel', 'Grocery', 'Wholesale',
  ]},
  { category: '⚖️ Legal & Professional', items: [
    'Legal Services', 'Legal Tech', 'Law Firm',
    'Consulting', 'Management Consulting', 'Professional Services',
    'Staffing & Recruiting', 'Outsourcing', 'Compliance',
  ]},
  { category: '🏗️ Real Estate & Construction', items: [
    'Real Estate', 'PropTech', 'Commercial Real Estate',
    'Property Management', 'Construction', 'Architecture',
    'Smart Buildings', 'Facilities Management',
  ]},
  { category: '🎓 Education', items: [
    'EdTech', 'E-Learning', 'Higher Education', 'K-12',
    'Corporate Training', 'Online Courses', 'LMS',
    'Education Services',
  ]},
  { category: '📣 Marketing & Media', items: [
    'MarTech', 'Advertising', 'Digital Marketing', 'Ad Tech',
    'Media & Entertainment', 'Publishing', 'Streaming',
    'Content Creation', 'PR & Communications', 'Social Media',
  ]},
  { category: '🏭 Manufacturing & Industrial', items: [
    'Manufacturing', 'Industrial IoT', 'Automotive',
    'Aerospace & Defense', 'Chemical', 'Electronics',
    'Machinery & Equipment', 'Smart Manufacturing',
    'Supply Chain', '3D Printing',
  ]},
  { category: '🚚 Logistics & Transportation', items: [
    'Logistics', 'Freight & Shipping', 'Last Mile Delivery',
    'Fleet Management', 'Warehouse Tech', 'Transportation',
    'Ride-sharing & Mobility', 'Drone Delivery',
  ]},
  { category: '⚡ Energy & Environment', items: [
    'Energy', 'CleanTech', 'Renewable Energy', 'Oil & Gas',
    'Solar', 'EV & Electric Vehicles', 'Carbon & Sustainability',
    'Waste Management', 'Water Technology',
  ]},
  { category: '🍽️ Food & Hospitality', items: [
    'Restaurants', 'Food & Beverage', 'Food Tech',
    'Hotels & Hospitality', 'Travel & Tourism',
    'Catering', 'Cloud Kitchen', 'Quick Service (QSR)',
  ]},
  { category: '🌾 Agriculture', items: [
    'AgriTech', 'Farming', 'Precision Agriculture',
    'Animal Health', 'Aquaculture', 'AgriFinance',
  ]},
  { category: '📡 Telecom & Connectivity', items: [
    'Telecom', 'Wireless', '5G', 'Broadband',
    'Satellite', 'Network Infrastructure',
  ]},
  { category: '🎮 Entertainment & Sports', items: [
    'Gaming', 'Esports', 'Sports Tech', 'Fitness Tech',
    'Music Tech', 'Film & TV Production',
  ]},
  { category: '🏛️ Government & Non-profit', items: [
    'Government', 'GovTech', 'Non-profit', 'NGO',
    'Defense', 'Public Safety', 'Academia',
    'Social Enterprise', 'Civic Tech',
  ]},
  { category: '🔬 Other Verticals', items: [
    'HR Tech', 'Recruitment Tech', 'Beauty & Wellness',
    'Pet Care', 'Home Services', 'Event Tech',
    'Wedding Tech', 'Cannabis', 'Space Tech',
    'Climate Tech', 'Circular Economy',
  ]},
];

import { scoreProspect }        from './icp-scorer.js';
import { CASCADE_MODELS }       from './groq-engine.js';
import {
  getApiKey,
  setApiKey,
  clearAllRateLimits,
  getCascadeHealth,
  cacheScore,
  getCachedScore,
  initializeIcpProfiles,
  getIcpProfiles,
  saveIcpProfile,
  deleteIcpProfile,
  resetIcpProfiles,
  getActiveIcpId,
  setActiveIcpId,
  getIcpAutoSwitch,
  setIcpAutoSwitch,
  resolveIcpProfile,
  getTermsAccepted,
  setTermsAccepted,
} from './storage-manager.js';

/* ================================================================= */
/*  Constants                                                        */
/* ================================================================= */

const CIRCUMFERENCE = 2 * Math.PI * 54;   // score-ring radius = 54
const TIER_EMOJI    = { HOT: '🔥', WARM: '🌡️', COLD: '❄️' };
const BATCH_DELAY   = 3000; // 3 seconds between batch scores (safe with reduced token usage)

/* ================================================================= */
/*  DOM refs (cached once)                                           */
/* ================================================================= */

const $ = (id) => document.getElementById(id);

const el = {
  // API key
  apiSection:    $('apiSection'),
  apiToggle:     $('apiToggle'),
  apiToggleLabel:$('apiToggleLabel'),
  apiBody:       $('apiBody'),
  apiKeyInput:   $('apiKeyInput'),
  saveApiKey:    $('saveApiKey'),

  // States
  stateNotLinkedin: $('stateNotLinkedin'),
  stateProspect:    $('stateProspect'),
  stateLoading:     $('stateLoading'),
  stateResult:      $('stateResult'),
  stateError:       $('stateError'),

  // Prospect
  prospectAvatar:   $('prospectAvatar'),
  prospectName:     $('prospectName'),
  prospectHeadline: $('prospectHeadline'),
  prospectMeta:     $('prospectMeta'),

  // Loading
  loadingText:    $('loadingText'),

  // Result
  scoreRingFill:  $('scoreRingFill'),
  scoreNumber:    $('scoreNumber'),
  scoreTier:      $('scoreTier'),
  summaryText:    $('summaryText'),
  approachText:   $('approachText'),
  modelUsedName:  $('modelUsedName'),

  // Decision Maker
  decisionMaker:  $('decisionMaker'),
  dmIcon:         $('dmIcon'),
  dmLevel:        $('dmLevel'),
  dmTitle:        $('dmTitle'),
  dmFounder:      $('dmFounder'),
  dmBudget:       $('dmBudget'),

  // Breakdown
  barTitleFit:     $('barTitleFit'),
  barCompanySize:  $('barCompanySize'),
  barIndustry:     $('barIndustry'),
  barTechSignals:  $('barTechSignals'),
  barAiFit:           $('barAiFit'),
  barCompanyRevenue:  $('barCompanyRevenue'),
  scoreTitleFit:      $('scoreTitleFit'),
  scoreCompanySize:   $('scoreCompanySize'),
  scoreIndustry:      $('scoreIndustry'),
  scoreTechSignals:   $('scoreTechSignals'),
  scoreAiFit:         $('scoreAiFit'),
  scoreCompanyRevenue:$('scoreCompanyRevenue'),

  // New sections
  expSummary:      $('expSummary'),
  expYears:        $('expYears'),
  expCurrentRole:  $('expCurrentRole'),
  expCurrentCompany: $('expCurrentCompany'),
  expPreviousRoles:  $('expPreviousRoles'),
  expIndustries:     $('expIndustries'),

  insightsSection: $('insightsSection'),
  insightsList:    $('insightsList'),

  talkingPoints:   $('talkingPoints'),
  talkingList:     $('talkingList'),

  redFlags:        $('redFlags'),
  redFlagsList:    $('redFlagsList'),

  // Cache badge
  cacheBadge:     $('cacheBadge'),
  cacheBadgeText: $('cacheBadgeText'),

  // Qualifiable % (score confidence)
  qualifiable:       $('qualifiable'),
  qualifiableValue:  $('qualifiableValue'),
  qualifiableStatus: $('qualifiableStatus'),
  qualifiableFill:   $('qualifiableFill'),
  qualifiableNote:   $('qualifiableNote'),

  // Acceptable-use gate
  consentGate:   $('consentGate'),
  consentAccept: $('consentAccept'),

  // Data Confidence
  dataConfidence:       $('dataConfidence'),
  dataConfidenceValue:  $('dataConfidenceValue'),
  dataConfidenceStatus: $('dataConfidenceStatus'),
  dataConfidenceFill:   $('dataConfidenceFill'),
  dataConfidenceToggle: $('dataConfidenceToggle'),
  dataConfidenceGrid:   $('dataConfidenceGrid'),
  dcRevenue:     $('dcRevenue'),
  dcCompanySize: $('dcCompanySize'),
  dcIndustry:    $('dcIndustry'),
  dcTitle:       $('dcTitle'),
  dcExperience:  $('dcExperience'),
  dcLocation:    $('dcLocation'),
  dcSkills:      $('dcSkills'),
  dcAbout:       $('dcAbout'),
  dcEducation:   $('dcEducation'),

  // ICP Profile used badge
  icpUsedBadge:   $('icpUsedBadge'),
  icpUsedText:    $('icpUsedText'),

  // ICP Settings
  icpSection:         $('icpSection'),
  icpToggle:          $('icpToggle'),
  icpBody:            $('icpBody'),
  icpActiveName:      $('icpActiveName'),
  icpActiveReason:    $('icpActiveReason'),
  icpAutoSwitch:      $('icpAutoSwitch'),
  icpProfileSelect:   $('icpProfileSelect'),
  icpName:            $('icpName'),
  icpRegions:         $('icpRegions'),
  icpRevenueThreshold:$('icpRevenueThreshold'),
  icpWeightTotal:     $('icpWeightTotal'),
  wTitleFit:          $('wTitleFit'),
  wCompanySize:       $('wCompanySize'),
  wIndustry:          $('wIndustry'),
  wTechSignals:       $('wTechSignals'),
  wAiFit:             $('wAiFit'),
  wCompanyRevenue:    $('wCompanyRevenue'),
  wTitleFitVal:       $('wTitleFitVal'),
  wCompanySizeVal:    $('wCompanySizeVal'),
  wIndustryVal:       $('wIndustryVal'),
  wTechSignalsVal:    $('wTechSignalsVal'),
  wAiFitVal:          $('wAiFitVal'),
  wCompanyRevenueVal: $('wCompanyRevenueVal'),
  icpTargetTitles:    $('icpTargetTitles'),
  // Industry multi-select containers (populated by IndustrySelect class)
  indSelectTarget:   $('indSelectTarget'),
  indSearchTarget:   $('indSearchTarget'),
  indPillsTarget:    $('indPillsTarget'),
  indListTarget:     $('indListTarget'),
  indSelectExcluded: $('indSelectExcluded'),
  indSearchExcluded: $('indSearchExcluded'),
  indPillsExcluded:  $('indPillsExcluded'),
  indListExcluded:   $('indListExcluded'),
  icpSave:            $('icpSave'),
  icpNew:             $('icpNew'),
  icpDelete:          $('icpDelete'),
  icpResetDefaults:   $('icpResetDefaults'),

  // List view
  stateListView:    $('stateListView'),
  listCount:        $('listCount'),
  batchProgress:    $('batchProgress'),
  batchProgressFill:$('batchProgressFill'),
  batchProgressText:$('batchProgressText'),
  leadList:         $('leadList'),
  btnScoreAll:      $('btnScoreAll'),
  btnStopBatch:     $('btnStopBatch'),

  // Cascade
  dots:         [0, 1, 2].map((i) => $(`dot${i}`)),
  cascadeCount: $('cascadeCount'),

  // Actions
  btnScore: $('btnScore'),
  btnReset: $('btnReset'),

  // Toast
  toast:    $('toast'),
  toastMsg: $('toastMsg'),

  // Error
  errorMessage: $('errorMessage'),
};

/* ================================================================= */
/*  State                                                            */
/* ================================================================= */

let currentProspect   = null;
let hasApiKey         = false;
let currentListData   = null;
let batchStopped      = false;
let isBatchRunning    = false;
let isScoring         = false;   // a single-profile score is in flight
let cachedResult      = null;
let currentIcpProfile = null;   // resolved ICP for current prospect
let icpProfiles       = [];     // all profiles from storage
let editingProfileId  = null;   // which profile is being edited in settings

/* ================================================================= */
/*  Init                                                             */
/* ================================================================= */

document.addEventListener('DOMContentLoaded', async () => {
  await checkConsent();
  await initializeIcpProfiles();
  await loadIcpSettings();
  bindEvents();
  await checkApiKey();
  await checkCurrentPage();
  await refreshCascadeHealth();
  watchTabNavigation();
});

/**
 * First-run acceptable-use gate. Shows the consent overlay until the user
 * acknowledges it, then records the acknowledgement so it isn't shown again.
 */
async function checkConsent() {
  const accepted = await getTermsAccepted();
  if (accepted) {
    el.consentGate.hidden = true;
    return;
  }
  el.consentGate.hidden = false;
  el.consentAccept.addEventListener('click', async () => {
    await setTermsAccepted(true);
    el.consentGate.hidden = true;
  }, { once: true });
}

/* ================================================================= */
/*  Event bindings                                                   */
/* ================================================================= */

function bindEvents() {
  // API key toggle
  el.apiToggle.addEventListener('click', () => {
    el.apiSection.classList.toggle('open');
  });

  // Save API key
  el.saveApiKey.addEventListener('click', async () => {
    const key = el.apiKeyInput.value.trim();
    if (!key) return toast('Enter a valid API key', true);

    await setApiKey(key);
    hasApiKey = true;
    el.apiKeyInput.value = '';
    el.apiSection.classList.remove('open');
    el.apiToggleLabel.textContent = '🔑 API Key saved';
    toast('API key saved ✓');

    // If we have prospect data, enable scoring
    if (currentProspect) el.btnScore.disabled = false;
    if (currentListData) el.btnScoreAll.disabled = false;
  });

  // Score button
  el.btnScore.addEventListener('click', () => handleScore());

  // Reset rate limits
  el.btnReset.addEventListener('click', async () => {
    await clearAllRateLimits();
    await refreshCascadeHealth();
    toast('Rate limit cache cleared ✓');
  });

  // Data confidence toggle
  el.dataConfidenceToggle.addEventListener('click', () => {
    el.dataConfidence.classList.toggle('expanded');
  });

  // List view buttons
  el.btnScoreAll.addEventListener('click', () => handleScoreAll());
  el.btnStopBatch.addEventListener('click', () => handleStopBatch());

  // ICP settings toggle
  el.icpToggle.addEventListener('click', () => {
    el.icpSection.classList.toggle('open');
  });

  // ICP auto-switch toggle
  el.icpAutoSwitch.addEventListener('change', async () => {
    await setIcpAutoSwitch(el.icpAutoSwitch.checked);
    toast(el.icpAutoSwitch.checked ? 'Auto-switch enabled ✓' : 'Manual mode enabled');
  });

  // ICP profile selector
  el.icpProfileSelect.addEventListener('change', async () => {
    editingProfileId = el.icpProfileSelect.value;
    await setActiveIcpId(editingProfileId);
    populateIcpEditor(editingProfileId);
    updateIcpActiveBadge();
  });

  // Weight sliders
  const weightSliders = ['wTitleFit', 'wCompanySize', 'wIndustry', 'wTechSignals', 'wAiFit', 'wCompanyRevenue'];
  weightSliders.forEach(id => {
    el[id].addEventListener('input', () => updateWeightDisplay());
  });

  // Save profile
  el.icpSave.addEventListener('click', handleIcpSave);

  // New profile
  el.icpNew.addEventListener('click', handleIcpNew);

  // Delete profile
  el.icpDelete.addEventListener('click', handleIcpDelete);

  // Reset defaults
  el.icpResetDefaults.addEventListener('click', async () => {
    await resetIcpProfiles();
    await loadIcpSettings();
    toast('ICP profiles reset to defaults ✓');
  });
}

/* ================================================================= */
/*  API Key                                                          */
/* ================================================================= */

async function checkApiKey() {
  const key = await getApiKey();
  if (key) {
    hasApiKey = true;
    el.apiToggleLabel.textContent = '🔑 API Key saved';
  } else {
    hasApiKey = false;
    el.apiSection.classList.add('open');
  }
}

/* ================================================================= */
/*  Page check + scrape                                              */
/* ================================================================= */

async function checkCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes('linkedin.com')) {
      showState('not-linkedin');
      return;
    }

    // Try pinging the content script
    let alive = false;
    let detectedPageType = 'unknown';
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      alive = pong?.alive;
      detectedPageType = pong?.pageType || 'unknown';
    } catch (_) { /* not injected yet */ }

    // Inject if needed
    if (!alive) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
        await sleep(400);
        // Re-ping to get page type
        try {
          const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
          detectedPageType = pong?.pageType || 'unknown';
        } catch (_) {}
      } catch (e) {
        showState('not-linkedin');
        return;
      }
    }

    // ---- List view ----
    if (detectedPageType === 'sales-list') {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_LIST' });
      if (response?.success && response.data?.leads?.length) {
        currentListData = response.data;
        await renderListView(currentListData.leads);
        showState('list-view');
        el.btnScoreAll.disabled = !hasApiKey;
      } else {
        showState('not-linkedin');
      }
      return;
    }

    // ---- Single profile/company ----
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_PAGE' });

    if (response?.success && response.data) {
      currentProspect = response.data;
      renderProspect(currentProspect);

      // Check score cache
      const cached = await getCachedScore(currentProspect.url);
      if (cached) {
        cachedResult = cached;
        renderResult(cached.result);
        renderDataConfidence(currentProspect);
        showCacheBadge(cached.timestamp);
        showState('result');
      } else {
        showState('prospect');
        el.btnScore.disabled = !hasApiKey;
      }
    } else {
      showState('not-linkedin');
    }
  } catch (err) {
    console.warn('[popup] page check failed', err);
    showState('not-linkedin');
  }
}

/* ================================================================= */
/*  SPA-navigation refresh                                           */
/* ================================================================= */

/**
 * LinkedIn is a single-page app: navigating between profiles doesn't reload
 * the tab, so the side panel would otherwise keep showing the previous
 * prospect. Watch the active tab for URL changes (and tab switches) and
 * re-scan — debounced, and skipped while a score/batch is running so we don't
 * yank the view mid-scoring.
 */
let _rescanTimer = null;

function scheduleRescan() {
  clearTimeout(_rescanTimer);
  _rescanTimer = setTimeout(async () => {
    // If a score/batch is in flight, don't scan now — but DON'T drop the
    // navigation either; re-arm so it's honored once the flag clears (bounded,
    // self-clearing poll, since isScoring/isBatchRunning always reset).
    if (isBatchRunning || isScoring) {
      scheduleRescan();
      return;
    }
    await checkCurrentPage();   // idempotent: re-reads the active tab
    await refreshCascadeHealth();
  }, 600);
}

function watchTabNavigation() {
  // URL changes in the active tab (includes LinkedIn's history-API navigations,
  // since we hold host permission for linkedin.com). No URL-equality dedupe —
  // the 600ms debounce collapses event storms and checkCurrentPage is idempotent.
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab?.active && changeInfo.url) scheduleRescan();
  });
  // Switching to another tab (e.g. a different LinkedIn profile in another tab).
  chrome.tabs.onActivated.addListener(() => scheduleRescan());
}

/* ================================================================= */
/*  Render prospect preview                                          */
/* ================================================================= */

function renderProspect(data) {
  if (data.type === 'profile') {
    const initials = (data.name || '?')
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
    el.prospectAvatar.textContent = initials;
    el.prospectName.textContent     = data.name || 'Unknown';
    el.prospectHeadline.textContent = data.currentTitle && data.currentCompany
      ? `${data.currentTitle} at ${data.currentCompany}`
      : data.headline || '—';
    const parts = [];
    if (data.location) parts.push(data.location);
    if (data.experience?.length) parts.push(`${data.experience.length} roles`);
    if (data.skills?.length) parts.push(`${data.skills.length} skills`);
    if (data.education?.length) parts.push(`${data.education.length} edu`);
    el.prospectMeta.textContent = parts.join(' · ');
  } else {
    el.prospectAvatar.textContent   = (data.companyName || '?')[0].toUpperCase();
    el.prospectName.textContent     = data.companyName || 'Unknown Company';
    el.prospectHeadline.textContent = data.industry || '—';
    el.prospectMeta.textContent     = data.size || '';
  }
}

/* ================================================================= */
/*  Score handler                                                    */
/* ================================================================= */

async function handleScore() {
  if (!currentProspect) return;
  if (!hasApiKey) return toast('Set your API key first', true);

  // ---- Scrape-quality gate ----
  // Don't score a page that hasn't loaded / has no identity, and warn (but
  // allow) when page data is very thin — confidence-weighting handles the rest.
  // Meaningful page text counts as identity: it's the scraper's deliberate
  // fallback (rawPageText) that the scorer consumes when selectors miss.
  const hasPageText = (currentProspect.rawPageText || '').trim().length > 200;
  const hasIdentity = currentProspect.type === 'company'
    ? !!(currentProspect.companyName || currentProspect.industry || currentProspect.size || hasPageText)
    : !!(currentProspect.name || currentProspect.headline || currentProspect.currentTitle || hasPageText);
  if (!hasIdentity) {
    return toast('Couldn’t read this page yet — scroll to the top or reload, then Score again.', true);
  }
  const dq = computeDataConfidence(currentProspect);
  if (dq.score < 25) {
    toast('Low page data — this will be a rough estimate. Open the About / Experience sections for a better read.');
  }

  isScoring = true;
  showState('loading');
  el.cacheBadge.hidden = true;
  el.icpUsedBadge.hidden = true;
  el.loadingText.textContent = `Scoring with ${CASCADE_MODELS[0].name} ${CASCADE_MODELS[0].emoji}`;

  try {
    // Resolve the right ICP profile based on prospect location
    const location = currentProspect.location || '';
    const { profile, reason } = await resolveIcpProfile(location);
    currentIcpProfile = profile;

    const result = await scoreProspect(currentProspect, profile);
    renderResult(result, profile, reason);
    renderDataConfidence(currentProspect);
    showState('result');

    // Cache the score
    if (currentProspect.url) {
      await cacheScore(currentProspect.url, result);
    }
  } catch (err) {
    console.error('[popup] scoring error', err);

    if (err.code === 'ALL_MODELS_EXHAUSTED') {
      showError(err.message);
    } else if (err.code === 'INVALID_KEY' || err.code === 'NO_API_KEY') {
      showError(err.message);
    } else {
      showError(err.message || 'Scoring failed — try again.');
    }
    showState('error');
  }

  isScoring = false;
  await refreshCascadeHealth();
}

/* ================================================================= */
/*  List view rendering + batch scoring                              */
/* ================================================================= */

/**
 * Render the list of leads in the popup.
 * Pre-fills cached scores if available.
 */
async function renderListView(leads) {
  el.leadList.innerHTML = '';
  el.listCount.textContent = currentListData?.capped
    ? `${leads.length} of ${currentListData.total} on this page`
    : `${leads.length} leads found`;
  el.batchProgress.hidden = true;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const row = document.createElement('div');
    row.className = 'lead-row';
    row.dataset.index = i;

    // Check cache for this lead
    let scoreHtml = '<span class="lead-row__score lead-row__score--empty">—</span>';
    if (lead.profileUrl) {
      const cached = await getCachedScore(lead.profileUrl);
      if (cached) {
        const s = cached.result.overallScore;
        const tier = cached.result.tier;
        const cls = `lead-row__score lead-row__score--${tier.toLowerCase()}`;
        scoreHtml = `<span class="${cls}">${s}</span>`;
        lead._cached = true;
        lead._score = cached.result;
      }
    }

    const detail = [lead.title, lead.company].filter(Boolean).join(' · ');

    row.innerHTML = `
      <span class="lead-row__index">${i + 1}</span>
      <div class="lead-row__info">
        <div class="lead-row__name">${escapeHtml(lead.name)}</div>
        <div class="lead-row__detail">${escapeHtml(detail)}</div>
      </div>
      ${scoreHtml}
    `;

    // Click to score individual lead
    row.addEventListener('click', () => handleScoreSingle(i));

    el.leadList.appendChild(row);

    // Mark cached rows with score + confidence for sorting/low-confidence styling.
    if (lead._score) {
      row.dataset.score = String(lead._score.overallScore);
      const q = lead._score.qualifiable;
      const badge = row.querySelector('.lead-row__score');
      if (q && badge) {
        badge.dataset.conf = q.level;
        badge.title = `Score confidence ${q.percent}% (${q.level})`;
        row.classList.toggle('lead-row--lowconf', q.level === 'low');
      }
    }
  }

  sortLeadRows();
}

/**
 * Score a single lead from the list.
 */
async function handleScoreSingle(index) {
  if (!hasApiKey) return toast('Set your API key first', true);
  if (isBatchRunning) return;

  const leads = currentListData?.leads;
  if (!leads || !leads[index]) return;

  const lead = leads[index];
  const row = el.leadList.querySelector(`.lead-row[data-index="${index}"]`);
  if (!row) return;

  // Show spinner
  row.classList.add('lead-row--scoring');
  const scoreEl = row.querySelector('.lead-row__score, .lead-row__spinner')?.parentElement
    || row;
  const existingScore = row.querySelector('.lead-row__score');
  if (existingScore) {
    existingScore.outerHTML = '<div class="lead-row__spinner"></div>';
  }

  try {
    const miniProfile = buildMiniProfile(lead);
    const { profile } = await resolveIcpProfile(lead.location || '');
    const result = await scoreProspect(miniProfile, profile);

    // Cache
    if (lead.profileUrl) {
      await cacheScore(lead.profileUrl, result);
    }

    lead._cached = true;
    lead._score = result;

    updateLeadRowScore(row, result);
    row.classList.remove('lead-row--scoring');
    row.classList.add('lead-row--done');
  } catch (err) {
    console.error('[popup] single score error', err);
    const spinner = row.querySelector('.lead-row__spinner');
    if (spinner) {
      spinner.outerHTML = '<span class="lead-row__score lead-row__score--empty">✕</span>';
    }
    row.classList.remove('lead-row--scoring');
    toast(err.message || 'Scoring failed', true);
  }

  sortLeadRows();
  await refreshCascadeHealth();
}

/**
 * Batch-score all un-scored leads sequentially with delays.
 */
async function handleScoreAll() {
  if (!hasApiKey) return toast('Set your API key first', true);
  if (isBatchRunning) return;

  const leads = currentListData?.leads;
  if (!leads?.length) return;

  isBatchRunning = true;
  batchStopped   = false;

  // Show progress + stop button
  el.batchProgress.hidden = false;
  el.btnScoreAll.hidden   = true;
  el.btnStopBatch.hidden  = false;

  const total = leads.length;
  let   done  = 0;

  // Count already-cached
  const uncachedIndices = [];
  for (let i = 0; i < leads.length; i++) {
    if (leads[i]._cached) {
      done++;
    } else {
      uncachedIndices.push(i);
    }
  }

  updateBatchProgress(done, total);

  for (const idx of uncachedIndices) {
    if (batchStopped) break;

    const lead = leads[idx];
    const row  = el.leadList.querySelector(`.lead-row[data-index="${idx}"]`);
    if (!row) continue;

    // Show spinner
    row.classList.add('lead-row--scoring');
    const existingScore = row.querySelector('.lead-row__score');
    if (existingScore) {
      existingScore.outerHTML = '<div class="lead-row__spinner"></div>';
    }

    // Scroll the row into view
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const miniProfile = buildMiniProfile(lead);
      const { profile } = await resolveIcpProfile(lead.location || '');
      const result = await scoreProspect(miniProfile, profile);

      // Cache
      if (lead.profileUrl) {
        await cacheScore(lead.profileUrl, result);
      }

      lead._cached = true;
      lead._score  = result;

      updateLeadRowScore(row, result);
      row.classList.add('lead-row--done');
    } catch (err) {
      console.error(`[popup] batch score #${idx} error`, err);
      const spinner = row.querySelector('.lead-row__spinner');
      if (spinner) {
        spinner.outerHTML = '<span class="lead-row__score lead-row__score--empty">✕</span>';
      }

      // If all models exhausted, stop the batch
      if (err.code === 'ALL_MODELS_EXHAUSTED') {
        toast('All models exhausted — batch stopped', true);
        break;
      }
    }

    row.classList.remove('lead-row--scoring');
    done++;
    updateBatchProgress(done, total);

    // Delay between scores (only if more remain)
    if (!batchStopped && idx !== uncachedIndices[uncachedIndices.length - 1]) {
      await sleep(BATCH_DELAY);
    }
  }

  // Cleanup
  isBatchRunning = false;
  el.btnScoreAll.hidden  = false;
  el.btnStopBatch.hidden = true;
  updateBatchProgress(done, total);

  if (!batchStopped) {
    toast(`Batch complete — ${done}/${total} scored ✓`);
  } else {
    toast('Batch stopped');
  }

  sortLeadRows();
  await refreshCascadeHealth();
}

/** Stop the running batch */
function handleStopBatch() {
  batchStopped = true;
}

/** Update the batch progress bar */
function updateBatchProgress(done, total) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  el.batchProgressFill.style.width = `${pct}%`;
  el.batchProgressText.textContent = `${done} / ${total}`;
}

/** Update a lead row with the score result */
function updateLeadRowScore(row, result) {
  const { overallScore, tier, qualifiable } = result;
  const cls = `lead-row__score lead-row__score--${tier.toLowerCase()}`;

  const spinner = row.querySelector('.lead-row__spinner');
  const existing = row.querySelector('.lead-row__score');
  const target = spinner || existing;

  if (target) {
    const badge = document.createElement('span');
    badge.className = cls;
    badge.textContent = overallScore;
    if (qualifiable) {
      badge.dataset.conf = qualifiable.level;
      badge.title = `Score confidence ${qualifiable.percent}% (${qualifiable.level}) — list scores are card-only estimates; open the profile for a full read.`;
    }
    target.replaceWith(badge);
  }

  // Record score for sorting + flag low-confidence rows.
  row.dataset.score = String(overallScore);
  if (qualifiable) row.classList.toggle('lead-row--lowconf', qualifiable.level === 'low');
}

/** Reorder lead rows by score (desc); un-scored rows sink to the bottom. */
function sortLeadRows() {
  const rows = Array.from(el.leadList.querySelectorAll('.lead-row'));
  rows.sort((a, b) => {
    const sa = a.dataset.score !== undefined ? Number(a.dataset.score) : -1;
    const sb = b.dataset.score !== undefined ? Number(b.dataset.score) : -1;
    return sb - sa;
  });
  rows.forEach(r => el.leadList.appendChild(r));
}

/** Build a mini-profile object from list card data for scoring */
function buildMiniProfile(lead) {
  return {
    type:      'profile',
    name:      lead.name,
    headline:  [lead.title, lead.company].filter(Boolean).join(' at '),
    location:  lead.location,
    currentTitle:   lead.title,
    currentCompany: lead.company,
    about:     lead.snippet || '',
    experience: lead.title ? [{ title: lead.title, company: lead.company, duration: '' }] : [],
    skills:    [],
    url:       lead.profileUrl,
    rawPageText: [lead.name, lead.title, lead.company, lead.location, lead.snippet]
      .filter(Boolean).join(' | '),
  };
}

/** Escape HTML to prevent XSS in dynamic content */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ================================================================= */
/*  Render result (animated)                                         */
/* ================================================================= */

function renderResult(result, icpProfile = null, icpReason = null) {
  const { overallScore, tier, breakdown, summary, approachSuggestion, modelUsed,
          decisionMaker, keyInsights, redFlags, talkingPoints, experienceSummary,
          qualifiable } = result;

  // ---- ICP Used badge ----
  if (icpProfile && el.icpUsedBadge) {
    el.icpUsedBadge.hidden = false;
    let reasonText = '';
    if (icpReason === 'auto') reasonText = ' (auto-switched by region)';
    else if (icpReason === 'manual') reasonText = ' (manually selected)';
    else if (icpReason === 'default') reasonText = ' (default fallback)';
    el.icpUsedText.textContent = `Scored with: ${icpProfile.name}${reasonText}`;
  }

  // ---- Score ring ----
  const wrap = document.querySelector('.score-ring-wrap');
  wrap.dataset.tier = tier;

  // Animate ring
  const dashLen = (overallScore / 100) * CIRCUMFERENCE;
  requestAnimationFrame(() => {
    el.scoreRingFill.style.strokeDasharray = `${dashLen} ${CIRCUMFERENCE}`;
  });

  // Count-up number
  animateCount(el.scoreNumber, 0, overallScore, 1000);

  // Tier label
  el.scoreTier.textContent = `${TIER_EMOJI[tier] || ''} ${tier}`;

  // ---- Qualifiable % (score confidence) ----
  if (qualifiable && typeof qualifiable.percent === 'number') {
    el.qualifiable.hidden = false;
    const statusLabels = { high: 'Well-evidenced', medium: 'Partly inferred', low: 'Mostly estimated' };
    el.qualifiableValue.textContent  = `${qualifiable.percent}%`;
    el.qualifiableStatus.textContent  = statusLabels[qualifiable.level] || '';
    el.qualifiableStatus.dataset.level = qualifiable.level;
    el.qualifiableFill.dataset.level   = qualifiable.level;
    el.qualifiableNote.textContent     = qualifiable.note || '';
    requestAnimationFrame(() => {
      el.qualifiableFill.style.width = `${qualifiable.percent}%`;
    });
  } else {
    el.qualifiable.hidden = true;
  }

  // ---- Decision Maker badge ----
  if (decisionMaker) {
    el.decisionMaker.hidden = false;

    const levelIcons = {
      FOUNDER:     '👑',
      C_SUITE:     '🏢',
      VP_DIRECTOR: '📊',
      MANAGER:     '👔',
      IC:          '💻',
      UNKNOWN:     '👤',
    };

    const levelLabels = {
      FOUNDER:     'Founder / Owner',
      C_SUITE:     'C-Suite Executive',
      VP_DIRECTOR: 'VP / Director',
      MANAGER:     'Manager',
      IC:          'Individual Contributor',
      UNKNOWN:     'Unknown Level',
    };

    el.dmIcon.textContent  = levelIcons[decisionMaker.level] || '👤';
    el.dmLevel.textContent = levelLabels[decisionMaker.level] || decisionMaker.level;
    el.dmTitle.textContent = decisionMaker.title || '';

    el.dmFounder.hidden = !decisionMaker.isFounder;
    el.dmBudget.hidden  = !decisionMaker.canSignCheck;
  } else {
    el.decisionMaker.hidden = true;
  }

  // ---- Breakdown bars ----
  const cats = [
    ['titleFit',        el.barTitleFit,        el.scoreTitleFit],
    ['companySize',     el.barCompanySize,      el.scoreCompanySize],
    ['industry',        el.barIndustry,         el.scoreIndustry],
    ['techSignals',     el.barTechSignals,      el.scoreTechSignals],
    ['aiFit',           el.barAiFit,            el.scoreAiFit],
    ['companyRevenue',  el.barCompanyRevenue,   el.scoreCompanyRevenue],
  ];

  cats.forEach(([key, barEl, scoreEl], i) => {
    const cat = breakdown[key];
    if (!cat) return;

    const score = cat.score;
    const barTier = score >= 80 ? 'HOT' : score >= 50 ? 'WARM' : 'COLD';
    barEl.parentElement.parentElement.setAttribute('data-bar-tier', barTier);

    // Delay bar animation to sync with slide-in
    setTimeout(() => {
      barEl.style.width = `${score}%`;
    }, 200 + i * 150);

    scoreEl.textContent = score;

    // Set tooltip
    barEl.parentElement.parentElement.title = cat.reason || '';
  });

  // ---- Summary ----
  el.summaryText.textContent  = summary || '';
  el.approachText.textContent = approachSuggestion ? `💡 ${approachSuggestion}` : '';

  // ---- Experience Summary ----
  if (experienceSummary) {
    el.expSummary.hidden = false;

    el.expYears.textContent = experienceSummary.totalYearsEstimate
      ? `${experienceSummary.totalYearsEstimate}+`
      : '—';

    el.expCurrentRole.textContent = experienceSummary.currentRole || '—';

    el.expCurrentCompany.innerHTML = experienceSummary.currentCompany
      ? `<strong>Company:</strong> ${escapeHtml(experienceSummary.currentCompany)}`
      : '';

    if (experienceSummary.previousNotableRoles?.length) {
      el.expPreviousRoles.innerHTML = `<strong>Notable Roles:</strong> ${escapeHtml(experienceSummary.previousNotableRoles.join(' → '))}`;
    } else {
      el.expPreviousRoles.textContent = '';
    }

    if (experienceSummary.industryExperience?.length) {
      el.expIndustries.innerHTML = `<strong>Industries:</strong> ${escapeHtml(experienceSummary.industryExperience.join(', '))}`;
    } else {
      el.expIndustries.textContent = '';
    }
  } else {
    el.expSummary.hidden = true;
  }

  // ---- Key Insights ----
  if (keyInsights?.length) {
    el.insightsSection.hidden = false;
    el.insightsList.innerHTML = '';
    keyInsights.forEach((insight) => {
      const li = document.createElement('li');
      li.textContent = insight;
      el.insightsList.appendChild(li);
    });
  } else {
    el.insightsSection.hidden = true;
  }

  // ---- Talking Points ----
  if (talkingPoints?.length) {
    el.talkingPoints.hidden = false;
    el.talkingList.innerHTML = '';
    talkingPoints.forEach((point) => {
      const li = document.createElement('li');
      li.textContent = point;
      el.talkingList.appendChild(li);
    });
  } else {
    el.talkingPoints.hidden = true;
  }

  // ---- Red Flags ----
  if (redFlags?.length && redFlags.some(f => f && f.trim())) {
    el.redFlags.hidden = false;
    el.redFlagsList.innerHTML = '';
    redFlags.filter(f => f && f.trim()).forEach((flag) => {
      const li = document.createElement('li');
      li.textContent = flag;
      el.redFlagsList.appendChild(li);
    });
  } else {
    el.redFlags.hidden = true;
  }

  // ---- Model badge ----
  if (modelUsed) {
    el.modelUsedName.textContent = `${modelUsed.name} ${modelUsed.emoji}`;
  }
}

/* ================================================================= */
/*  Cascade health                                                   */
/* ================================================================= */

async function refreshCascadeHealth() {
  const health  = await getCascadeHealth();
  let   healthy = 0;

  CASCADE_MODELS.forEach((model, i) => {
    const dot       = el.dots[i];
    const exhausted = health[model.id]?.exhausted;

    dot.className = exhausted
      ? 'cascade-dot cascade-dot--exhausted'
      : 'cascade-dot cascade-dot--ok';

    dot.title = exhausted
      ? `${model.name} — exhausted (${health[model.id].reason})`
      : `${model.name} — healthy`;

    if (!exhausted) healthy++;
  });

  el.cascadeCount.textContent = `${healthy}/3 healthy`;
}

/* ================================================================= */
/*  UI helpers                                                       */
/* ================================================================= */

const ALL_STATES = [
  el.stateNotLinkedin,
  el.stateProspect,
  el.stateLoading,
  el.stateResult,
  el.stateError,
  el.stateListView,
];

function showState(name) {
  ALL_STATES.forEach((s) => s && (s.hidden = true));

  const map = {
    'not-linkedin': el.stateNotLinkedin,
    'prospect':     el.stateProspect,
    'loading':      el.stateLoading,
    'result':       el.stateResult,
    'error':        el.stateError,
    'list-view':    el.stateListView,
  };

  // Show/hide actions section based on state
  const actionsSection = document.querySelector('.actions');
  if (actionsSection) {
    actionsSection.hidden = (name === 'list-view');
  }

  const target = map[name];
  if (target) {
    target.hidden = false;
    target.classList.add('pop-in');
    target.addEventListener('animationend', () => target.classList.remove('pop-in'), { once: true });
  }

  // Update score button label based on cache state
  if (name === 'result' && cachedResult) {
    el.btnScore.innerHTML = '<span class="btn__icon">🔄</span> Re-score';
  } else {
    el.btnScore.innerHTML = '<span class="btn__icon">🎯</span> Score Prospect';
  }
}

function showError(msg) {
  el.errorMessage.textContent = msg;
}

/** Show the cache badge with a relative timestamp */
function showCacheBadge(timestamp) {
  el.cacheBadge.hidden = false;
  const ago = timeAgo(timestamp);
  el.cacheBadgeText.textContent = `Cached · Scored ${ago}`;
}

/** Format a timestamp as relative time */
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function toast(msg, isError = false) {
  el.toastMsg.textContent = msg;
  el.toast.hidden = false;
  el.toast.className = isError ? 'toast show toast--error' : 'toast show';

  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => (el.toast.hidden = true), 400);
  }, 2500);
}

function animateCount(element, from, to, duration) {
  const start = performance.now();
  const diff  = to - from;

  function frame(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out quad
    const ease = 1 - (1 - progress) * (1 - progress);
    element.textContent = Math.round(from + diff * ease);

    if (progress < 1) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ================================================================= */
/*  ICP Settings Helpers                                             */
/* ================================================================= */

/**
 * Load ICP settings from storage and populate the UI.
 */
async function loadIcpSettings() {
  icpProfiles = await getIcpProfiles();
  const activeId = await getActiveIcpId();
  const autoSwitch = await getIcpAutoSwitch();

  // Populate dropdown
  el.icpProfileSelect.innerHTML = '';
  icpProfiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    el.icpProfileSelect.appendChild(opt);
  });

  // Set auto-switch toggle
  el.icpAutoSwitch.checked = autoSwitch;

  // Edit the active profile
  editingProfileId = activeId;
  populateIcpEditor(activeId);
  updateIcpActiveBadge();
}

/**
 * Populate the settings editor form with a specific profile's data.
 */
function populateIcpEditor(profileId) {
  const profile = icpProfiles.find(p => p.id === profileId);
  if (!profile) return;

  el.icpName.value = profile.name || '';
  el.icpRegions.value = (profile.regions || []).join(', ');
  el.icpRevenueThreshold.value = String(profile.revenueThreshold || 2500000);

  // Weight sliders
  const w = profile.weights || {};
  el.wTitleFit.value      = w.titleFit || 20;
  el.wCompanySize.value   = w.companySize || 15;
  el.wIndustry.value      = w.industry || 15;
  el.wTechSignals.value   = w.techSignals || 15;
  el.wAiFit.value         = w.aiFit || 10;
  el.wCompanyRevenue.value = w.companyRevenue || 25;

  // Target fields
  el.icpTargetTitles.value = (profile.targetTitles || []).join(', ');
  // Populate industry dropdowns
  targetIndustrySelect.setSelected(profile.targetIndustries || []);
  excludedIndustrySelect.setSelected(profile.excludedIndustries || []);

  updateWeightDisplay();
}

/**
 * Update the weight value labels and total badge.
 */
function updateWeightDisplay() {
  const vals = {
    titleFit:       parseInt(el.wTitleFit.value),
    companySize:    parseInt(el.wCompanySize.value),
    industry:       parseInt(el.wIndustry.value),
    techSignals:    parseInt(el.wTechSignals.value),
    aiFit:          parseInt(el.wAiFit.value),
    companyRevenue: parseInt(el.wCompanyRevenue.value),
  };

  el.wTitleFitVal.textContent      = vals.titleFit + '%';
  el.wCompanySizeVal.textContent   = vals.companySize + '%';
  el.wIndustryVal.textContent      = vals.industry + '%';
  el.wTechSignalsVal.textContent   = vals.techSignals + '%';
  el.wAiFitVal.textContent         = vals.aiFit + '%';
  el.wCompanyRevenueVal.textContent = vals.companyRevenue + '%';

  const total = Object.values(vals).reduce((a, b) => a + b, 0);
  el.icpWeightTotal.textContent = total + '%';
  el.icpWeightTotal.classList.toggle('invalid', total !== 100);
}

/**
 * Update the active ICP badge shown outside the collapsible.
 */
async function updateIcpActiveBadge() {
  const autoSwitch = await getIcpAutoSwitch();
  const activeId = await getActiveIcpId();
  const profile = icpProfiles.find(p => p.id === activeId) || icpProfiles[0];

  if (profile) {
    el.icpActiveName.textContent = profile.name;
    el.icpActiveReason.textContent = autoSwitch ? '· Auto-switch ON' : '· Manual';
  }
}

/**
 * Save the currently edited profile.
 */
async function handleIcpSave() {
  if (!editingProfileId) return;

  const profile = icpProfiles.find(p => p.id === editingProfileId);
  if (!profile) return;

  // Read values from the form
  profile.name = el.icpName.value.trim() || profile.name;
  profile.regions = el.icpRegions.value.split(',').map(s => s.trim()).filter(Boolean);
  profile.revenueThreshold = parseInt(el.icpRevenueThreshold.value) || 2500000;

  profile.weights = {
    titleFit:       parseInt(el.wTitleFit.value) || 0,
    companySize:    parseInt(el.wCompanySize.value) || 0,
    industry:       parseInt(el.wIndustry.value) || 0,
    techSignals:    parseInt(el.wTechSignals.value) || 0,
    aiFit:          parseInt(el.wAiFit.value) || 0,
    companyRevenue: parseInt(el.wCompanyRevenue.value) || 0,
  };

  const total = Object.values(profile.weights).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    toast(`Weights must total 100% (currently ${total}%)`, true);
    return;
  }

  profile.targetTitles = el.icpTargetTitles.value.split(',').map(s => s.trim()).filter(Boolean);
  profile.targetIndustries = targetIndustrySelect.getSelected();
  profile.excludedIndustries = excludedIndustrySelect.getSelected();

  await saveIcpProfile(profile);
  await loadIcpSettings();
  toast(`${profile.name} saved ✓`);
}

/**
 * Create a new ICP profile.
 */
async function handleIcpNew() {
  const newId = 'custom-' + Date.now();
  const newProfile = {
    id:        newId,
    name:      '✨ New Profile',
    isDefault: false,
    regions:   [],
    weights: {
      titleFit: 20, companySize: 15, industry: 15,
      techSignals: 15, aiFit: 10, companyRevenue: 25,
    },
    revenueThreshold: 2500000,
    tierThresholds: { hot: 80, warm: 50 },
    targetTitles: ['CEO', 'CTO', 'Founder', 'VP'],
    targetIndustries: ['SaaS', 'FinTech', 'Cloud'],
    adjacentIndustries: ['HealthTech', 'EdTech'],
    excludedIndustries: ['Government', 'Non-profit'],
  };

  await saveIcpProfile(newProfile);
  await setActiveIcpId(newId);
  await loadIcpSettings();
  toast('New profile created — edit and save it ✓');
}

/**
 * Delete the currently selected profile.
 */
async function handleIcpDelete() {
  if (!editingProfileId) return;

  const profile = icpProfiles.find(p => p.id === editingProfileId);
  if (profile?.isDefault) {
    toast('Cannot delete the default profile', true);
    return;
  }

  const deleted = await deleteIcpProfile(editingProfileId);
  if (!deleted) {
    toast('Cannot delete the last profile', true);
    return;
  }

  await loadIcpSettings();
  toast('Profile deleted ✓');
}

/* ================================================================= */
/*  Data Confidence Score                                            */
/* ================================================================= */

/**
 * Data field definitions with their weights.
 * Weights sum to 100 — matching the suggestion spec.
 */
const DATA_FIELDS = [
  { key: 'revenue',     weight: 25, domId: 'dcRevenue',     label: 'Revenue',      check: p => !!(p.companyRevenue) },
  { key: 'companySize', weight: 15, domId: 'dcCompanySize', label: 'Company Size', check: p => !!(p.companySize || p.size) },
  { key: 'industry',    weight: 15, domId: 'dcIndustry',    label: 'Industry',     check: p => !!(p.industry || p.specialties || (p.headline && p.headline.length > 10)) },
  { key: 'title',       weight: 15, domId: 'dcTitle',       label: 'Title',        check: p => !!(p.currentTitle || p.headline) },
  { key: 'experience',  weight: 10, domId: 'dcExperience',  label: 'Experience',   check: p => !!(p.experience && p.experience.length >= 1) },
  { key: 'location',    weight: 5,  domId: 'dcLocation',    label: 'Location',     check: p => !!(p.location) },
  { key: 'skills',      weight: 5,  domId: 'dcSkills',      label: 'Skills',       check: p => !!(p.skills && p.skills.length >= 1) },
  { key: 'about',       weight: 5,  domId: 'dcAbout',       label: 'About',        check: p => !!(p.about && p.about.length > 20) },
  { key: 'education',   weight: 5,  domId: 'dcEducation',   label: 'Education',    check: p => !!(p.education && p.education.length >= 1) },
];

/**
 * Compute data confidence score from scraped prospect data.
 *
 * @param  {Object}  prospect  Scraped data from content.js
 * @return {Object}  { score: 0-100, level: 'high'|'medium'|'low', fields: [...] }
 */
function computeDataConfidence(prospect) {
  if (!prospect) return { score: 0, level: 'low', fields: [] };

  let totalScore = 0;
  const fields = DATA_FIELDS.map(f => {
    const found = f.check(prospect);
    if (found) totalScore += f.weight;
    return { ...f, found };
  });

  let level = 'low';
  if (totalScore >= 70) level = 'high';
  else if (totalScore >= 40) level = 'medium';

  return { score: totalScore, level, fields };
}

/**
 * Render the data confidence badge and field grid.
 *
 * @param {Object} prospect  Scraped prospect data
 */
function renderDataConfidence(prospect) {
  const { score, level, fields } = computeDataConfidence(prospect);

  // Show the badge
  el.dataConfidence.hidden = false;
  el.dataConfidence.classList.remove('expanded'); // start collapsed

  // Value + animated progress
  el.dataConfidenceValue.textContent = score + '%';

  // Status label
  const statusLabels = { high: 'Reliable', medium: 'Partial', low: 'Low Data' };
  el.dataConfidenceStatus.textContent = statusLabels[level];
  el.dataConfidenceStatus.dataset.level = level;

  // Progress bar
  el.dataConfidenceFill.dataset.level = level;
  requestAnimationFrame(() => {
    el.dataConfidenceFill.style.width = score + '%';
  });

  // Field grid
  fields.forEach(f => {
    const fieldEl = el[f.domId];
    if (!fieldEl) return;

    const iconEl = fieldEl.querySelector('.dc-field__icon');
    if (f.found) {
      fieldEl.classList.add('found');
      fieldEl.classList.remove('missing');
      if (iconEl) iconEl.textContent = '✅';
    } else {
      fieldEl.classList.add('missing');
      fieldEl.classList.remove('found');
      if (iconEl) iconEl.textContent = '❌';
    }
  });
}

/* ================================================================= */
/*  Industry Multi-Select Dropdown Component                         */
/* ================================================================= */

class IndustrySelect {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.container   The .ind-select wrapper
   * @param {HTMLElement} opts.pillsWrap   The .ind-select__pills wrapper
   * @param {HTMLElement} opts.searchInput The search <input>
   * @param {HTMLElement} opts.listEl      The .ind-select__list container
   * @param {string}      opts.variant    'target' | 'excluded'
   */
  constructor({ container, pillsWrap, searchInput, listEl, variant }) {
    this.container = container;
    this.pillsWrap = pillsWrap;
    this.searchInput = searchInput;
    this.listEl = listEl;
    this.variant = variant;
    this.selected = new Set();

    if (variant === 'excluded') {
      container.classList.add('ind-select--excluded');
    }

    this._buildList();
    this._bindEvents();
  }

  /** Build the categorized checkbox list */
  _buildList() {
    this.listEl.innerHTML = '';
    for (const cat of INDUSTRY_CATALOG) {
      const catEl = document.createElement('div');
      catEl.className = 'ind-cat';
      catEl.textContent = cat.category;
      this.listEl.appendChild(catEl);

      for (const name of cat.items) {
        const item = document.createElement('div');
        item.className = 'ind-item';
        item.dataset.name = name;
        item.innerHTML = `
          <span class="ind-item__check"></span>
          <span class="ind-item__label">${name}</span>
        `;
        item.addEventListener('click', () => this._toggle(name));
        this.listEl.appendChild(item);
      }
    }
  }

  /** Bind search, focus, and outside-click events */
  _bindEvents() {
    // Open on click/focus
    this.pillsWrap.addEventListener('click', () => {
      this.container.classList.add('open');
      this.searchInput.focus();
    });

    // Search filter
    this.searchInput.addEventListener('input', () => this._filter());

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this.container.classList.remove('open');
        this.searchInput.value = '';
        this._filter();
      }
    });
  }

  /** Toggle an industry on/off */
  _toggle(name) {
    if (this.selected.has(name)) {
      this.selected.delete(name);
    } else {
      this.selected.add(name);
    }
    this._renderPills();
    this._updateListState();
  }

  /** Filter the dropdown list by search query */
  _filter() {
    const q = this.searchInput.value.toLowerCase().trim();
    const items = this.listEl.querySelectorAll('.ind-item');
    const cats = this.listEl.querySelectorAll('.ind-cat');

    // Track which categories have visible items
    const catVisibility = new Map();

    items.forEach(item => {
      const name = item.dataset.name.toLowerCase();
      const match = !q || name.includes(q);
      item.style.display = match ? '' : 'none';

      // Find the category this item belongs to
      let prevSibling = item.previousElementSibling;
      while (prevSibling && !prevSibling.classList.contains('ind-cat')) {
        prevSibling = prevSibling.previousElementSibling;
      }
      if (prevSibling) {
        if (!catVisibility.has(prevSibling)) catVisibility.set(prevSibling, false);
        if (match) catVisibility.set(prevSibling, true);
      }
    });

    cats.forEach(cat => {
      cat.style.display = catVisibility.get(cat) ? '' : 'none';
    });

    // Show "no results" if nothing matches
    const existing = this.listEl.querySelector('.ind-select__empty');
    if (existing) existing.remove();

    if (q && ![...items].some(i => i.style.display !== 'none')) {
      const empty = document.createElement('div');
      empty.className = 'ind-select__empty';
      empty.textContent = `No industries matching "${q}"`;
      this.listEl.appendChild(empty);
    }
  }

  /** Render selected pills in the pill container */
  _renderPills() {
    // Remove old pills
    this.pillsWrap.querySelectorAll('.ind-pill').forEach(p => p.remove());

    // Add new pills before the search input
    for (const name of this.selected) {
      const pill = document.createElement('span');
      pill.className = 'ind-pill';
      pill.innerHTML = `
        ${name}
        <button class="ind-pill__remove" type="button">&times;</button>
      `;
      pill.querySelector('.ind-pill__remove').addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggle(name);
      });
      this.pillsWrap.insertBefore(pill, this.searchInput);
    }
  }

  /** Update checkbox visual state in the list */
  _updateListState() {
    this.listEl.querySelectorAll('.ind-item').forEach(item => {
      const name = item.dataset.name;
      const isSelected = this.selected.has(name);
      item.classList.toggle('selected', isSelected);
      item.querySelector('.ind-item__check').textContent = isSelected ? '✓' : '';
    });
  }

  /** Get array of selected industry names */
  getSelected() {
    return [...this.selected];
  }

  /** Set selected industries (from saved profile) */
  setSelected(industries) {
    this.selected = new Set(industries || []);
    this._renderPills();
    this._updateListState();
  }
}

/* Initialize the two industry selectors */
const targetIndustrySelect = new IndustrySelect({
  container:   el.indSelectTarget,
  pillsWrap:   el.indPillsTarget,
  searchInput: el.indSearchTarget,
  listEl:      el.indListTarget,
  variant:     'target',
});

const excludedIndustrySelect = new IndustrySelect({
  container:   el.indSelectExcluded,
  pillsWrap:   el.indPillsExcluded,
  searchInput: el.indSearchExcluded,
  listEl:      el.indListExcluded,
  variant:     'excluded',
});
