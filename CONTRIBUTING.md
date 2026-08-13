# Contributing to LeadQualify

## Non-negotiable invariants (the risk fence)

These are **architectural guarantees**, not preferences. They are what keep the
extension in the low-risk band (see [ROADMAP.md](ROADMAP.md) → Risk Register).
A change that breaks any of these must not be merged.

1. **Human-triggered only.** The extension acts only when the user explicitly
   clicks (Score / Score All). **No** auto-navigation, auto-scroll,
   auto-open-profile, auto-connect, or auto-message — ever. Automating *actions*
   is what turns low ban-risk into high ban-risk.

2. **Zero requests to LinkedIn.** The extension only reads the DOM already
   rendered in the user's tab. It must **never** issue a background/`fetch`
   request to a `linkedin.com` URL. Outbound network calls are allowed only to:
   - the LLM provider (Groq, and any future fallback), and
   - explicitly whitelisted public data APIs (e.g. `data.sec.gov`) **from the
     service worker only** (those hosts must be in `host_permissions`;
     `data.sec.gov` sends no CORS headers, so a content-script fetch will fail).

3. **No `web_accessible_resources`.** Declaring them lets LinkedIn's client-side
   scripts fingerprint the extension by probing its resources. The manifest
   currently declares none — keep it that way.

4. **Data minimization.** Cache scores and small derived fields only — never raw
   scraped profiles / `rawPageText`. The score cache is capped
   (`MAX_CACHED_SCORES`) with LRU eviction; don't remove the cap.

5. **Scraped text is untrusted data, never instructions.** All scraped content
   is fenced with a **per-request nonce** delimiter (`[DATA-<nonce>]…[/DATA-<nonce>]`)
   that untrusted content cannot reproduce, and the system prompt only trusts
   text between those exact markers. `neutralizeInjection` additionally strips
   fence tokens + zero-width chars and redacts injection-like lines — treat that
   regex as **best-effort defense-in-depth only, not a boundary** (it is
   bypassable by rephrasing/homoglyphs/line-splits). The real boundaries are the
   nonce fence and the deterministic overall score. Any new field carrying page
   free-text must flow through `neutralizeInjection` + the fence, and any
   model-returned string rendered via `innerHTML` must be `escapeHtml`-escaped.

6. **Scores must stay reproducible and honest.** The overall score is computed
   deterministically as a **confidence-weighted** average of category scores ×
   ICP weights (`computeWeightedScore`, factors HIGH ×1 / MEDIUM ×0.6 / LOW ×0.25)
   at `temperature: 0` — the LLM's own total is never shown. Down-weighting
   low-confidence categories is what keeps low-data (list-view) scores from
   collapsing to the mean; don't revert it to a flat average. Inferred data must
   not present as fact: `enforceEvidenceHonesty` caps guessed-revenue confidence,
   and the Qualifiable % (`computeQualifiablePercent`) surfaces how
   evidence-backed a score is. Don't bypass these.

## Development

- No build step. Load unpacked: `chrome://extensions` → Developer mode → Load unpacked.
- ES modules throughout; `package.json` sets `"type": "module"` (Chrome ignores it).

## Tests

Pure logic (scoring, trust, safety) is covered by Node's built-in runner — no deps:

```bash
npm test
```

Add tests in [test/](test/) for any new pure function. The LLM call and DOM
scraping aren't unit-tested (they need a browser + network) — verify those by
loading the extension and scoring a real profile.

> ⚠️ Block-comment gotcha: never put `**/*` inside a `/* … */` comment — the `*/`
> closes the comment early. (Bit us once already.)

## Before you commit

- `npm test` is green.
- No new `linkedin.com` fetch, no `web_accessible_resources`, no automation of actions.
- If you touched the result shape or scoring logic, bump `SCORING_VERSION` in
  [storage-manager.js](storage-manager.js) so stale cached scores re-compute.
