/**
 * revenue-parser.js — pure text matching for company revenue figures.
 *
 * Loaded as a classic content script just before content.js (and evaluated
 * directly by the unit tests), so it exposes its helpers on
 * globalThis.LQRevenue instead of using ES module exports.
 *
 * The rule: a dollar amount only counts as revenue when it sits right next to
 * the word "revenue" used as a company metric. Job titles and team names
 * ("Chief Revenue Officer", "Revenue Operations") and free-floating amounts
 * (salaries, funding, prices in posts) never qualify.
 */
(function (root) {
  'use strict';

  // "$1M", "$7.5M+", "$250K", "$2 billion", "€10M"
  const AMOUNT = String.raw`[$€£₹]\s?\d[\d,.]*(?:\s*(?:[KMBT]\b|thousand|million|billion|trillion))?\+?`;
  // A single amount or a range: "$1M - $7.5M+", "$1M to $5M"
  const RANGE = String.raw`${AMOUNT}(?:\s*(?:-|–|—|~|to)\s*${AMOUNT})?`;
  // "revenue" as a company metric — not part of a role or team name.
  const REVENUE_WORD = String.raw`(?<!(?:chief|head\s+of|vp\s+of|vp,?|director\s+of|svp\s+of|svp,?)\s+)revenue` +
    String.raw`(?!\s*(?:officer|operations|ops|team|leader|lead|manager|management|growth|strategy|marketing|enablement|cycle|engine|org|intelligence|cloud))`;

  const PATTERNS = [
    // "Revenue: $1M - $7.5M", "Annual revenue $5M", "Revenue range\n$1M–$10M"
    new RegExp(String.raw`(?:annual\s+)?${REVENUE_WORD}(?:\s+range)?\s*[:\-–]?\s*(${RANGE})`, 'i'),
    // "$1M - $7.5M+ revenue", "$5M in annual revenue", "$20M rev."
    new RegExp(String.raw`(${RANGE})\s*(?:in\s+)?(?:annual\s+)?(?:${REVENUE_WORD}|rev\.)`, 'i'),
  ];

  const LABEL_RE = /^(?:annual\s+)?revenue(?:\s+range)?\s*:?$/i;
  const VALUE_RE = new RegExp(String.raw`^\s*(?:(?:less\s+than|under|over|more\s+than|<|>)\s*)?${RANGE}\s*$`, 'i');

  /** Return the revenue figure in `text` (e.g. "$1M - $7.5M+"), or ''. */
  function extractRevenue(text) {
    if (!text) return '';
    for (const re of PATTERNS) {
      const m = String(text).match(re);
      if (m) return m[1].trim();
    }
    return '';
  }

  /** True for a label element whose whole text is "Revenue" / "Annual revenue" / "Revenue range". */
  function isRevenueLabel(text) {
    return LABEL_RE.test(String(text || '').trim());
  }

  /** True for a value element whose whole text is a dollar amount or range. */
  function isRevenueValue(text) {
    const t = String(text || '').trim();
    return t.length > 0 && t.length <= 40 && VALUE_RE.test(t);
  }

  root.LQRevenue = { extractRevenue, isRevenueLabel, isRevenueValue };
})(globalThis);
