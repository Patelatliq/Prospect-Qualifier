/**
 * icp-scorer.js — ICP Prompt Builder + Response Parser
 *
 * Builds the system + user messages for prospect scoring,
 * sends them through the cascade engine, and parses the
 * structured JSON response.
 *
 * Now supports dynamic ICP profiles — the system prompt is
 * generated from whichever profile is active/auto-selected.
 */

import { scoreWithCascade } from './groq-engine.js';

/* ------------------------------------------------------------------ */
/*  Industry synonym/alias map                                        */
/* ------------------------------------------------------------------ */

/**
 * Maps industry names → related terms the AI should treat as equivalent.
 * Keys are normalized (lowercase). When a user types "Legal Services"
 * in their ICP, the code auto-expands it so the AI also recognizes
 * "law firm", "attorney", "legal tech", etc.
 */
const INDUSTRY_ALIASES = {
  // Tech
  'saas':              ['software-as-a-service', 'cloud software', 'subscription software', 'hosted platform', 'web application', 'software platform'],
  'cloud':             ['cloud computing', 'cloud infrastructure', 'IaaS', 'PaaS', 'cloud services', 'AWS', 'Azure', 'GCP'],
  'dev-tools':         ['developer tools', 'devops', 'developer platform', 'code tools', 'IDE', 'CI/CD', 'developer experience'],
  'ai/ml':             ['artificial intelligence', 'machine learning', 'deep learning', 'data science', 'NLP', 'computer vision', 'generative AI', 'LLM'],
  'cybersecurity':     ['security', 'infosec', 'information security', 'cyber defense', 'network security', 'identity management', 'zero trust'],

  // Finance
  'fintech':           ['financial technology', 'payments', 'banking tech', 'digital banking', 'neobank', 'lending platform', 'wealth management', 'financial services technology', 'regtech', 'blockchain', 'crypto', 'DeFi'],
  'insurtech':         ['insurance technology', 'digital insurance', 'insurance platform', 'claims tech'],
  'financial services': ['banking', 'investment', 'asset management', 'capital markets', 'hedge fund', 'private equity', 'venture capital', 'wealth management'],

  // Health
  'healthtech':        ['healthcare technology', 'digital health', 'health IT', 'medical devices', 'telemedicine', 'telehealth', 'health informatics', 'clinical tech', 'pharma tech', 'biotech'],
  'biotech':           ['biotechnology', 'pharmaceutical', 'pharma', 'life sciences', 'genomics', 'drug development'],

  // Commerce
  'e-commerce':        ['online retail', 'digital commerce', 'marketplace', 'D2C', 'direct-to-consumer', 'retail technology', 'online store', 'shopify', 'e-tail'],
  'retail':            ['retail technology', 'brick-and-mortar', 'omnichannel', 'point of sale', 'POS', 'consumer goods', 'CPG'],

  // Professional Services
  'consulting':        ['management consulting', 'strategy consulting', 'advisory', 'professional services', 'business consulting', 'IT consulting', 'digital consulting', 'transformation consulting'],
  'legal services':    ['law', 'law firm', 'legal tech', 'legaltech', 'attorney', 'counsel', 'legal consulting', 'compliance', 'corporate law', 'IP law', 'litigation', 'legal practice', 'paralegal', 'legal advisory'],
  'professional services': ['services firm', 'advisory firm', 'consulting firm', 'accounting firm', 'audit', 'tax services', 'staffing'],
  'accounting':        ['CPA', 'audit', 'tax', 'bookkeeping', 'financial audit', 'accounting firm', 'chartered accountant'],

  // Education
  'edtech':            ['education technology', 'e-learning', 'online education', 'LMS', 'learning platform', 'courseware', 'online courses', 'ed-tech', 'learning management'],

  // Marketing
  'martech':           ['marketing technology', 'digital marketing', 'ad tech', 'advertising technology', 'marketing automation', 'CRM', 'email marketing', 'SEO', 'content marketing'],
  'media':             ['digital media', 'publishing', 'content', 'entertainment', 'streaming', 'news media', 'advertising', 'broadcasting'],

  // Real Estate
  'real estate':       ['property', 'proptech', 'real estate technology', 'property management', 'commercial real estate', 'residential real estate', 'REIT'],
  'real estate tech':  ['proptech', 'property technology', 'real estate platform', 'property management software'],

  // Logistics & Supply Chain
  'logistics':         ['supply chain', 'freight', 'shipping', 'warehousing', 'transportation', 'fleet management', 'last mile delivery', '3PL', 'fulfillment'],
  'supply chain':      ['logistics', 'procurement', 'warehouse management', 'inventory management', 'distribution'],

  // HR & Recruiting
  'recruitment tech':  ['HR tech', 'hiring platform', 'talent acquisition', 'staffing technology', 'ATS', 'applicant tracking', 'job board', 'recruiting'],
  'hr tech':           ['human resources technology', 'people management', 'HRIS', 'payroll', 'benefits platform', 'workforce management', 'employee engagement'],

  // Industry Verticals
  'manufacturing':     ['industrial', 'factory', 'production', 'industrial IoT', 'smart manufacturing', 'industry 4.0'],
  'construction':      ['building', 'construction tech', 'contech', 'architecture', 'engineering', 'BIM', 'project management'],
  'energy':            ['cleantech', 'renewable energy', 'oil & gas', 'solar', 'wind', 'energy tech', 'utilities', 'power'],
  'agriculture':       ['agritech', 'farming', 'ag-tech', 'precision agriculture', 'food tech', 'agribusiness'],
  'automotive':        ['auto tech', 'mobility', 'EV', 'electric vehicles', 'connected cars', 'autonomous driving'],
  'telecom':           ['telecommunications', 'telco', 'wireless', 'broadband', 'network', 'communications'],
  'hospitality':       ['hotel', 'travel tech', 'tourism', 'restaurant tech', 'food service', 'travel'],
  'gaming':            ['game development', 'game studio', 'esports', 'interactive entertainment', 'game tech'],
  'non-profit':        ['NGO', 'charity', 'social enterprise', 'foundation', 'philanthropy'],
  'government':        ['public sector', 'gov tech', 'federal', 'municipal', 'state agency', 'defense'],
  'academia':          ['university', 'college', 'research institution', 'higher education', 'academic research'],

  // Dropdown-format name aliases (match names from INDUSTRY_CATALOG in popup.js)
  'cloud computing':   ['cloud', 'cloud infrastructure', 'IaaS', 'PaaS', 'cloud services', 'AWS', 'Azure', 'GCP'],
  'ai / machine learning': ['artificial intelligence', 'machine learning', 'deep learning', 'data science', 'NLP', 'generative AI', 'LLM'],
  'data analytics':    ['business intelligence', 'BI', 'data engineering', 'analytics platform', 'data warehouse'],
  'software development': ['software engineering', 'app development', 'custom software', 'software agency'],
  'it services':       ['managed services', 'IT outsourcing', 'IT support', 'systems integration', 'IT infrastructure'],
  'banking':           ['commercial banking', 'retail banking', 'digital banking', 'neobank', 'banking technology'],
  'insurance':         ['insurance company', 'insurance broker', 'underwriting', 'claims', 'reinsurance'],
  'payments':          ['payment processing', 'payment gateway', 'digital payments', 'mobile payments', 'point of sale'],
  'telemedicine':      ['telehealth', 'virtual care', 'remote patient monitoring', 'digital clinic'],
  'pharmaceutical':    ['pharma', 'drug development', 'drug manufacturing', 'clinical trials'],
  'medical devices':   ['medtech', 'medical equipment', 'medical instruments', 'diagnostic devices'],
  'digital health':    ['health tech', 'health app', 'wellness tech', 'patient engagement'],
  'd2c (direct to consumer)': ['D2C', 'direct to consumer', 'DTC brand', 'online brand'],
  'marketplace':       ['online marketplace', 'two-sided marketplace', 'platform marketplace', 'peer-to-peer'],
  'legal tech':        ['legal technology', 'law tech', 'legal automation', 'contract management', 'legal AI'],
  'law firm':          ['law practice', 'legal practice', 'attorney firm', 'legal office', 'counsel'],
  'management consulting': ['strategy consulting', 'business advisory', 'corporate consulting'],
  'staffing & recruiting': ['recruitment', 'talent acquisition', 'headhunting', 'temp staffing', 'RPO'],
  'proptech':          ['property technology', 'real estate technology', 'real estate platform'],
  'commercial real estate': ['CRE', 'office space', 'commercial property', 'industrial real estate'],
  'e-learning':        ['online learning', 'virtual classroom', 'distance learning', 'MOOC'],
  'digital marketing': ['online marketing', 'growth marketing', 'performance marketing', 'SEM', 'SEO'],
  'ad tech':           ['advertising technology', 'programmatic', 'ad exchange', 'DSP', 'SSP'],
  'media & entertainment': ['media company', 'entertainment', 'content platform', 'digital media'],
  'industrial iot':    ['IIoT', 'industry 4.0', 'smart factory', 'connected manufacturing'],
  'freight & shipping': ['freight', 'shipping', 'cargo', 'ocean freight', 'air freight', 'trucking'],
  'fleet management':  ['vehicle management', 'telematics', 'fleet tracking', 'fleet optimization'],
  'renewable energy':  ['solar energy', 'wind energy', 'green energy', 'sustainable energy'],
  'ev & electric vehicles': ['electric vehicles', 'EV', 'EV charging', 'electric mobility'],
  'restaurants':       ['restaurant chain', 'food service', 'dining', 'restaurant tech', 'QSR', 'fast food'],
  'food & beverage':   ['F&B', 'food industry', 'beverage industry', 'food manufacturing', 'food brand'],
  'food tech':         ['food technology', 'food delivery', 'meal kit', 'food innovation', 'alt protein'],
  'hotels & hospitality': ['hotel', 'hotel chain', 'hospitality', 'resort', 'hotel management', 'hotel tech'],
  'travel & tourism':  ['travel', 'tourism', 'travel tech', 'online travel', 'booking platform', 'travel agency'],
  'agritech':          ['agriculture technology', 'farming tech', 'precision farming', 'smart agriculture'],
  'hr tech':           ['human resources technology', 'HRIS', 'payroll', 'people management', 'workforce management'],
  'sports tech':       ['sports technology', 'sports analytics', 'athlete management', 'fan engagement'],
  'fitness tech':      ['fitness technology', 'workout app', 'health & fitness', 'gym tech', 'wearables'],
};

/**
 * Takes a list of industry names from the user's ICP and expands each
 * into a rich string with synonyms, so the AI can semantically match.
 *
 * Example:
 *   Input:  ['SaaS', 'Legal Services']
 *   Output: 'SaaS (also: software-as-a-service, cloud software, subscription software, ...),
 *            Legal Services (also: law, law firm, legal tech, attorney, counsel, ...)'
 *
 * Industries without a known alias map are passed through as-is.
 *
 * @param  {string[]} industries  Array of industry names
 * @return {string}               Expanded comma-separated string
 */
function expandIndustryList(industries) {
  if (!industries?.length) return '';

  return industries.map(ind => {
    const key = ind.toLowerCase().trim();
    const aliases = INDUSTRY_ALIASES[key];
    if (aliases?.length) {
      return `${ind} (also: ${aliases.join(', ')})`;
    }
    return ind;
  }).join(', ');
}

/* ------------------------------------------------------------------ */
/*  Dynamic system prompt builder                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the system prompt from an ICP profile config.
 * If no profile is passed, uses sensible hardcoded defaults.
 *
 * @param {Object} [icp]  ICP profile object from storage-manager
 * @return {string}       Complete system prompt
 */
function buildSystemPrompt(icp) {
  // Fallback defaults if no profile provided
  const w = icp?.weights || {
    titleFit: 20, companySize: 15, industry: 15,
    techSignals: 15, aiFit: 10, companyRevenue: 25,
  };

  const revThreshold = icp?.revenueThreshold || 2_500_000;
  const revFormatted = formatMoney(revThreshold);
  const revHalf      = formatMoney(revThreshold / 2.5);  // lower tier
  const revDouble    = formatMoney(revThreshold * 2);
  const revQuad      = formatMoney(revThreshold * 4);

  const tierHot  = icp?.tierThresholds?.hot  ?? 80;
  const tierWarm = icp?.tierThresholds?.warm ?? 50;

  const targetTitles     = icp?.targetTitles?.join(', ')     || 'CEO, CTO, Founder, Co-Founder, VP, Director, Head of';

  const profileLabel = icp?.name || 'Default ICP';

  // Build a clean numbered list of target industries with synonyms
  const targetIndList = (icp?.targetIndustries || ['SaaS', 'Cloud', 'FinTech', 'E-commerce', 'Dev-tools']).map((ind, i) => {
    const key = ind.toLowerCase().trim();
    const aliases = INDUSTRY_ALIASES[key];
    if (aliases?.length) {
      return `   ${i + 1}. ${ind} — also matches: ${aliases.slice(0, 6).join(', ')}`;
    }
    return `   ${i + 1}. ${ind}`;
  }).join('\n');

  const adjacentIndList = (icp?.adjacentIndustries || ['HealthTech', 'EdTech', 'MarTech']).map((ind, i) => {
    const key = ind.toLowerCase().trim();
    const aliases = INDUSTRY_ALIASES[key];
    if (aliases?.length) {
      return `   ${i + 1}. ${ind} — also matches: ${aliases.slice(0, 4).join(', ')}`;
    }
    return `   ${i + 1}. ${ind}`;
  }).join('\n');

  const excludedInd = icp?.excludedIndustries?.join(', ') || 'Government, Non-profit, Academia';

  return `You are an expert B2B sales intelligence analyst. Your job is to evaluate a prospect and score them against a custom Ideal Customer Profile (ICP).

ACTIVE ICP PROFILE: ${profileLabel}

IMPORTANT: Carefully analyze ALL provided data including the raw page text. The raw page text often contains critical information (like "Founder & CEO", company details, experience history) that may not appear in the structured fields. Extract and use EVERY relevant signal.

SCORING CRITERIA (each scored 0-100):

1. TITLE FIT (weight ${w.titleFit}%)
   - Target titles (${targetTitles}): 90-100  ← HIGHEST PRIORITY
   - C-suite / VP / Director (decision-maker): 80-95
   - Senior Manager / Head of / Lead (influencer): 60-79
   - Manager / Senior IC: 40-59
   - Junior IC / irrelevant role: 0-39

2. COMPANY SIZE (weight ${w.companySize}%)
   - Mid-market 200-2 000 employees: 80-100
   - Enterprise 2 000+: 60-79
   - Growth-stage 50-200: 50-69
   - Small <50: 20-49
   - Unknown: 40

3. INDUSTRY FIT (weight ${w.industry}%)

   ★ TARGET INDUSTRIES (the user chose these — score 80-100 if matched):
${targetIndList}

   Adjacent industries (score 60-79):
${adjacentIndList}

   Excluded / Non-fit (score 0-39): ${excludedInd}
   General B2B not in any list: 40-59

   ★★★ MANDATORY INDUSTRY MATCHING RULES ★★★
   Rule 1: If the prospect's company, role, or industry matches ANY target industry above (by name OR synonym), the industry score MUST be 80 or higher. No exceptions.
   Rule 2: Use SEMANTIC matching. "Law Office" = "Legal Services". "Restaurant chain" = "Restaurants". "Hotel group" = "Hospitality". Match by MEANING.
   Rule 3: If a prospect works across multiple industries and ANY ONE is a target industry, score 80+.
   Rule 4: NEVER score a target industry match below 80. The user explicitly chose these industries as their ideal customers.

4. TECHNOLOGY SIGNALS (weight ${w.techSignals}%)
   Evaluate how tech-forward the company is FOR ITS OWN INDUSTRY:
   - Uses modern software, digital tools, cloud platforms, or has a tech-enabled business model: 70-100
   - Has a website, uses standard business software, some digital presence: 40-69
   - Traditional/offline business with minimal technology adoption: 0-39
   NOTE: A law firm using legal tech software IS tech-forward. A restaurant using POS systems and online ordering IS tech-forward. Evaluate relative to their industry, not against a tech company standard.

5. AI FIT (weight ${w.aiFit}%)
   Evaluate the company's relevance to AI/automation FOR ITS INDUSTRY:
   - Actively uses or could benefit from AI, automation, or data-driven tools: 70-100
   - Industry is being disrupted by AI (healthcare, legal, finance, hospitality, real estate): 50-69
   - Traditional business with low AI relevance: 0-49
   NOTE: Every industry has AI opportunities. Legal = AI contract review. Healthcare = AI diagnostics. Restaurants = AI ordering. Real estate = AI valuations. Evaluate potential, not just current usage.

6. COMPANY REVENUE (weight ${w.companyRevenue}%) ← KEY QUALIFYING CRITERION
   - Revenue over ${revQuad}+: 90-100 (enterprise-grade, high-value prospect)
   - Revenue ${revDouble}–${revQuad}: 75-89 (strong, solid budget)
   - Revenue ${revFormatted}–${revDouble}: 60-74 (meets minimum qualifying threshold)
   - Revenue ${revHalf}–${revFormatted}: 30-59 (below qualifying threshold)
   - Revenue under ${revHalf} or unknown: 0-29 (unlikely to have budget)
   IMPORTANT: The qualifying threshold is ${revFormatted}. Estimate revenue from: employee count, funding, company description, industry context, growth signals, and any explicit revenue mentions. If revenue cannot be estimated, score 35.

OVERALL SCORE = weighted average rounded to nearest integer.

TIER:
  HOT  (${tierHot}-100) — high-priority prospect
  WARM (${tierWarm}-${tierHot - 1})  — worth pursuing
  COLD (0-${tierWarm - 1})   — low priority

YOU MUST respond with ONLY valid JSON in this exact shape — no markdown, no explanation:
{
  "overallScore": <int 0-100>,
  "tier": "HOT" | "WARM" | "COLD",
  "breakdown": {
    "titleFit":     { "score": <int>, "reason": "<one sentence>" },
    "companySize":  { "score": <int>, "reason": "<one sentence>" },
    "industry":     { "score": <int>, "reason": "<one sentence>" },
    "techSignals":  { "score": <int>, "reason": "<one sentence>" },
    "aiFit":        { "score": <int>, "reason": "<one sentence explaining AI relevance for this specific industry>" },
    "companyRevenue":{ "score": <int>, "reason": "<one sentence explaining estimated revenue vs ${revFormatted} threshold>" }
  },
  "summary": "<2-3 sentence actionable summary>",
  "approachSuggestion": "<1 sentence recommended outreach angle>",
  "decisionMaker": {
    "level": "FOUNDER" | "C_SUITE" | "VP_DIRECTOR" | "MANAGER" | "IC" | "UNKNOWN",
    "isFounder": <boolean>,
    "canSignCheck": <boolean - true if likely has budget authority>,
    "title": "<their exact current title as found in the data>"
  },
  "keyInsights": [
    "<insight 1: notable career pattern, domain expertise, or relevant signal>",
    "<insight 2>",
    "<insight 3>"
  ],
  "redFlags": ["<any concerns or reasons this might not be a good fit>"],
  "talkingPoints": [
    "<personalized talking point based on their background>",
    "<another talking point>"
  ],
  "experienceSummary": {
    "totalYearsEstimate": <int or null>,
    "currentRole": "<current title at current company>",
    "currentCompany": "<company name>",
    "previousNotableRoles": ["<role at company>"],
    "industryExperience": ["<industry 1>", "<industry 2>"]
  }
}`;
}

/**
 * Format a dollar amount to a human-readable string.
 * e.g. 2500000 → "$2.5M", 500000 → "$500K", 10000000 → "$10M"
 */
function formatMoney(n) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

/* ------------------------------------------------------------------ */
/*  Build user message from scraped prospect data                     */
/* ------------------------------------------------------------------ */

function buildUserMessage(prospect) {
  const lines = [];

  // Data availability signals — tell the AI what was found vs missing
  const dataFlags = [];
  if (prospect.companyRevenue)  dataFlags.push('Revenue: FOUND');
  else                          dataFlags.push('Revenue: NOT FOUND — you must estimate');
  if (prospect.companySize || prospect.size)
    dataFlags.push('Company Size: FOUND');
  else dataFlags.push('Company Size: NOT FOUND');
  if (prospect.currentTitle || prospect.headline)
    dataFlags.push('Title: FOUND');
  else dataFlags.push('Title: NOT FOUND');
  if (prospect.industry || prospect.specialties)
    dataFlags.push('Industry: FOUND');
  else dataFlags.push('Industry: NOT FOUND — infer from context');

  lines.push('DATA AVAILABILITY (fields marked NOT FOUND must be estimated — lower your confidence):');
  lines.push(dataFlags.join(' | '));
  lines.push('');

  if (prospect.type === 'profile') {
    lines.push('PROSPECT PROFILE:');
    if (prospect.name)     lines.push(`Name: ${prospect.name}`);
    if (prospect.headline) lines.push(`Headline: ${prospect.headline}`);
    if (prospect.currentTitle)   lines.push(`Current Title: ${prospect.currentTitle}`);
    if (prospect.currentCompany) lines.push(`Current Company: ${prospect.currentCompany}`);
    if (prospect.companyRevenue)  lines.push(`Company Revenue: ${prospect.companyRevenue}`);
    if (prospect.companySize)     lines.push(`Company Size: ${prospect.companySize}`);
    if (prospect.location) lines.push(`Location: ${prospect.location}`);
    if (prospect.connectionDegree) lines.push(`Connection Degree: ${prospect.connectionDegree}`);
    if (prospect.mutualConnections) lines.push(`Mutual Connections: ${prospect.mutualConnections}`);
    if (prospect.about)    lines.push(`About: ${prospect.about}`);

    if (prospect.experience?.length) {
      lines.push('', 'EXPERIENCE:');
      prospect.experience.forEach((e) => {
        let line = `- ${e.title}`;
        if (e.company)  line += ` at ${e.company}`;
        if (e.duration) line += ` (${e.duration})`;
        lines.push(line);
      });
    }

    if (prospect.education?.length) {
      lines.push('', 'EDUCATION:');
      prospect.education.forEach((e) => {
        let line = `- ${e.school}`;
        if (e.degree) line += ` — ${e.degree}`;
        lines.push(line);
      });
    }

    if (prospect.skills?.length) {
      lines.push('', `SKILLS: ${prospect.skills.join(', ')}`);
    }

    // Always include raw page text for AI to extract additional context
    if (prospect.rawPageText) {
      lines.push('', 'RAW PAGE TEXT (extract ALL relevant info including titles, companies, dates, and any details not captured above):', prospect.rawPageText);
    }

  } else if (prospect.type === 'company') {
    lines.push('COMPANY PROFILE:');
    if (prospect.companyName)  lines.push(`Company: ${prospect.companyName}`);
    if (prospect.industry)        lines.push(`Industry: ${prospect.industry}`);
    if (prospect.size)            lines.push(`Size: ${prospect.size}`);
    if (prospect.companyRevenue)  lines.push(`Company Revenue: ${prospect.companyRevenue}`);
    if (prospect.description)     lines.push(`Description: ${prospect.description}`);
    if (prospect.specialties)     lines.push(`Specialties: ${prospect.specialties}`);

    if (prospect.rawPageText) {
      lines.push('', 'RAW PAGE TEXT (extract what you can):', prospect.rawPageText);
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Parse the AI response                                             */
/* ------------------------------------------------------------------ */

function parseResponse(raw) {
  let cleaned = raw.trim();

  // Strip accidental markdown fences
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```'))     cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```'))       cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Strip Qwen <think> blocks (belt-and-suspenders — engine already strips)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const parsed = JSON.parse(cleaned);

  // Validate essentials
  if (typeof parsed.overallScore !== 'number') throw new Error('Missing overallScore');
  if (!parsed.tier)      throw new Error('Missing tier');
  if (!parsed.breakdown) throw new Error('Missing breakdown');

  // Clamp scores 0-100
  parsed.overallScore = clamp(parsed.overallScore);
  for (const cat of Object.values(parsed.breakdown)) {
    if (cat && typeof cat.score === 'number') cat.score = clamp(cat.score);
  }

  return parsed;
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Score a prospect against the ICP.
 *
 * @param  {Object}  prospectData  Output from content.js scraper
 * @param  {Object}  [icpProfile]  ICP profile config (from resolveIcpProfile)
 * @return {Object}  Parsed score + metadata (modelUsed, cascadeAttempts, timestamp, icpProfileUsed)
 */
export async function scoreProspect(prospectData, icpProfile = null) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(icpProfile) },
    { role: 'user',   content: buildUserMessage(prospectData) },
  ];

  const cascade = await scoreWithCascade(messages);
  const score   = parseResponse(cascade.result);

  return {
    ...score,
    modelUsed:       cascade.modelUsed,
    cascadeAttempts: cascade.cascadeAttempts,
    icpProfileUsed:  icpProfile?.name || 'Default',
    timestamp:       Date.now(),
  };
}
