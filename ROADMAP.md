# LeadQualify — Reliability & Credibility Roadmap

> **Goal:** turn this from a working prototype into a tool a sales team can *rely on* — accurate, honest about its uncertainty, resilient when LinkedIn changes, and safe to operate — while staying **free-tier only** and keeping LinkedIn-ToS/ban risk low.
>
> **Scope decision (open):** starts as an **internal AtliQ tool**; may go **public** later. Items that only matter for public distribution are tagged `[public-only]`.

**Status:** v1.1 · 2026-07-24
**Owner:** Jay (Patelatliq)
**Priorities (all in scope):** Scoring accuracy & trust · Scraping robustness · Real data quality · Production hardening
**Research basis:** fact-verification workflow `w3p3egaum` — **8/8 claims CONFIRMED** against primary sources.

---

## Legend

- `[ ]` todo · `[~]` partial · `[x]` done
- Priority tags: `[Risk]` `[Robust]` `[Accuracy]` `[Data]` `[Harden]` · `[public-only]`
- Effort: `S` (<½ day) · `M` (½–2 days) · `L` (>2 days)
- Fact confidence: ✅ **verified** (primary source, `w3p3egaum`) · 📎 primary-source, not independently re-verified

---

## 0. The strategic anchor — "the mutual point"

**Reposition from a "scraper/automation tool" to a human-in-the-loop *reading assistant* for the page the rep is already viewing — and never automate actions or navigation.**

Keeps the value (score any prospect in front of you against your ICP) while shedding the risk that lives in *automation and volume*. Co-pilot, not crawler.

### Non-negotiable guardrails (architectural invariants — must not regress)

- [x] `[Risk]` **Human-triggered only.** No auto-navigation/scroll/open/connect/message.
- [x] `[Risk]` **Zero requests to LinkedIn.** Reads already-rendered DOM only; network calls go to the LLM (+ future whitelisted public data APIs), never a `linkedin.com` fetch.
- [x] `[Risk]` **No `web_accessible_resources`.** Confirmed ✅ this is what keeps the extension invisible to LinkedIn's *Active Extension Detection* (it probes WAR files by known ID). None declared — keep it that way.
- [x] `[Risk]` **UI lives in the side panel, never injected into the LinkedIn page.** Confirmed ✅ LinkedIn's second detector, *"Spectroscopy,"* walks the page DOM for any `chrome-extension://` URL. Current side-panel design writes nothing into the page → invisible. **Never** inject an in-page panel, and never let a `chrome.runtime.getURL()` / `chrome-extension://` string reach the LinkedIn DOM (inline any asset as a `data:` URI).
- [x] `[Risk]` **Scraped text is untrusted data, never instructions** — nonce `[DATA-<nonce>]` fence + `neutralizeInjection` + `escapeHtml` on model output.
- [x] `[Risk]` **Data minimization** — cache scores + small derived fields only, never raw profiles; LRU-capped.
- [x] `[Risk]` Guardrails codified in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Phase 0 — Compliance & safety foundation ✅ *done*

- [x] `[Risk][Accuracy]` **Prompt-injection defense** — nonce fence + neutralization + system-prompt guard. [icp-scorer.js](icp-scorer.js)
- [x] `[Risk][Harden]` **Cache eviction** (LRU, cap 500). [storage-manager.js](storage-manager.js)
- [x] `[Risk]` **First-run acceptable-use gate** with disclosure text. [popup.html](popup.html)/[popup.js](popup.js)
- [~] `[Risk][public-only]` **Prominent data disclosure** — in-product notice done; a hosted **privacy policy + Limited Use compliance statement** still required *before Web Store submission* (see Phase 5).
- [x] `[Risk]` **Codify invariants** — [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Phase 1 — Scrape reliability `(next up — biggest remaining reliability gap)`

- [ ] `[Robust][Accuracy]` **Scrape-quality gate** — compute completeness *before* scoring; warn ("open About/Experience", "page still loading") instead of scoring near-empty data. `M`
- [ ] `[Robust]` **SPA-navigation refresh** — re-scrape when the rep navigates profiles with the panel open (content script runs once at `document_idle`; panel only re-scrapes on its own open). `M`
- [ ] `[Robust][Harden]` **Centralize selectors** into one versioned config + a self-check logging which selectors matched/missed (early warning on LinkedIn DOM changes). `M`
- [ ] `[Robust][Accuracy]` **Field provenance** — tag each field `direct`/`from-rawtext`/`missing`. `M`
- [ ] `[Robust]` Surface silent caps ("showing first 25 of N"). `S`

---

## Phase 2 — Scoring accuracy & trust ✅ *core done*

- [x] `[Accuracy]` **Qualifiable %** badge — `Σ(weight × evidenceFactor)/Σweight` + justification naming weak heavy inputs. [icp-scorer.js](icp-scorer.js)/[popup.js](popup.js)
- [x] `[Accuracy]` **Two-number rule** — score always paired with confidence.
- [x] `[Accuracy][Data]` **Revenue honesty** — `enforceEvidenceHonesty` caps guessed-revenue confidence + annotates "(estimated)".
- [x] `[Accuracy]` **Confidence-weighted overall score** (low-data-aware) — categories the model is unsure about are down-weighted (HIGH ×1 / MED ×0.6 / LOW ×0.25), so list-view scores differentiate instead of collapsing to ~55. List rows sort by score, mark low-confidence, and show a card-only-estimate note.
- [x] `[Harden][Accuracy]` **Truncation detection** — `finish_reason:'length'` → fail over. [groq-engine.js](groq-engine.js)
- [ ] `[Accuracy]` **Label-free eval harness** — hand-rate ~25 prospects once → automated tier-agreement + rank-correlation on every prompt/model change (LLM-as-judge is an accepted no-ground-truth method 📎). `M`
- [ ] `[Accuracy]` **Cross-model agreement signal** — lower confidence when two cascade models disagree sharply. `M`

---

## Phase 3 — Data quality within the free tier `(verified — ready to spec)`

**Revenue reality:** ✅ OpenCorporates has **no** revenue/employee data (registration only) → not useful here. SEC EDGAR is the one real free source, but public-filers-only.

- [ ] `[Data]` **SEC EDGAR revenue for US public companies** — ✅ free, no key; revenue via `companyconcept`/`companyfacts` XBRL. Hard constraints from verification:
  - **Call from the background service worker only** — `data.sec.gov` sends **no CORS headers**; a `host_permissions: "https://data.sec.gov/*"` grant lets the SW fetch it, a content-script fetch is blocked. `M`
  - **User-Agent** is required (`"Company contact@email.com"`, else HTTP 403) but is a *forbidden fetch header* → set it via `declarativeNetRequest`, or accept Chrome's default UA and watch for 403s.
  - Needs **company-name → CIK resolution** first (endpoints key on CIK); try multiple revenue tags (`RevenueFromContractWithCustomerExcludingAssessedTax`, `Revenues`, …), take latest FY.
  - Throttle under 10 req/s. **Coverage caveat:** US SEC filers + foreign SEC filers only — most SMB/private/non-US prospects have no data. Best-effort layer with graceful fallback, **not** the primary source.
- [ ] `[Data][Accuracy]` **Industry-keyed revenue-per-employee table** — ✅ a flat multiplier is unsafe (industry spread >100×). Ship a small **static JSON** (NYU Stern/Damodaran per-industry values, sanity-checked to drop artifact rows), keyed off the LinkedIn "Industry" field; anchor B2B/SaaS on the **SaaS median ~$130k/FTE** (a true median) rather than the mega-cap-skewed ~$111k all-sector average. Present a **band**, never a point estimate. No API calls. `M` — [icp-scorer.js:REVENUE ESTIMATION](icp-scorer.js)
- [ ] `[Data]` Evaluate `company_dns` (Apache-2.0; EDGAR + Wikidata + SIC) as a self-hostable enrichment source 📎 (safety-review before adopting). `M`
- [ ] `[Data]` De-emphasize precise revenue in the ICP default (coarse band / lower weight); lean on reliably-scrapeable signals (title, size band, industry, tech). `S`
- [ ] `[Harden]` Cache company-level enrichment. `S`

> Enrichment lookups hit SEC/Wikidata — **not** LinkedIn — so they add zero LinkedIn ban risk.

---

## Phase 4 — Production hardening `(verified)`

- [ ] `[Harden]` **Second free LLM provider (BYOK) behind a provider adapter** so a Groq outage doesn't zero out scoring. ✅ verified: CORS is a non-issue from the **service worker** + `host_permissions`; the real risk is **key-in-client** → **BYOK** (user pastes their own free key into `chrome.storage.local`, route all LLM calls through the SW; content script never holds the key). Recommended chain: **Groq → Gemini `gemini-2.5-flash-lite`** (best structured output via `responseSchema`, ~1000 req/day free) **→ Cerebras `gpt-oss-120b`** (OpenAI-compatible, strict `json_schema`, but 5 RPM) **→ OpenRouter `:free`** (breadth backstop, ~50 req/day). `L` — [groq-engine.js](groq-engine.js)
- [ ] `[Harden]` **Error taxonomy** — distinct actionable messages (no-key/invalid-key/rate-limited/parse-fail/empty-scrape/network). `M`
- [x] `[Harden]` **SW-lifecycle safety** — ✅ SW dies after 30s idle (also 5-min/30s-fetch caps); all state already in `chrome.storage.local`; API key in `.local` not `.session`; ensure Groq fetch completes <30s. Cascade-health TTL display now consistent with skip logic.
- [x] `[Harden]` **Storage quota** — ✅ 10 MB `storage.local` is plenty for ICP + scores; `unlimitedStorage` **not** needed (avoids an extra permission that hurts Web Store review). Cache LRU cap in place.
- [ ] `[Harden][public-only]` Opt-in, privacy-safe error telemetry (to know when scraping breaks in the field). `M`

---

## Phase 5 — Distribution decision gate `(verified)`

✅ A LinkedIn-*reading* extension is **not** categorically banned by the Chrome Web Store (no anti-scraping clause) — but it draws heightened/manual review and LinkedIn can pressure a takedown regardless of CWS compliance.

| Path | What it means |
|------|----------------|
| **Internal (recommended start)** | Unpacked / enterprise-policy install. Random extension ID (not on LinkedIn's list), no CWS review, lowest exposure. Sales Navigator support fine. |
| **Public** `[public-only]` | Before submission: (1) narrow **single purpose**; (2) **narrowest host permission `https://*.linkedin.com/*`** (never `<all_urls>`) — the #1 review-delay trigger; (3) complete the **Privacy practices** tab + hosted **privacy policy** matching the code + pre-install consent + **Limited Use** statement; (4) explicitly disclose the **profile→Groq third-party transfer** and keep it strictly necessary; (5) ship non-obfuscated code; (6) accept residual LinkedIn-takedown risk → keep self-host as fallback. Tightened privacy rules enforce from **Aug 1, 2026**. Legal review recommended. |

---

## Risk Register

| Risk | Assessment (✅ verified) | Mitigation |
|------|------------------------|------------|
| **LinkedIn account restriction** | **Low** for passive, human-paced, read-only use; **not zero** — ✅ User Agreement **§8.2** explicitly names "browser plugins and add-ons" used to "scrape or copy," and it binds any logged-in user. Enforcement = account restriction/suspension (tiered: 1–24h → 3–14d+ID → permanent), not CFAA. | All Phase-0 guardrails; no automation; no bulk velocity; in-product ToS disclaimer. |
| **hiQ v. LinkedIn** | ✅ Public-data scraping isn't a CFAA crime, but hiQ **lost on breach of contract** (2022: injunction + data deletion + $500k; hiQ shut down). Can't market as "safe because public." | Position as reading-assistant; internal-first; don't persist/aggregate/redistribute scraped data. |
| **Client-side extension fingerprinting (BrowserGate)** | ✅ Two methods: **AED** (probes `web_accessible_resources` by known ID) — current design invisible (no WAR); **Spectroscopy** (scans page DOM for `chrome-extension://` URLs) — current side-panel design invisible (writes nothing to the page). 6,236+ IDs scanned as of 2026. | Keep **no WAR** + **no in-page UI / no `chrome-extension://` in page DOM**; inline assets as `data:` URIs. |
| **Chrome Web Store rejection** `[public-only]` | ✅ Allowed on paper; heightened review from LinkedIn host access + user-data handling; Aug 1 2026 privacy tightening. | Narrow host perm (already `linkedin.com` ✓), single purpose, privacy policy, disclosure, non-obfuscated. |
| **Single-provider (Groq) dependence** | ✅ **Resolved:** limits are **per-model**, so the 3-model cascade genuinely gives ~3× throughput (~3,000 profile-scores/day; ~90 RPM). Adding API keys does **not** add quota (org-shared per model). Risk is a Groq-wide outage. | Track per-model 429s independently (done); add BYOK fallback provider (Phase 4). |
| **Silent scrape failure** | LinkedIn DOM changes break selectors; fails silently to raw text today. | Scrape-quality gate + selector self-check (Phase 1). |

---

## Open questions — ✅ resolved by `w3p3egaum`

1. Groq limits **per-model** (cascade 3× valid; ~3,000/day cap). ✅
2. SEC EDGAR free/no-auth, revenue via XBRL, **service-worker-only** (no CORS), UA required, US-filers-only. ✅
3. BrowserGate mechanism = AED (WAR probing) + Spectroscopy (DOM `chrome-extension://` scan); current design evades both. ✅
4. Free fallback providers exist (Gemini/Cerebras/OpenRouter) via **BYOK** through the service worker. ✅
5. Revenue-per-employee: SaaS ~$130k/FTE, all-sector ~$111k (skewed); needs industry-keyed table. ✅

---

## Recommended sequence

Phase 0 ✅ and Phase 2 core ✅ are done. **Next: Phase 1 (scrape reliability)** — the biggest remaining reliability gap and pure free-tier, no-risk work. Then Phase 3 (SEC EDGAR + industry revenue table), then Phase 4 (BYOK fallback), gating public distribution (Phase 5) on the internal-vs-public decision.

---

## Changelog

- **v1.1 (2026-07-24)** — Folded in 8/8 verified research facts (`w3p3egaum`): Groq per-model limits (cascade 3× confirmed), SEC-EDGAR service-worker-only constraints, BrowserGate *Spectroscopy* guardrail (now an invariant), MV3 lifecycle/quota, industry-keyed revenue benchmarks, BYOK free-LLM fallback chain, §8.2/hiQ legal framing. Marked Phase 0 + Phase 2 core **done** (injection defense, cache eviction, consent gate, Qualifiable %, revenue honesty, confidence-weighted low-data-aware scoring, truncation detection, SW/quota). Resolved the Groq org-limit flag.
- **v1 (2026-07-24)** — Initial roadmap: code-level edge audit + first-pass research deltas.
