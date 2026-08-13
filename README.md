# LeadQualify — AI Prospect Scorer

A Chrome extension (Manifest V3) that scores LinkedIn / Sales Navigator prospects
against your Ideal Customer Profile (ICP) and returns a 0–100 fit score, a
HOT / WARM / COLD tier, a per-dimension breakdown, and outreach suggestions.

Scoring runs on [Groq](https://groq.com) using your own free API key.

---

## How a score is produced

```
LinkedIn page
   │  content.js scrapes structured fields + a raw-text fallback
   ▼
Prospect data ──► resolveIcpProfile(location)  ── picks the ICP profile (auto by region, or manual)
   │
   ▼
icp-scorer.js builds the prompt ──► groq-engine.js cascade ──► GPT-OSS 120B / Qwen 3.6 27B / GPT-OSS 20B
   │                                                            (temperature 0, JSON mode)
   ▼
Model returns a per-category breakdown (score + reason + confidence)
   │
   ▼
overallScore = confidence-weighted average of the 6 category scores  ◄── computed in code, NOT by the model
tier         = derived from the ICP's HOT/WARM thresholds
```

### The six scoring dimensions

| Dimension | Default weight | What it measures |
|-----------|:---:|------------------|
| Title Fit | 20% | Seniority / decision-making power vs. your target titles |
| Company Size | 15% | Employee count band vs. your sweet spot |
| Industry | 15% | Semantic match to target / adjacent / excluded industries |
| Tech Signals | 15% | How tech-forward the company is *for its industry* |
| AI Fit | 10% | Relevance of / exposure to AI |
| Company Revenue | 25% | Estimated annual revenue vs. your threshold |

Weights are configurable per ICP profile and must total 100%. Region-based
profiles (e.g. North America vs. APAC) can carry different weights, revenue
thresholds, and tier cut-offs, and are auto-selected from the prospect's location.

### Why the overall score is trustworthy

The **model scores each category individually**; the **extension computes the
headline number itself** as a **confidence-weighted** average of those category
scores (`computeWeightedScore` in [icp-scorer.js](icp-scorer.js)) — each
category's ICP weight is scaled by how confident the model is in it (HIGH ×1,
MEDIUM ×0.6, LOW ×0.25). Combined with `temperature: 0`, this makes the result:

- **Reproducible** — the same prospect + same ICP yields the same score.
- **Auditable** — the total is a weighted function of the visible bars + their confidence.
- **Responsive** — moving a weight slider actually moves the score.
- **Low-data-aware** — categories the model is only guessing at (common in the
  list/batch view, where just the search card is available) are down-weighted,
  so a strong prospect isn't dragged to the mean by unknown revenue/size. Those
  scores are marked low-confidence and paired with the Qualifiable %.

The model's own suggested total is still kept as `modelSuggestedScore` for
debugging/transparency but is never shown as the score.

---

## Reliability engineering

- **JSON Object Mode** (`response_format: { type: 'json_object' }`) is set on
  every request, so the response is always syntactically valid JSON — no
  reliance on fragile markdown-fence stripping.
- **3-model cascade** — if a model hits a rate limit (429) or errors, the engine
  falls through to the next. Each model ID has its own free-tier quota.
  - Per-minute limits (RPM/TPM) disable a model for 60s; per-day limits
    (RPD/TPD) until midnight UTC. If all three are briefly blocked, it waits
    15s and retries (up to 2×).
- **Model longevity** — the cascade uses `openai/gpt-oss-120b`,
  `qwen/qwen3.6-27b`, and `openai/gpt-oss-20b`. The previous Llama models
  (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) are scheduled for Groq
  shutdown on **2026-08-16**; these are Groq's own recommended replacements.
- **Score cache** is versioned (`SCORING_VERSION`); changing the scoring logic
  auto-invalidates stale cached scores.

---

## Data Confidence — read this before trusting a score

Every result includes a **Data Confidence** meter (0–100%) showing how much of
the prospect's page data was actually captured (revenue, size, industry, title,
experience, etc.). **The fit score is only as good as this number.**

- **Reliable (≥70%)** — most key fields were found; the score rests on real data.
- **Partial (40–69%)** — several fields are inferred; treat the score as directional.
- **Low Data (<40%)** — the model is largely estimating; verify before acting.

---

## Limitations & honest caveats

- **Revenue is an estimate, not a fact.** Unless a revenue figure is printed on
  the page (common in Sales Navigator company cards), it is *inferred* from
  employee count, funding stage, company age, and tech stack. Treat it as a
  rough band, not a data point.
- **Scores reflect what's visible.** The scraper reads the current page. A
  sparse profile, or one where you haven't opened the Experience/About sections,
  yields less data and a lower-confidence score. Open the relevant tabs first.
- **The AI can be wrong.** Category reasons are the model's interpretation of
  the text, which can misread ambiguous headlines or niche industries. The
  `reason` and `confidence` on each bar exist so you can sanity-check.
- **Not a substitute for research.** Use this to *prioritize* a list, not to
  make final go/no-go calls on high-value accounts.
- **List (batch) scoring uses less data** than scoring an open profile — it only
  sees the search-card fields, so those scores are lower-confidence by design.
- **LinkedIn's DOM changes often.** Selectors have multiple fallbacks plus a
  raw-text fallback, but scraping can still miss fields after a LinkedIn update.

---

## Privacy & data handling

- Your Groq API key and all scores are stored **locally** via
  `chrome.storage.local`. Nothing is sent to any server except Groq.
- When you score a prospect, the scraped page data is sent to **Groq's API** for
  inference. Do not use this on data you're not permitted to send to a third
  party.
- The extension only runs on `linkedin.com` pages (see `host_permissions` /
  `content_scripts` in [manifest.json](manifest.json)).
- Respect LinkedIn's Terms of Service and applicable data-protection laws in
  your jurisdiction when scraping and processing profile data.

---

## Setup

1. Get a free Groq API key at <https://console.groq.com/keys>.
2. Load the extension: `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select this folder.
3. Open the side panel (click the toolbar icon), expand **API Key**, paste your
   key, and save.
4. Navigate to a LinkedIn profile, company, or Sales Navigator page and click
   **Score Prospect**.

## Configuration

- **ICP profiles** — create/edit profiles in the side panel's ICP settings:
  target titles, target/excluded industries, company-size fit, revenue
  threshold, and the six dimension weights.
- **Auto-switch by region** — when enabled, the profile whose `regions` match
  the prospect's location is used automatically; otherwise the manually selected
  profile applies.

## Testing

The deterministic scoring layer is covered by a zero-dependency test suite
(Node's built-in runner — no `npm install` needed):

```bash
npm test          # or: node --test "test/**/*.test.js"
```

Tests live in [test/scoring.test.js](test/scoring.test.js) and cover the pure,
reproducible logic: `computeWeightedScore` (weighting, normalization,
missing-data defaults, clamping), `deriveTier` (threshold boundaries),
`parseResponse` (fence/`<think>` stripping, clamping, validation), plus `clamp`
and `formatMoney`. The Groq API call and DOM scraping are out of scope — they
require a browser and network.

## Project layout

| File | Responsibility |
|------|----------------|
| [manifest.json](manifest.json) | MV3 manifest, permissions, content-script matches |
| [background.js](background.js) | Service worker: side panel + badge |
| [content.js](content.js) | LinkedIn / Sales Navigator page scrapers |
| [icp-scorer.js](icp-scorer.js) | Prompt builder, response parser, **deterministic scoring** |
| [groq-engine.js](groq-engine.js) | 3-model Groq cascade, rate-limit handling, JSON mode |
| [storage-manager.js](storage-manager.js) | API key, rate-limit flags, score cache, ICP profiles |
| [popup.js](popup.js) / [popup.html](popup.html) / [popup.css](popup.css) | Side-panel UI |
