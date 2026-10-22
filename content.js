/**
 * content.js — LinkedIn + Sales Navigator Page Scraper
 *
 * Injected on:
 *   linkedin.com/in/*          (regular profiles)
 *   linkedin.com/company/*     (company pages)
 *   linkedin.com/sales/lead/*  (Sales Navigator profiles)
 *   linkedin.com/sales/company/* (Sales Navigator companies)
 *   linkedin.com/sales/people/*  (Sales Navigator people)
 *
 * Listens for SCRAPE_PAGE messages from the popup and returns structured data.
 * Uses multiple fallback selectors because LinkedIn changes its DOM frequently.
 */

(function () {
  'use strict';

  /* ==================================================================
   *  UTILITIES
   * ================================================================== */

  /** Try several CSS selectors; return trimmed textContent of the first hit. */
  function text(selectors, ctx = document) {
    for (const sel of selectors) {
      try {
        const el = ctx.querySelector(sel);
        const t = el?.textContent?.trim();
        if (t) return t;
      } catch (_) { /* invalid selector – skip */ }
    }
    return '';
  }

  /** Like text() but grabs the nth match (0-indexed). */
  function textAt(selectors, ctx = document, n = 0) {
    for (const sel of selectors) {
      try {
        const els = ctx.querySelectorAll(sel);
        const t = els[n]?.textContent?.trim();
        if (t) return t;
      } catch (_) { /* skip */ }
    }
    return '';
  }

  /** Grab all unique, short text values for a set of selectors. */
  function textList(selectors, ctx = document, limit = 10) {
    const seen = new Set();
    const out  = [];
    for (const sel of selectors) {
      try {
        ctx.querySelectorAll(sel).forEach((el) => {
          if (out.length >= limit) return;
          const t = el.textContent?.trim();
          if (t && t.length > 1 && t.length < 80 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
          }
        });
      } catch (_) { /* skip */ }
    }
    return out;
  }

  /** Grab visible body text as a fallback when specific selectors miss. */
  function bodySnippet(maxLen = 2000) {
    const body = document.body?.innerText || '';
    return body.substring(0, maxLen);
  }

  /**
   * Scrape company revenue from the page.
   * Sales Navigator shows revenue in:
   *   - Company info hover cards (may not be in DOM unless hovered)
   *   - Right-side account/company panel
   *   - Lead IQ tab details
   *   - Company page overview
   * Every candidate goes through revenue-parser.js, which only accepts a dollar
   * amount sitting next to "revenue" used as a company metric — so job titles
   * ("Chief Revenue Officer"), salaries and funding amounts are never taken
   * as revenue. A wrong figure is worse than none: it is passed to the model
   * as fact and lifts the revenue confidence cap.
   */
  function scrapeRevenue(ctx = document) {
    const { extractRevenue, isRevenueLabel, isRevenueValue } = globalThis.LQRevenue || {};
    if (!extractRevenue) return '';

    /** A candidate element's text → a revenue figure, or ''. */
    const fromText = (t) => {
      const v = (t || '').trim();
      if (!v) return '';
      return isRevenueValue(v) ? v : extractRevenue(v);
    };

    // --- Method 1: Direct revenue fields (value-only, or label + value) ---
    const directSelectors = [
      '[data-anonymize="revenue"]',
      '.company-info-card__revenue',
      '.company-revenue',
      '.account-info__revenue',
      '.company-info__revenue',
      '.account-detail__revenue',
      '.account-overview__revenue',
      '[data-test="revenue"]',
      '[data-test-id="revenue"]',
      '[class*="revenue"]',
    ];
    for (const sel of directSelectors) {
      try {
        for (const el of ctx.querySelectorAll(sel)) {
          const v = fromText(el.textContent);
          if (v) return v;
        }
      } catch (_) { /* invalid selector – skip */ }
    }

    // --- Method 2: Label/value pairs (dt/dd, label/value, table layouts) ---
    const labelSelectors = 'dt, .label, .info-label, th, .t-bold, .t-14.t-bold, span.t-bold';
    for (const el of ctx.querySelectorAll(labelSelectors)) {
      if (!isRevenueLabel(el.textContent)) continue;
      const next       = el.nextElementSibling?.textContent;
      const parentNext = el.parentElement?.nextElementSibling?.textContent;
      if (isRevenueValue(next)) return next.trim();
      if (isRevenueValue(parentNext)) return parentNext.trim();
    }

    // --- Method 3: Visible page text ("Revenue: $1M - $7.5M", "$5M revenue") ---
    const bodyText = ctx.body?.innerText || ctx.innerText || '';
    const fromBody = extractRevenue(bodyText);
    if (fromBody) return fromBody;

    // --- Method 4: Info cards via textContent (includes hidden hover cards) ---
    const infoCards = ctx.querySelectorAll([
      '.company-info-card',
      '[class*="company-info"]',
      '[class*="account-info"]',
      '.org-about-module',
      '.org-page-details__definition-text',
      '[class*="company-card"]',
      '[class*="account-card"]',
      '.artdeco-card',
      // Sales Nav right panel sections
      '[class*="account-detail"]',
      '[class*="account-overview"]',
      'aside',
      '[role="complementary"]',
    ].join(', '));

    for (const card of infoCards) {
      const v = extractRevenue(card.textContent);
      if (v) return v;
    }

    return '';
  }

  /* ==================================================================
   *  REGULAR PROFILE SCRAPER  (/in/*)
   * ================================================================== */

  function scrapeProfile() {
    const data = { type: 'profile' };

    data.name = text([
      'h1.text-heading-xlarge',
      'h1[class*="text-heading"]',
      '.pv-top-card h1',
      'h1',
    ]);

    data.headline = text([
      '.text-body-medium[data-anonymize="headline"]',
      '.pv-top-card .text-body-medium',
      '[data-anonymize="headline"]',
      '.pv-top-card--list .text-body-medium',
    ]);

    data.location = text([
      '.text-body-small[data-anonymize="location"]',
      '[data-anonymize="location"]',
      '.pv-top-card--list .text-body-small',
    ]);

    data.about = scrapeSection('about', [
      'span[aria-hidden="true"]',
      '.pv-shared-text-with-see-more span[aria-hidden="true"]',
      'p',
    ]);

    data.experience = scrapeExperience();

    data.skills = textList([
      '#skills ~ .display-flex span[aria-hidden="true"]',
      '.pv-skill-category-entity__name span',
      '[data-field="skill_page_skill_topic"] span[aria-hidden="true"]',
    ]);

    return data;
  }

  /** Pull text from a named page section (#id → closest <section>). */
  function scrapeSection(id, selectors) {
    const anchor = document.querySelector(`#${id}`);
    if (!anchor) return '';
    const section = anchor.closest('section') || anchor.parentElement?.parentElement;
    return section ? text(selectors, section) : '';
  }

  /** Scrape experience list items from regular profiles. */
  function scrapeExperience() {
    const anchor = document.querySelector('#experience');
    if (!anchor) return [];

    const section = anchor.closest('section') || anchor.parentElement?.parentElement;
    if (!section) return [];

    const items = section.querySelectorAll(
      'li.artdeco-list__item, [class*="pvs-list__item--line-separated"]'
    );
    const out = [];

    items.forEach((item) => {
      if (out.length >= 5) return;
      const spans = item.querySelectorAll(
        ':scope > div span[aria-hidden="true"], .t-bold span[aria-hidden="true"]'
      );
      const title   = spans[0]?.textContent?.trim() || '';
      const company  = spans[1]?.textContent?.trim() || '';
      const duration = text([
        '.t-normal .t-black--light span[aria-hidden="true"]',
        '.pvs-entity__caption-wrapper span[aria-hidden="true"]',
      ], item);

      if (title) out.push({ title, company, duration });
    });

    return out;
  }

  /* ==================================================================
   *  SALES NAVIGATOR PROFILE SCRAPER  (/sales/lead/*)
   * ================================================================== */

  function scrapeSalesNavProfile() {
    const data = { type: 'profile' };

    // ---- Name ----
    // Sales Nav uses various patterns for the name
    data.name = text([
      '[data-anonymize="person-name"]',
      '.profile-topcard-person-entity__name',
      '.artdeco-entity-lockup__title',
      'h1[class*="profile-topcard"]',
      'span[data-anonymize="person-name"]',
      '.profile-topcard h1',
      // fallback — the first prominent heading on the page
      'h1',
    ]);

    // ---- Headline / Title + Company ----
    data.headline = text([
      '.profile-topcard__summary-position',
      '.profile-topcard__summary-position-title',
      '.artdeco-entity-lockup__subtitle',
      '[data-anonymize="headline"]',
      '.profile-topcard__current-positions .profile-topcard__summary-position',
    ]);

    // If headline is empty, try composing from title + company
    if (!data.headline) {
      const title = text([
        '.profile-topcard__summary-position-title',
        '.profile-topcard-person-entity__position .t-bold',
      ]);
      const company = text([
        '.profile-topcard__summary-company-link',
        '.profile-topcard__summary-position-company',
        '.artdeco-entity-lockup__caption',
      ]);
      if (title || company) {
        data.headline = [title, company].filter(Boolean).join(' at ');
      }
    }

    // ---- Location ----
    data.location = text([
      '[data-anonymize="location"]',
      '.profile-topcard__location-data',
      '.profile-topcard__summary-info .t-normal',
      '.profile-topcard-person-entity__location',
    ]);

    // ---- About / Summary ----
    data.about = text([
      '.profile-topcard__summary-content',
      '.profile-topcard__summary .lt-line-clamp__raw-line',
      '.profile-topcard-summary-section__content',
      '[data-anonymize="person-blurb"]',
    ]);

    // ---- Experience from Sales Nav ----
    data.experience = scrapeSalesNavExperience();

    // ---- Skills aren't always visible in Sales Nav, try anyway ----
    data.skills = textList([
      '.profile-skills__skill-name',
      '[data-anonymize="skill-name"]',
    ]);

    // ---- Connections / Network info ----
    data.connectionDegree = text([
      '.profile-topcard__connection-degree',
      '.artdeco-entity-lockup__degree',
      '[class*="connection-degree"]',
    ]);

    data.mutualConnections = text([
      '.profile-topcard__mutual-connections',
      '[class*="mutual-connection"]',
      '.artdeco-entity-lockup__badge',
    ]);

    // ---- Current company info from top card ----
    data.currentCompany = text([
      '.profile-topcard__summary-company-link',
      '.profile-topcard__summary-position-company',
      'a[data-anonymize="company-name"]',
    ]);

    data.currentTitle = text([
      '.profile-topcard__summary-position-title',
      '.profile-topcard-person-entity__position .t-bold',
    ]);

    // ---- Education ----
    data.education = scrapeSalesNavEducation();

    // ---- Company Revenue ----
    // Sales Nav shows revenue in company info cards / sidebars
    data.companyRevenue = scrapeRevenue();

    // ---- Employee count (helps estimate revenue if not explicit) ----
    data.companySize = text([
      '[data-anonymize="company-size"]',
      '.company-info-card__employees',
      '.profile-topcard__summary-info [class*="company-size"]',
    ]);

    // ---- Always grab visible body text for AI context ----
    // This is critical: when user is on Experience tab, all roles are
    // visible in the body text even if DOM selectors can't find them.
    data.rawPageText = bodySnippet(1500);

    return data;
  }

  /** Scrape experience from Sales Navigator profile cards + full page */
  function scrapeSalesNavExperience() {
    const out = [];

    // --- Method 1: Top-card current/previous positions ---
    const containers = document.querySelectorAll([
      '.profile-topcard__current-positions li',
      '.profile-topcard__previous-positions li',
      '.profile-topcard__summary-position',
      '[class*="experience-section"] li',
      '.profile-position',
    ].join(', '));

    containers.forEach((item) => {
      if (out.length >= 10) return;

      const title = text([
        '.profile-topcard__summary-position-title',
        '.t-bold',
        '[data-anonymize="title"]',
        'span[class*="position-title"]',
      ], item);

      const company = text([
        '.profile-topcard__summary-company-link',
        '.profile-topcard__summary-position-company',
        'a[data-anonymize="company-name"]',
        '[data-anonymize="company-name"]',
      ], item);

      const duration = text([
        '.profile-topcard__time-period-bullet',
        '.t-normal:not(.t-bold)',
        '.date-range',
      ], item);

      if (title || company) {
        out.push({ title: title || '', company: company || '', duration: duration || '' });
      }
    });

    // --- Method 2: Experience tab list items (when user is on Experience tab) ---
    // Sales Nav experience tab uses different DOM structures
    const expTabItems = document.querySelectorAll([
      '.profile-position__content',
      '[class*="experience-entry"]',
      '.experience-section li',
      '.profile-experience__card',
      // Sales Nav "experience" list uses generic list selectors
      'section[class*="experience"] li',
      'div[class*="experience"] li',
    ].join(', '));

    expTabItems.forEach((item) => {
      if (out.length >= 10) return;

      const title = text([
        'h3', '.t-bold', '[data-anonymize="title"]',
        'span[class*="title"]',
      ], item);

      const company = text([
        'h4', '.t-normal .t-bold',
        'a[data-anonymize="company-name"]',
        '[data-anonymize="company-name"]',
        'span[class*="company"]',
      ], item);

      const duration = text([
        '.date-range', '.t-normal:not(.t-bold)',
        'span[class*="duration"]', 'span[class*="date"]',
        '.pvs-entity__caption-wrapper',
      ], item);

      if (title || company) {
        out.push({ title: title || '', company: company || '', duration: duration || '' });
      }
    });

    // --- Method 3: Parse experience from visible text on page ---
    // When on the Experience tab, the experience data is visible but
    // might not match any selectors due to LinkedIn's dynamic DOM.
    // Look for heading elements that contain job-title-like text.
    const allHeadings = document.querySelectorAll('h3, h2, [class*="entity-title"]');
    allHeadings.forEach((h) => {
      if (out.length >= 10) return;
      const t = h.textContent?.trim();
      if (!t || t.length < 3 || t.length > 100) return;

      // Check if this looks like a job title (near company info)
      const parent = h.closest('li') || h.parentElement?.parentElement;
      if (!parent) return;

      const parentText = parent.textContent || '';
      // Only capture if parent contains employment-like keywords
      const hasEmploymentSignals = /present|yr|mos|year|month|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(parentText);
      if (!hasEmploymentSignals) return;

      const company = text(['h4', 'a', '.t-normal'], parent);
      out.push({ title: t, company: company || '', duration: '' });
    });

    // Deduplicate by normalized title+company
    const seen = new Set();
    return out.filter(e => {
      const key = `${e.title.toLowerCase().trim()}::${e.company.toLowerCase().trim()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Scrape education from Sales Navigator */
  function scrapeSalesNavEducation() {
    const out = [];
    const containers = document.querySelectorAll([
      '[class*="education"] li',
      '.profile-education__card',
      '.education-section li',
    ].join(', '));

    containers.forEach((item) => {
      if (out.length >= 3) return;
      const school = text(['h3', '.t-bold', '[data-anonymize="school-name"]'], item);
      const degree = text(['h4', '.t-normal', 'span[class*="degree"]'], item);
      if (school) out.push({ school, degree: degree || '' });
    });

    return out;
  }

  /* ==================================================================
   *  REGULAR COMPANY SCRAPER  (/company/*)
   * ================================================================== */

  function scrapeCompany() {
    const data = { type: 'company' };

    data.companyName = text([
      'h1[class*="org-top-card"]',
      '.org-top-card-summary__title h1',
      'h1 span',
      'h1',
    ]);

    data.industry = text([
      '.org-top-card-summary-info-list__info-item:first-child',
      '[data-anonymize="industry"]',
      '.org-about-us-organization-description__industry',
    ]);

    data.size = text([
      '.org-about-company-module__company-size-definition-text',
      '[data-anonymize="company-size"]',
      '.org-top-card-summary-info-list__info-item:nth-child(2)',
    ]);

    data.description = text([
      '.org-about-us-organization-description__text span[aria-hidden="true"]',
      '.org-about-us-organization-description p',
      '.org-top-card-summary__tagline',
    ]);

    data.specialties = text([
      '.org-about-module__specialities',
      '.org-about-us-organization-description__specialties',
    ]);

    // ---- Revenue ----
    data.companyRevenue = scrapeRevenue();

    return data;
  }

  /* ==================================================================
   *  SALES NAVIGATOR COMPANY SCRAPER  (/sales/company/*)
   * ================================================================== */

  function scrapeSalesNavCompany() {
    const data = { type: 'company' };

    data.companyName = text([
      '.org-top-card-summary__title',
      '[data-anonymize="company-name"]',
      'h1',
    ]);

    data.industry = text([
      '[data-anonymize="industry"]',
      '.org-top-card-summary-info-list__info-item',
      '.company-info-card__industry',
    ]);

    data.size = text([
      '[data-anonymize="company-size"]',
      '.company-info-card__employees',
      '.org-top-card-summary-info-list__info-item:nth-child(2)',
    ]);

    data.description = text([
      '.company-description__text',
      '.org-about-us-organization-description__text',
      '.org-top-card-summary__tagline',
    ]);

    data.specialties = text([
      '.org-about-module__specialities',
    ]);

    // ---- Revenue ----
    data.companyRevenue = scrapeRevenue();

    // Fallback
    if (!data.companyName) {
      data.rawPageText = bodySnippet(3000);
    }

    return data;
  }

  /* ==================================================================
   *  PAGE-TYPE DETECTION
   * ================================================================== */

  function pageType() {
    const url = location.href;

    // Sales Navigator paths (check first — more specific)
    if (url.includes('/sales/search/'))  return 'sales-list';
    if (url.includes('/sales/lists/'))   return 'sales-list';
    if (url.includes('/sales/lead/'))    return 'sales-profile';
    if (url.includes('/sales/people/'))  return 'sales-profile';
    if (url.includes('/sales/company/')) return 'sales-company';

    // Regular LinkedIn
    if (url.includes('/in/'))            return 'profile';
    if (url.includes('/company/'))       return 'company';

    return 'unknown';
  }

  /** Map page type to the right scraper */
  function scrape() {
    const pt = pageType();
    switch (pt) {
      case 'profile':       return scrapeProfile();
      case 'company':       return scrapeCompany();
      case 'sales-profile': return scrapeSalesNavProfile();
      case 'sales-company': return scrapeSalesNavCompany();
      default:              return null;
    }
  }

  /* ==================================================================
   *  SALES NAVIGATOR LIST/SEARCH SCRAPER
   * ================================================================== */

  /**
   * Scrape visible lead cards from a Sales Navigator search/list page.
   * Returns an array of mini-profile objects.
   */
  function scrapeSalesNavList() {
    const leads = [];
    const seen  = new Set();

    // Sales Nav search result cards — multiple selector strategies
    const cards = document.querySelectorAll([
      // Main search result items
      'li.artdeco-list__item',
      '[class*="search-results"] li',
      '[data-anonymize="person-result"]',
      'ol.search-results__result-list > li',
      // Lead list items
      '[class*="lead-list"] li',
      'table tbody tr',
    ].join(', '));

    cards.forEach((card) => {
      // ---- Name ----
      const name = text([
        '[data-anonymize="person-name"]',
        'a[data-anonymize="person-name"]',
        '.artdeco-entity-lockup__title a',
        '.result-lockup__name a',
        'span[data-anonymize="person-name"]',
        '.artdeco-entity-lockup__title span',
      ], card);

      if (!name || name.length < 2) return;

      // ---- Profile URL ----
      let profileUrl = '';
      const profileLink = card.querySelector([
        'a[data-anonymize="person-name"]',
        '.artdeco-entity-lockup__title a',
        '.result-lockup__name a',
        'a[href*="/sales/lead/"]',
        'a[href*="/sales/people/"]',
      ].join(', '));
      if (profileLink) {
        profileUrl = profileLink.href || '';
      }

      // Deduplicate by name + url
      const dedupKey = `${name}::${profileUrl}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      // ---- Title / Headline ----
      const title = text([
        '.artdeco-entity-lockup__subtitle',
        '[data-anonymize="title"]',
        '.result-lockup__highlight-keyword',
        'span[class*="entity-lockup__subtitle"]',
      ], card);

      // ---- Company ----
      const company = text([
        '[data-anonymize="company-name"]',
        'a[data-anonymize="company-name"]',
        '.artdeco-entity-lockup__caption',
        '.result-lockup__misc-item a',
      ], card);

      // ---- Location ----
      const location = text([
        '[data-anonymize="location"]',
        '.artdeco-entity-lockup__metadata',
        '.result-lockup__misc-item:last-child',
      ], card);

      // ---- Snippet text (any additional context) ----
      const snippet = text([
        '.result-lockup__summary',
        '.artdeco-entity-lockup__badge',
        '.search-results__result-item--highlight',
      ], card);

      leads.push({
        name,
        title:      title || '',
        company:    company || '',
        location:   location || '',
        profileUrl: profileUrl || '',
        snippet:    snippet || '',
      });
    });

    return leads;
  }

  /* ==================================================================
   *  MESSAGE LISTENER
   * ================================================================== */

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {

    if (msg.type === 'SCRAPE_PAGE') {
      try {
        const data = scrape();
        if (!data) {
          reply({ error: 'Not a supported LinkedIn page.' });
          return true;
        }

        data.url       = location.href;
        data.scrapedAt = Date.now();

        // Selector self-check: no identity usually means LinkedIn changed its
        // DOM, or the page hasn't finished loading. Reported to the panel so
        // the user sees it, not just the console.
        const noIdentity = data.type === 'company'
          ? !data.companyName
          : !(data.name || data.headline || data.currentTitle);
        data.scrapeWarnings = [];
        if (noIdentity) {
          data.scrapeWarnings.push('no-identity');
          console.warn('[LeadQualify] Scrape found no identity fields — LinkedIn DOM may have changed or the page is still loading:', location.href);
        }

        reply({ success: true, data });
      } catch (err) {
        reply({ error: `Scrape failed: ${err.message}` });
      }
      return true;
    }

    if (msg.type === 'SCRAPE_LIST') {
      try {
        const pt = pageType();
        if (pt !== 'sales-list') {
          reply({ error: 'Not a Sales Navigator list/search page.' });
          return true;
        }

        const all    = scrapeSalesNavList();
        const LIST_CAP = 25;
        const capped = all.length > LIST_CAP;
        const leads  = all.slice(0, LIST_CAP);
        reply({
          success: true,
          data: {
            type:    'list',
            leads,
            total:   all.length,
            capped,
            url:     location.href,
            scrapedAt: Date.now(),
          },
        });
      } catch (err) {
        reply({ error: `List scrape failed: ${err.message}` });
      }
      return true;
    }

    if (msg.type === 'PING') {
      reply({ alive: true, pageType: pageType() });
      return true;
    }

    return false;
  });

  /* ---- Notify background that we're alive ---- */
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_LOADED', url: location.href })
    .catch(() => { /* popup may not be open yet */ });
})();
