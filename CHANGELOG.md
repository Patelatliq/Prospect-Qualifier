# Changelog

## Reliability update — `feat/reliability-and-trust` (2026-10-22)

Fixes for scores that were wrong or out of date, a sturdier connection to Groq,
a revenue scraper that no longer mistakes job titles for company revenue, and
new tools in the side panel.

**13 bugs fixed · 6 new features · unit tests 44 → 90 (all passing) · 40/40 browser checks passing**

### What users will notice

**Every score changes once.** The scoring formula changed (`SCORING_VERSION` 9 → 10),
so all cached scores are cleared and each prospect is re-scored the next time it
is opened.

A category the model is unsure about now pulls toward a neutral 50 instead of
shrinking in weight. Before, one confident input, usually the job title, could
carry the whole score.

| Example prospect | Before | After |
|---|---|---|
| CEO at a company the model knows nothing about | 69 WARM | 58 WARM |
| Strong title, everything else unknown | 72 | 59 |
| Sydney, Australia prospect, auto-switch on | North America profile | Global Default profile |
| Profile mentioning a "Chief Revenue Officer" | Revenue taken from the page | No revenue; marked as estimated |

### Fixed

#### Wrong or stale scores

| Priority | Fix |
|---|---|
| P0 | **Region auto-switch matched parts of words.** "US" matched Australia, Russia, Belgium and Cyprus, so those prospects got the North America profile. Regions now match whole words only. |
| P0 | **Cached scores ignored ICP changes.** Changing weights or tier thresholds now updates cached scores at once, with no new AI call. Changing titles, industries or the revenue threshold marks them for a re-score, and Score All no longer skips them. |
| P0 | **Score could run on a page you had left.** Moving from a profile to the feed kept the old profile loaded with Score enabled. The panel now clears it on every page change. |
| P0 | **Scores saved at the same time overwrote each other.** Ten scores saved at once kept only one. Writes are now done one at a time. |

#### Score accuracy

| Priority | Fix |
|---|---|
| P1 | **Missing data inflated scores.** Low-confidence categories keep their full weight but are pulled toward neutral (see the table above). |
| P1 | **Revenue scraper read job titles and salaries as revenue.** Only a dollar amount labelled as company revenue is accepted now. The rule lives in [revenue-parser.js](revenue-parser.js) and has its own tests. |
| P2 | **Prompt contradicted itself on unknown revenue.** It said both 0-29 and 40; it now says 40 with low confidence. |

#### Connection to Groq

| Priority | Fix |
|---|---|
| P2 | **A stuck request spun forever.** Each request now gives up after 30 seconds and tries the next model. |
| P2 | **A malformed reply reached the user.** Replies are checked before they are accepted; a bad, cut-off or empty reply moves on to the next model. |
| P2 | **Auto-retry cleared all-day rate limits.** The retry now waits only for a short per-minute block, using Groq's own `retry-after` time. |
| P2 | **One Sales Navigator lead had several cache entries.** The same lead reached from different searches now shares one entry. |

#### Side panel

| Priority | Fix |
|---|---|
| P3 | **A 0% weight came back as its default.** Setting revenue to 0% reloaded it as 25%, so the total showed 125% and every later save failed. Found in browser testing. |
| P3 | **List rows could be scored twice or stay stuck on "scoring".** Double clicks are ignored while a row is scoring, and stopping a batch clears every row. |
| P3 | **Settings panel cut off its last button.** The panel now has room for the full editor, and the industry boxes show every pill and the search field. |

### Added

- **CSV export for Sales Navigator lists** — name, title, company, score, tier, evidence %, estimated revenue and summary, best first. Text that would run as a spreadsheet formula is neutralised.
- **Adjacent industries in the ICP editor** — partial-fit industries (scored 60-79) can now be edited.
- **Tier thresholds in the ICP editor** — set the HOT and WARM cut-offs per profile; HOT must be above WARM.
- **Warning when a page can't be read** — if no name or title is found, the panel says so instead of only logging it.
- **Automated tests on every push** — [.github/workflows/test.yml](.github/workflows/test.yml) runs a syntax check, validates the manifest and runs all unit tests.
- **Tests for storage, the Groq cascade and the revenue parser** — 46 new tests, using an in-memory stand-in for Chrome storage and a fake network.

### Improved

- **Clearer confidence labels** — the two meters are now "Page data found" and "Score backed by evidence".
- **"Re-score" label** whenever a result is shown, not only for cached results.
- **Prompt-injection filter** removes one sentence, not the whole line. The About section arrives as one line, so a single suspicious phrase used to erase all of it.
- **Cleanup** — removed an unused industry alias map, fixed garbled characters in the scraper, corrected old model names in the panel, and $999,999 now reads "$1M" instead of "$1000K".
- **Docs** — README, CONTRIBUTING and ROADMAP describe the new scoring formula, retry rules and test files.

### How it was tested

90 unit tests pass (`npm test`), up from 44. The extension was also loaded in a
real Chromium browser, with LinkedIn pages and the Groq API replaced by local
fakes, and driven through 40 checks: consent, scoring, a forced rate limit,
region routing, cache refresh, editor validation, page changes, company
revenue, batch scoring and CSV export. All 40 pass.

> **Not yet checked against real LinkedIn.** The fake pages follow what the
> scraper looks for, so they can't confirm LinkedIn's current layout still
> matches. A short check with a real Groq key on one profile, one company page
> and one Sales Navigator search is still needed.

### Still to do

| Item | Why | Estimate |
|---|---|---|
| Check on real LinkedIn | Confirms the scraper against today's page layout | 15 min |
| Clean "Georgia" from saved profiles | Users who already saved North America still route the country of Georgia there | 30 min |
| Block an industry in two lists | An industry can be both target and excluded | 30 min |
| Add ESLint to CI | Catches typos and unused code the tests miss | 1 h |
| Hand-rated score check | Rate about 25 prospects once to confirm the new formula ranks better | 1 day |
| Scraper tests on saved LinkedIn pages | Catches LinkedIn layout changes early | 1 day |
| Batch scoring in the background | Closing the panel currently stops Score All | 1.5–2 days |

### Commits

| Commit | Change |
|---|---|
| `8a774eb` | fix(storage): whole-word region match, serialized writes, Sales Nav cache keys |
| `b9b4f4a` | fix(engine): request timeout, response validation, safer rate-limit retry |
| `5d8141c` | fix(scoring): pull low-confidence scores toward neutral, ICP-aware cache refresh |
| `3183adf` | fix(scraper): only accept labelled company revenue; report scrape failures |
| `ef88c36` | feat(ui): stale-state reset, ICP editor fields, CSV export, clearer labels |
| `080e4aa` | ci: run syntax check and tests on push; update docs for new behaviour |
