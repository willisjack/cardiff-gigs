const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Welsh-language acts list (curated, case-insensitive lookup)
// ---------------------------------------------------------------------------

function loadWelshActs() {
  try {
    const p = path.join(__dirname, 'welsh-acts.json');
    return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).map((s) => s.toLowerCase().trim()));
  } catch { return new Set(); }
}

const WELSH_ACTS = loadWelshActs();

const GOTO = { waitUntil: 'domcontentloaded', timeout: 90_000 };
const SKIP_ENRICH = process.env.SCRAPE_NO_ENRICH === '1';
const ENRICH_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.SCRAPE_ENRICH_CONCURRENCY || 3)));

// ---------------------------------------------------------------------------
// Page navigation helper
// ---------------------------------------------------------------------------

async function gotoAndSettle(page, url, contentSelector) {
  await page.goto(url, GOTO);
  await page.waitForLoadState('load').catch(() => {});
  if (contentSelector) {
    try {
      await page.waitForSelector(contentSelector, { state: 'attached', timeout: 45_000 });
    } catch (_) {
      /* venue may genuinely have no matching nodes */
    }
  }
}

// ---------------------------------------------------------------------------
// Genre / category inference
// ---------------------------------------------------------------------------

/**
 * Text signals that map to a genre label.
 * Order matters — more specific patterns first.
 */
const GENRE_SIGNALS = [
  [/\bpunk\b/i, 'Punk'],
  [/\bhip[- ]?hop\b/i, 'Hip-hop'],
  [/\brap\b|\bgrime\b/i, 'Rap'],
  [/\bmetal\b|\bheavy metal\b|\bdeath metal\b|\bblack metal\b/i, 'Metal'],
  [/\bhard\s*rock\b/i, 'Hard Rock'],
  [/\bfolk\b|\bacoustic\b/i, 'Folk'],
  [/\bjazz\b/i, 'Jazz'],
  [/\bsoul\b/i, 'Soul'],
  [/\br\s*[&and]+\s*b\b/i, 'R&B'],
  [/\belectronic\b|\btechno\b|\bhouse\s*music\b|\bdrum\s*[&and]+\s*bass\b|\bd[&']?n[&']?b\b/i, 'Electronic'],
  [/\bcountry\b/i, 'Country'],
  [/\bclassical\b|\borchestra\b|\bsymphony\b|\bphilharmonic\b|\bopera\b|\bchamber\b/i, 'Classical'],
  [/\bregga[e]?\b|\bska\b/i, 'Reggae'],
  [/\bblues\b/i, 'Blues'],
  [/\bindier?\b/i, 'Indie'],
  [/\bpop\b/i, 'Pop'],
  [/\brock\b/i, 'Rock'],
  [/\bambi[ae]nt\b/i, 'Ambient'],
  [/\bgospel\b/i, 'Gospel'],
  [/\bcountry\b/i, 'Country'],
  [/\bworld\s*music\b/i, 'World Music'],
];

// ─── WMC availability helpers ────────────────────────────────────────────────

const WMC_AVAILABILITY_TIERS = {
  'good availability':                 { label: 'GOOD AVAILABILITY',              range: '0-30%',  lo: 0,   hi: 30,  mid: 15  },
  'moderate availability':             { label: 'MODERATE AVAILABILITY',          range: '31-60%', lo: 31,  hi: 60,  mid: 46  },
  'limited availability':              { label: 'LIMITED AVAILABILITY',           range: '61-90%', lo: 61,  hi: 90,  mid: 76  },
  'only wheelchair seating available': { label: 'ONLY WHEELCHAIR SEATING AVAILABLE', range: '91-99%', lo: 91, hi: 99, mid: 95  },
  'sold out':                          { label: 'SOLD OUT',                       range: '100%',   lo: 100, hi: 100, mid: 100 },
};

// Ordered scarcest → most available. The headline tier for a multi-night run
// is the scarcest tier seen on any night (a run where only one night is down
// to wheelchair seats is still "selling out" from a buyer's perspective).
const WMC_AVAILABILITY_RANK = [
  'sold out',
  'only wheelchair seating available',
  'limited availability',
  'moderate availability',
  'good availability',
];

const WMC_SUB_VENUES = [
  { match: 'cabaret',        label: 'Cabaret'        },
  { match: 'hoddinott hall', label: 'Hoddinott Hall'  },
  { match: 'weston studio',  label: 'Weston Studio'   },
  { match: 'dance house',    label: 'Dance House'     },
];

function wmcParseSubVenue(rawPrefix) {
  if (!rawPrefix) return null;
  const lower = rawPrefix.toLowerCase().trim();
  for (const { match, label } of WMC_SUB_VENUES) {
    if (lower.startsWith(match)) return label;
  }
  return null;
}

/**
 * Turn the per-performance availability read from a WMC /performances page into
 * a single headline tier plus a per-night breakdown.
 *
 * Accepts either an array of raw label strings (back-compat) or an array of
 * `{ date, label }` objects (preferred — lets us report which night is scarce).
 *
 * The headline `availability` / `availabilityRange` come from the scarcest tier
 * seen on any night. Critically, `availabilityEstimate` is clamped INTO that
 * headline tier's own range, so the estimate can never contradict the range it
 * is shown alongside (previously a "91-99%" run could report an 82% estimate —
 * a cross-night average that fell below its own stated range).
 */
function wmcComputeAvailability(entries) {
  if (!entries || !entries.length) return null;

  // Normalise to { date, label } — tolerate plain strings from older callers.
  const rows = entries
    .map((e) => (typeof e === 'string' ? { date: null, label: e } : e))
    .filter((e) => e && e.label);
  if (!rows.length) return null;

  const matchTier = (label) => {
    const lower = String(label).toLowerCase().trim();
    for (const [key, tier] of Object.entries(WMC_AVAILABILITY_TIERS)) {
      if (lower.includes(key)) return { key, tier };
    }
    return null;
  };

  // One entry per performance that we could classify.
  const perf = rows
    .map((r) => {
      const m = matchTier(r.label);
      if (!m) return null;
      return {
        date:                 r.date || null,
        availability:         m.tier.label,
        availabilityRange:    m.tier.range,
        availabilityEstimate: m.tier.mid,
        _key:                 m.key,
        _tier:                m.tier,
      };
    })
    .filter(Boolean);
  if (!perf.length) return null;

  // Headline tier = scarcest across all nights (worst-first by rank).
  let bestTier = null;
  for (const rank of WMC_AVAILABILITY_RANK) {
    const hit = perf.find((p) => p._key === rank);
    if (hit) { bestTier = hit._tier; break; }
  }
  if (!bestTier) {
    bestTier = perf.map((p) => p._tier).sort((a, b) => b.mid - a.mid)[0];
  }

  // Cross-night occupancy stats from tier midpoints.
  const mids   = perf.map((p) => p._tier.mid);
  const avgMid = Math.round(mids.reduce((a, b) => a + b, 0) / mids.length);
  const minMid = Math.min(...mids);
  const maxMid = Math.max(...mids);

  // Keep the headline estimate INSIDE the headline tier's range so the two
  // numbers stay consistent (e.g. an "only wheelchair" run reports 91-99% and
  // an estimate that is also ≥91, not a lower cross-night average).
  const availabilityEstimate = Math.min(Math.max(avgMid, bestTier.lo), bestTier.hi);

  // How many nights sit in each tier — a compact, human-readable breakdown.
  const tierCounts = {};
  for (const p of perf) tierCounts[p.availability] = (tierCounts[p.availability] || 0) + 1;

  return {
    availability:         bestTier.label,
    availabilityRange:    bestTier.range,
    availabilityEstimate,
    seatingAggregate: {
      avgOccupancyPct:      avgMid,
      minOccupancyPct:      minMid,
      maxOccupancyPct:      maxMid,
      performancesWithData: perf.length,
      tierCounts,
    },
    performances: perf.map(({ _key, _tier, ...rest }) => rest),
  };
}
// ─── WMC popularity scoring ──────────────────────────────────────────────────

/**
 * Weekday demand weights for WMC.
 * Mid-week shows are harder to fill organically, so a sold-out Tuesday
 * implies stronger real demand than a sold-out Saturday.
 */
const WMC_WEEKDAY_WEIGHTS = {
  0: 0.70, // Sunday
  1: 1.00, // Monday
  2: 1.00, // Tuesday
  3: 0.95, // Wednesday
  4: 0.90, // Thursday
  5: 0.75, // Friday
  6: 0.60, // Saturday
};

/**
 * Derive a popularity score (0–100) and human-readable label for a single
 * WMC event using only data available from the current scrape.
 *
 * Inputs used:
 *   ev.availabilityEstimate  — % of seats sold (0 = empty, 100 = sold out)
 *   ev.date                  — raw date string from the production card
 *   ev.scrapedAt             — ISO timestamp set at scrape time (reference)
 *
 * Returns { popularityScore, popularityLabel } or null fields if the date
 * cannot be resolved (graceful degradation — no score is better than a wrong one).
 *
 * Algorithm:
 *   demandScore     = availabilityEstimate / 100           (0–1)
 *   leadMultiplier  = 0.4 + 0.6 * (daysUntil / 365)       (0.4–1.0, clamped)
 *   weekdayWeight   = WMC_WEEKDAY_WEIGHTS[dayOfWeek]       (0.6–1.0)
 *   raw             = demandScore * leadMultiplier * weekdayWeight * 100
 *   popularityScore = clamp(round(raw), 0, 100)
 */
function wmcComputePopularity(ev) {
  // Require a numeric availability estimate
  const estimate = ev.availabilityEstimate;
  if (estimate == null || Number.isNaN(Number(estimate))) {
    return { popularityScore: null, popularityLabel: null };
  }

  // ── 1. Resolve event date ──────────────────────────────────────────────────
  const scrapedAt = ev.scrapedAt || new Date().toISOString();
  const refDate   = new Date(scrapedAt);

  let eventDate = null;

  // Try the raw date string from the production card (e.g. "Fri 20 Jun" or
  // "20 Jun – 6 Jul 2025"). We reuse the same parse helpers used elsewhere.
  const rawDate = String(ev.date || '').trim();
  if (rawDate) {
    // Range: take the start date
    const range =
      tryParseUkRangeTwoDaysOneMonthYear(rawDate) ||
      tryParseSameMonthDayRange(rawDate)           ||
      tryParseDayMonthRangeYear(rawDate);
    if (range) {
      eventDate = range.start;
    } else {
      eventDate =
        tryParseShortUkDayMonYear(rawDate)                   ||
        tryParseDdMmYyyy(rawDate)                             ||
        tryParseWeekdayOrdinalMonthYear(rawDate)              ||
        tryParseOrdinalMonthOptionalYear(rawDate, scrapedAt)  ||
        tryParseMonthDayAtTime(rawDate, scrapedAt)            ||
        tryParseDayOrdinalMonthNoYear(rawDate, scrapedAt);
    }
  }

  // If the listing date is missing a year, also try the URL
  if (!eventDate && ev.url) {
    eventDate = tryParseDateFromListingUrl(ev.url, scrapedAt);
  }

  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    // Cannot safely compute lead-time — return null scores rather than noise
    return { popularityScore: null, popularityLabel: null };
  }

  // ── 2. Lead-time component ─────────────────────────────────────────────────
  const msPerDay   = 86_400_000;
  const daysUntil  = Math.max(0, (eventDate.getTime() - refDate.getTime()) / msPerDay);
  const leadNorm   = Math.min(daysUntil, 365) / 365;      // 0 (imminent) → 1 (≥1 year away)
  const leadMultiplier = 0.7 + 0.3 * leadNorm;   // range: 0.70 – 1.00

  // ── 3. Weekday weight ──────────────────────────────────────────────────────
  const dayOfWeek     = eventDate.getDay();                // 0=Sun … 6=Sat
  const weekdayWeight = WMC_WEEKDAY_WEIGHTS[dayOfWeek] ?? 0.85;

  // ── 4. Demand pressure ────────────────────────────────────────────────────
  const hasLimitedOrWorse  = /limited|wheelchair|sold.?out/i.test(ev.availability || '');
  const isAtLeastMonthAway = daysUntil >= 30;
  const flooredEstimate    = (hasLimitedOrWorse && isAtLeastMonthAway)
    ? Math.max(Number(estimate), 60)
    : Number(estimate);
  const demandScore        = flooredEstimate / 100;

  // ── 5. Composite ──────────────────────────────────────────────────────────
  const raw            = demandScore * leadMultiplier * weekdayWeight * 100;
  let popularityScore = Math.min(100, Math.max(0, Math.round(raw)));
  if (/wheelchair|sold.?out/i.test(ev.availability || '')) popularityScore = Math.max(popularityScore, 80);

  // ── 6. Human-readable label ───────────────────────────────────────────────
  let popularityLabel;
  if      (popularityScore >= 75) popularityLabel = 'Very high demand';
  else if (popularityScore >= 50) popularityLabel = 'High demand';
  else if (popularityScore >= 30) popularityLabel = 'Moderate demand';
  else if (popularityScore >= 15) popularityLabel = 'Low demand';
  else                            popularityLabel = 'Very low demand';

  return { popularityScore, popularityLabel };
}

async function wmcWaitForAngularBind(page, timeout = 15_000) {
  try {
    await page.waitForFunction(
      () => {
        const list = document.querySelector('.calendar-list-filter-list--performance-list');
        if (!list) return false;
        if (list.classList.contains('ng-hide')) {
          return !!document.querySelector('.events-error:not(.ng-hide)');
        }
        const availDivs = list.querySelectorAll('.calendar-list-entry__availablity');
        if (availDivs.length === 0) return true;
        return Array.from(availDivs).some((el) => !el.innerText.includes('{{'));
      },
      { timeout }
    );
  } catch {}
}

async function wmcScrapeAvailability(context, eventUrl) {
  const perfUrl = `${eventUrl.replace(/\/$/, '')}/performances`;
  const page = await context.newPage();
  try {
    await page.goto(perfUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await wmcWaitForAngularBind(page);
    const entries = await page.evaluate(() => {
      const list = document.querySelector('.calendar-list-filter-list--performance-list');
      if (!list) return [];
      const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

      // Preferred: one row per performance so we can attach a date to each
      // availability label (BEM: the availability node lives inside the entry).
      const rows = Array.from(list.querySelectorAll('.calendar-list-entry'));
      if (rows.length) {
        return rows
          .map((row) => {
            const label = clean(row.querySelector('.calendar-list-entry__availablity')?.innerText);
            const dateEl = row.querySelector(
              '.calendar-list-entry__date, .calendar-list-entry__time, time, [class*="date"], [class*="time"]'
            );
            const date = dateEl ? clean(dateEl.innerText || dateEl.textContent) : null;
            return { date: date || null, label };
          })
          .filter((e) => e.label && !e.label.includes('{{'));
      }

      // Fallback: flat availability nodes only (no per-night date available).
      return Array.from(list.querySelectorAll('.calendar-list-entry__availablity'))
        .map((el) => ({ date: null, label: clean(el.innerText) }))
        .filter((e) => e.label && !e.label.includes('{{'));
    });
    return wmcComputeAvailability(entries);
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/**
 * Extract genre labels from any block of text by scanning against GENRE_SIGNALS.
 * Returns a deduplicated array.
 */
function extractGenreSignalsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const [re, label] of GENRE_SIGNALS) {
    if (re.test(text) && !seen.has(label)) {
      seen.add(label);
      found.push(label);
    }
  }
  return found;
}

/**
 * Infer a single genre string from the event title alone (legacy helper kept
 * for the finalizeEvent fallback chain).
 */
function inferGenreFromTitle(title) {
  if (!title) return '';
  const t = title.toLowerCase();
  const pairs = [
    [/tribute|experience|vs the|sound of |celebrating /, 'Tribute / Covers'],
    [/\bdj\b| vs | b2b |club night|retro electro/, 'DJ / Club'],
    [/opera|ballet|orchestra|symphony|philharmonic/, 'Classical'],
    [/wrestling|wwe|mma|boxing|fc\b|rugby|match\b/, 'Sports'],
    [/comedy|stand[- ]?up|comedian/, 'Comedy'],
    [/musical|panto|pantomime|broadway/, 'Musical Theatre'],
  ];
  for (const [re, g] of pairs) if (re.test(t)) return g;
  return '';
}

/**
 * Determine the single primary category for an event.
 *
 * Rules applied in priority order:
 *   1. Explicit schema/listing category field (most reliable when present)
 *   2. Content signals across all text blobs (description, title, details…)
 *   3. Venue assumption as a last resort (least reliable)
 *
 * Default for music-first venues (Globe, Tramshed, Clwb, Depot, SU) = 'Music'.
 * Default for everything else = 'Other'.
 */
function inferPrimaryCategory(ev) {
  // --- 1. Explicit category field (New Theatre provides these via Trafalgar) ---
  const cat = String(ev.category || '').toLowerCase().trim();
  if (cat) {
    if (/comedy/.test(cat)) return 'Comedy';
    if (/musical/.test(cat)) return 'Musical Theatre';
    if (/opera|ballet|dance/.test(cat)) return 'Theatre';
    if (/play\b|drama|theatre/.test(cat)) return 'Theatre';
    if (/film|cinema/.test(cat)) return 'Film';
    if (/family/.test(cat)) return 'Family';
    if (/sport|wrestling|boxing|mma/.test(cat)) return 'Sports';
    if (/music/.test(cat)) return 'Music';
    if (/other|talk|lecture|event/.test(cat)) return 'Other';
  }

  // --- 2. Content signals ---
  const blob = [
    ev.title,
    ev.description,
    ev.shortDescription,
    ev.details,
    ev.genre,
    ev.subcategory,
    ev.eventKeywords,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Comedy — check before Theatre so stand-up at theatres is correct
  if (/\bstand[- ]?up\b|\bcomedian\b|\bcomedy\s*(show|night|tour|gig|special)|\blive\s*comedy\b/.test(blob)) return 'Comedy';
  if (/\bcomedy\b/.test(blob) && !/\bmusical\s*comedy\b/.test(blob)) return 'Comedy';

  // Theatre / performing arts
  if (/\bmusical\b|\bpanto\b|\bpantomime\b|\bbroadway\b|\bwest\s*end\b/.test(blob)) return 'Musical Theatre';
  if (/\bopera\b|\bballet\b/.test(blob)) return 'Theatre';
  if (/\bplay\b|\bdrama\b|\btheatre\s*company\b|\bstage\s*show\b/.test(blob)) return 'Theatre';

  // Sports
  if (/\bwrestling\b|\bwwe\b|\bmma\b|\bboxing\b|\bfc\b|\brugby\b/.test(blob)) return 'Sports';

  // Film
  if (/\bfilm\b|\bcinema\b|\bscreening\b/.test(blob)) return 'Film';

  // Family
  if (/\bfamily\s*(show|event|fun|friendly)\b|\bchildren['\u2019]?s\b|\bkids\b/.test(blob)) return 'Family';

  // --- 3. Venue assumption (last resort) ---
  const venue = String(ev.venue || '').toLowerCase();

  // Music-first venues — default to Music
  if (/globe\s*cardiff|tramshed|clwb\s*ifor|depot\s*cardiff|cardiff\s*su|utilita|fuel|gate/.test(venue)) return 'Music';

  // Arts/theatre venues — default to Theatre only if no music signals
  if (/new\s*theatre|millennium\s*centre|wmc|the\s*gate/.test(venue)) return 'Theatre';

  return 'Other';
}

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

function numPrice(v) {
  if (v == null) return NaN;
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  const s = String(v).trim();

  // Bail out if this looks like a range string — let normalizeOffers handle
  // ranges at a higher level; blindly stripping gives garbage like 20.5023
  if (/\d\s*[-–]\s*[£$€]?\s*\d/.test(s)) return NaN;

  // Handle European comma decimals: "16,50" → 16.50
  // Only treat comma as decimal if it's followed by exactly 2 digits at end
  const euroComma = s.replace(/^[^0-9]*/, '').match(/^(\d+),(\d{2})$/);
  if (euroComma) return Number(`${euroComma[1]}.${euroComma[2]}`);

  // Standard strip — safe now that ranges are caught above
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? NaN : n;
}

function normalizeOffers(offers) {
  if (!offers) return {};
  const list = Array.isArray(offers) ? offers : [offers];
  let low = null;
  let high = null;
  let currency = null;

  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const typ = o['@type'];
    const types = Array.isArray(typ) ? typ : typ ? [typ] : [];
    if (types.includes('AggregateOffer') || typ === 'AggregateOffer') {
      if (o.lowPrice != null) {
        const lp = numPrice(o.lowPrice);
        if (!Number.isNaN(lp)) low = low == null ? lp : Math.min(low, lp);
      }
      if (o.highPrice != null) {
        const hp = numPrice(o.highPrice);
        if (!Number.isNaN(hp)) high = high == null ? hp : Math.max(high, hp);
      }
      currency = o.priceCurrency || currency;
    }
    const ps = o.priceSpecification;
    if (ps) {
      const pss = Array.isArray(ps) ? ps : [ps];
      for (const spec of pss) {
        if (!spec || typeof spec !== 'object') continue;
        const p = numPrice(spec.price);
        if (!Number.isNaN(p)) {
          low = low == null ? p : Math.min(low, p);
          high = high == null ? p : Math.max(high, p);
          currency = spec.priceCurrency || o.priceCurrency || currency;
        }
      }
    }
    if (o.price != null) {
      const p = numPrice(o.price);
      if (!Number.isNaN(p)) {
        low = low == null ? p : Math.min(low, p);
        high = high == null ? p : Math.max(high, p);
        currency = o.priceCurrency || currency;
      }
    }
  }
  return { low, high, currency };
}

function scrapePriceFromVisibleText(text) {
  if (!text || text.length > 25_000) return {};
  const from =
    text.match(/\b(?:tickets?|entry|admission|price|from)\s*:?\s*from\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\bfrom\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\bstarting\s+at\s*£\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/\b(?:tickets?|prices?)\s+from\s*£\s*(\d+(?:\.\d+)?)/i);
  if (from) return { label: `from £${from[1]}`, low: Number(from[1]), currency: 'GBP' };
  const range = text.match(/£\s*(\d+(?:\.\d+)?)\s*[-–]\s*£\s*(\d+(?:\.\d+)?)/);
  if (range) return { label: `£${range[1]}–£${range[2]}`, low: Number(range[1]), high: Number(range[2]), currency: 'GBP' };
  const single = text.match(/£\s*(\d+(?:\.\d+)?)/);
  if (single) return { label: `£${single[1]}`, low: Number(single[1]), currency: 'GBP' };
  return {};
}

// ---------------------------------------------------------------------------
// Page enrichment (visits individual ticket pages)
// ---------------------------------------------------------------------------

async function fetchPageEnrichment(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 65_000 });
  await page.waitForLoadState('load').catch(() => {});
  const host = (() => {
    try { return new URL(url).hostname; } catch { return ''; }
  })();
  if (host.includes('tixr.com')) {
    // Tixr is a SPA — the ticket picker rows ([data-product-state]) are fetched
    // via XHR after load. A blind wait races that request and can evaluate an
    // empty picker (missing the sold-out state entirely), so wait for a real
    // ticket row to render before reading it. Fall through if it never appears.
    await page
      .waitForSelector('[data-product-state], .event-ticket-picker .ticket', { timeout: 20_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1_500));
  } else await new Promise((r) => setTimeout(r, 900));

  return page.evaluate(() => {
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';

    const eventTypes = new Set([
      'Event', 'MusicEvent', 'TheaterEvent', 'TheatreEvent',
      'ComedyEvent', 'Festival', 'SportsEvent', 'DanceEvent',
    ]);

    function typesOf(node) {
      const t = node['@type'];
      return Array.isArray(t) ? t : t ? [t] : [];
    }

    const eventNodes = [];
    const graphOfferNodes = [];
    const breadcrumbTrails = [];
    const VISIT_CAP = 900;
    let visits = 0;

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 18 || visits >= VISIT_CAP) return;
      visits++;
      if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
      const types = typesOf(node);
      if (types.some((x) => eventTypes.has(x))) eventNodes.push(node);
      if (types.some((x) => x === 'Offer' || x === 'AggregateOffer')) {
        const name = String(node.name || '').toLowerCase();
        if (!/merch|t[-]?shirt|hoodie|programme|parking|bundle\s+only|poster|vinyl|cd\b/.test(name)) {
          graphOfferNodes.push(node);
        }
      }
      if (types.includes('BreadcrumbList') && node.itemListElement) {
        const names = [];
        const els = Array.isArray(node.itemListElement) ? node.itemListElement : [node.itemListElement];
        for (const el of els) {
          if (!el || typeof el !== 'object') continue;
          let n = '';
          if (el.name) n = String(el.name).trim();
          else if (el.item && typeof el.item === 'object' && el.item.name) n = String(el.item.name).trim();
          if (n) names.push(n);
        }
        if (names.length >= 2) breadcrumbTrails.push(names.join(' > '));
      }
      for (const k of Object.keys(node)) {
        if (k === '@context') continue;
        const v = node[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    }

    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const s of scripts) {
      try { walk(JSON.parse(s.textContent), 0); } catch { /* ignore */ }
    }

    const score = (e) =>
      [e.description, e.startDate, e.endDate, e.image, e.offers, e.location, e.performer].filter(Boolean).length;
    const best = eventNodes.sort((a, b) => score(b) - score(a))[0] || null;

    function performerGenresOf(evLike) {
      if (!evLike) return '';
      const perf = evLike.performer;
      const list = Array.isArray(perf) ? perf : perf ? [perf] : [];
      const g = [];
      for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        if (p.genre) {
          if (Array.isArray(p.genre)) {
            for (const x of p.genre) { const s = String(x || '').trim(); if (s) g.push(s); }
          } else {
            const s = String(p.genre || '').trim();
            if (s) g.push(s);
          }
        }
      }
      return [...new Set(g)].join(', ');
    }

    function performerNamesOf(evLike) {
      if (!evLike) return [];
      const perf = evLike.performer;
      const list = Array.isArray(perf) ? perf : perf ? [perf] : [];
      const names = [];
      for (const p of list) {
        if (p == null) continue;
        if (typeof p === 'string') { const s = p.trim(); if (s) names.push(s); continue; }
        if (typeof p === 'object' && p.name) { const s = String(p.name).trim(); if (s) names.push(s); }
      }
      const seen = new Set();
      const out = [];
      for (const n of names) { const k = n.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(n); }
      return out;
    }

    const ogDesc = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    const ogImageRaw = meta('meta[property="og:image"]');
    const twitterImageRaw = meta('meta[name="twitter:image"]') || meta('meta[property="twitter:image"]') || '';
    const ogTitle = meta('meta[property="og:title"]');

    function absolutizeImageUrl(u) {
      const s = String(u || '').trim();
      if (!s || s.startsWith('data:')) return '';
      if (s.startsWith('//')) return `https:${s}`;
      try { return new URL(s, document.baseURI || location.href).href; } catch { return s; }
    }

    function collectLdImageUrls(val, bucket) {
      if (val == null) return;
      if (typeof val === 'string') { const a = absolutizeImageUrl(val); if (a) bucket.push(a); return; }
      if (Array.isArray(val)) { for (const x of val) collectLdImageUrls(x, bucket); return; }
      if (typeof val === 'object') {
        if (typeof val.url === 'string') collectLdImageUrls(val.url, bucket);
        if (typeof val.contentUrl === 'string') collectLdImageUrls(val.contentUrl, bucket);
      }
    }

    let description = '';
    let genre = '';
    let startDate = '';
    let endDate = '';
    const imageCandidateList = [];
    let offersFromEvent = null;
    let eventKeywords = '';
    let musicGenresFromSchema = [];
    let performerNames = [];

    if (best) {
      if (typeof best.description === 'string') description = best.description.trim();
      const g = best.genre;
      genre = Array.isArray(g) ? g.filter(Boolean).join(', ') : typeof g === 'string' ? g.trim() : '';
      const pg = performerGenresOf(best);

      const musicSet = new Set();
      const addFrom = (val) => {
        if (val == null) return;
        if (Array.isArray(val)) { for (const x of val) addFrom(x); return; }
        const s = String(val).trim();
        if (!s) return;
        for (const part of s.split(/[;,]/g)) { const q = String(part || '').trim(); if (q) musicSet.add(q); }
      };
      addFrom(g);
      addFrom(pg);
      musicGenresFromSchema = [...musicSet];
      performerNames = performerNamesOf(best);

      if (pg) {
        const parts = [...new Set([...genre.split(/,\s*/), ...pg.split(/,\s*/)].map((s) => s.trim()).filter(Boolean))];
        genre = parts.join(', ');
      }
      if (typeof best.keywords === 'string' && best.keywords.trim()) {
        eventKeywords = best.keywords.trim().slice(0, 220);
      }
      if (best.startDate) startDate = String(best.startDate);
      if (best.endDate) endDate = String(best.endDate);
      collectLdImageUrls(best.image, imageCandidateList);
      offersFromEvent = best.offers || null;
    }

    if (ogImageRaw) { const u = absolutizeImageUrl(ogImageRaw); if (u) imageCandidateList.push(u); }
    if (twitterImageRaw) { const u = absolutizeImageUrl(twitterImageRaw); if (u) imageCandidateList.push(u); }

    const imageSeen = new Set();
    const imageUrls = [];
    for (const u of imageCandidateList) {
      const key = String(u).toLowerCase();
      if (imageSeen.has(key)) continue;
      imageSeen.add(key);
      imageUrls.push(u);
    }
    const imageUrl = imageUrls[0] || '';

    if (!startDate) {
      const t =
        document.querySelector('time[datetime]') ||
        document.querySelector('[itemprop="startDate"][datetime]') ||
        document.querySelector('meta[itemprop="startDate"]');
      const raw = t?.getAttribute?.('datetime') || t?.getAttribute?.('content') || '';
      if (raw) startDate = String(raw).trim();
    }

    let breadcrumbTrail = '';
    for (const tr of breadcrumbTrails) { if (tr.length > breadcrumbTrail.length) breadcrumbTrail = tr; }

    let microLow = null;
    let microHigh = null;
    let microCur = '';
    for (const el of document.querySelectorAll('[itemprop="price"]')) {
      const raw = el.getAttribute('content') || el.textContent || '';
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(n) && n > 0) {
        microLow = microLow == null ? n : Math.min(microLow, n);
        microHigh = microHigh == null ? n : Math.max(microHigh, n);
      }
    }
    const curEl = document.querySelector('[itemprop="priceCurrency"]');
    if (curEl) microCur = (curEl.getAttribute('content') || '').trim();

    const bodyText = (document.body?.innerText || '').slice(0, 20_000);

    // ── Tixr.com: sold-out / waitlist detection + price extraction ────────────
    // Each ticket row carries data-product-state (and data-product-display-state).
    // A row has no buyable inventory when it is sold out OR waitlist-only:
    //   - sold out: either state attribute is SOLD_OUT/CLOSED, or a "Sold Out"
    //     badge is shown (Tixr isn't consistent about which signal it sets).
    //   - waitlist: the row carries a "Waitlist" badge / viewWaitlistTag action
    //     (typically alongside a QUEUED state) — you can only join a waitlist.
    // The event is effectively sold out when EVERY row is one of the above (and
    // at least one row exists). If any of those rows is a waitlist row, we flag
    // it so the event is labelled "WAITLIST AVAILABLE" rather than "SOLD OUT".
    const tixrRows = Array.from(document.querySelectorAll('[data-product-state]'));
    const UNAVAILABLE_STATES = new Set(['SOLD_OUT', 'CLOSED']);
    const rowBadgeText = (el) => {
      const badge = el.querySelector('.tag.badge, .card-badge, [action="viewWaitlistTag"]');
      return badge ? (badge.getAttribute('data-text') || badge.textContent || '') : '';
    };
    const rowIsWaitlist = (el) =>
      !!el.querySelector('[action="viewWaitlistTag"]') || /waitlist/i.test(rowBadgeText(el));
    const rowIsSoldOut = (el) => {
      const state = el.getAttribute('data-product-state');
      const displayState = el.getAttribute('data-product-display-state');
      if (UNAVAILABLE_STATES.has(state) || UNAVAILABLE_STATES.has(displayState)) return true;
      return /sold\s*out/i.test(rowBadgeText(el));
    };
    const rowHasNoInventory = (el) => rowIsSoldOut(el) || rowIsWaitlist(el);
    const tixrSoldOut = tixrRows.length > 0 && tixrRows.every(rowHasNoInventory);
    const tixrWaitlist = tixrSoldOut && tixrRows.some(rowIsWaitlist);
    // Extract the face-value price from rows you can still act on (open or
    // waitlist — a waitlist row still shows the price you'd pay). Skip only
    // genuinely sold-out rows. Prefer the base price from .itemization
    // "(£X.XX + fees)" over the all-in .price text so we report face value.
    let tixrPriceLow = null;
    let tixrPriceHigh = null;
    for (const row of tixrRows) {
      if (rowIsSoldOut(row)) continue;
      let price = null;
      const itemization = row.querySelector('.itemization');
      if (itemization) {
        const m = (itemization.innerText || '').match(/£(\d+(?:\.\d+)?)/);
        if (m) price = parseFloat(m[1]);
      }
      if (price == null) {
        const priceEl = row.querySelector('.price');
        if (priceEl) {
          const m = (priceEl.innerText || '').match(/£(\d+(?:\.\d+)?)/);
          if (m) price = parseFloat(m[1]);
        }
      }
      if (price != null && !isNaN(price) && price > 0) {
        tixrPriceLow  = tixrPriceLow  == null ? price : Math.min(tixrPriceLow,  price);
        tixrPriceHigh = tixrPriceHigh == null ? price : Math.max(tixrPriceHigh, price);
      }
    }

    // seetickets.com: sold out when every .v2-price-status says "not available"
    // AND a waiting-list sign-up is present.
    const priceStatuses = Array.from(document.querySelectorAll('.v2-price-status'));
    const hasWaitingList = !!(document.querySelector('.waiting-list-btn') || document.querySelector('#triggerSubscribe'));
    const seeTicketsSoldOut = priceStatuses.length > 0 && hasWaitingList &&
      priceStatuses.every((el) => /tickets\s+not\s+available/i.test(el.innerText || ''));

    const soldOut = tixrSoldOut || seeTicketsSoldOut;

    return {
      description: description || '',
      shortDescription: ogDesc || '',
      genre,
      musicGenresFromSchema,
      imageUrl,
      imageUrls,
      startDate,
      endDate,
      offersFromEvent,
      offersFromGraph: graphOfferNodes.slice(0, 48),
      breadcrumbTrail,
      eventKeywords,
      performerNames,
      microdataPrice:
        microLow != null && !Number.isNaN(microLow)
          ? { low: microLow, high: microHigh != null && !Number.isNaN(microHigh) ? microHigh : microLow, currency: microCur || 'GBP' }
          : null,
      ogTitle,
      bodySnippet: bodyText,
      soldOut,
      waitlist: tixrWaitlist,
      tixrPrice: tixrPriceLow != null ? { low: tixrPriceLow, high: tixrPriceHigh ?? tixrPriceLow } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Offer / price merging
// ---------------------------------------------------------------------------

function mergeOffersIntoEvent(ev, offersRaw) {
  if (!offersRaw) return ev;
  const { low, high, currency } = normalizeOffers(offersRaw);
  const out = { ...ev };
  if (low != null && !Number.isNaN(low)) {
    out.ticketPriceFrom = out.ticketPriceFrom == null || Number.isNaN(out.ticketPriceFrom)
      ? low : Math.min(out.ticketPriceFrom, low);
  }
  if (high != null && !Number.isNaN(high)) {
    out.ticketPriceTo = out.ticketPriceTo == null || Number.isNaN(out.ticketPriceTo)
      ? high : Math.max(out.ticketPriceTo, high);
  }
  if (currency) out.ticketCurrency = currency;
  return out;
}

function mergeAllOfferBlobsIntoEvent(ev, blobs) {
  const flat = [];
  for (const b of blobs) {
    if (b == null) continue;
    if (Array.isArray(b)) { for (const x of b) { if (x != null && typeof x === 'object') flat.push(x); } }
    else if (typeof b === 'object') flat.push(b);
  }
  if (!flat.length) return ev;
  return mergeOffersIntoEvent(ev, flat);
}

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

function localNoon(y, m0, d) { return new Date(y, m0, d, 12, 0, 0); }
function startOfLocalDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function inferYearForMonthDay(scrapedAt, month0, day) {
  const ref = scrapedAt ? new Date(scrapedAt) : new Date();
  const r0 = startOfLocalDay(ref);
  let y = ref.getFullYear();
  let cand = startOfLocalDay(localNoon(y, month0, day));
  if (cand < r0) {
    const daysPast = (r0 - cand) / 86400000;
    if (daysPast <= 31) return y;
    return y + 1;
  }
  return y;
}

function parseMonthToken(tok) {
  if (!tok) return -1;
  const t = String(tok).toLowerCase().replace(/\./g, '');
  const map = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const k = t.length >= 3 ? t.slice(0, 3) : t;
  if (map[k] != null) return map[k];
  const full = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < 12; i++) { if (full[i].startsWith(t)) return i; }
  return -1;
}

function formatUkLongDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
    });
  } catch { return ''; }
}

function tryParseIsoToDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseShortUkDayMonYear(s) {
  const m = String(s).match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const d = localNoon(Number(m[4]), mo, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseUkRangeTwoDaysOneMonthYear(s) {
  const m = String(s).match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s*[-–]\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[5]);
  if (mo < 0) return null;
  const y = Number(m[6]);
  const d1 = localNoon(y, mo, Number(m[2]));
  const d2 = localNoon(y, mo, Number(m[4]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseDdMmYyyy(s) {
  const m = String(s).match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const d = localNoon(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseDayOrdinalMonthNoYear(line, scrapedAt) {
  const m = String(line).trim().match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*$/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const day = Number(m[2]);
  const y = inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseOrdinalMonthOptionalYear(s, scrapedAt) {
  const m = String(s).match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*(?:\s+(\d{4}))?\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[2]);
  if (mo < 0) return null;
  const day = Number(m[1]);
  const y = m[3] ? Number(m[3]) : inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseMonthDayAtTime(s, scrapedAt) {
  const m = String(s).match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*\s+(\d{1,2})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[1]);
  if (mo < 0) return null;
  const day = Number(m[2]);
  const y = inferYearForMonthDay(scrapedAt, mo, day);
  const d = localNoon(y, mo, day);
  return Number.isNaN(d.getTime()) ? null : d;
}

function tryParseDayMonthRangeYear(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]+)\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const m1 = parseMonthToken(m[2]);
  const m2 = parseMonthToken(m[4]);
  const y = Number(m[5]);
  if (m1 < 0 || m2 < 0) return null;
  const d1 = localNoon(y, m1, Number(m[1]));
  const d2 = localNoon(y, m2, Number(m[3]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseSameMonthDayRange(s) {
  const m = String(s).match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  const y = Number(m[4]);
  if (mo < 0) return null;
  const d1 = localNoon(y, mo, Number(m[1]));
  const d2 = localNoon(y, mo, Number(m[2]));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  return { start: d1, end: d2 };
}

function tryParseWeekdayOrdinalMonthYear(s) {
  const m = String(s).match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/i);
  if (!m) return null;
  const mo = parseMonthToken(m[3]);
  if (mo < 0) return null;
  const d = localNoon(Number(m[4]), mo, Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstMeaningfulLine(text) {
  if (!text) return '';
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || '';
}

function formatRangeLong(a, b) {
  const fa = formatUkLongDate(a);
  const fb = formatUkLongDate(b);
  if (!fa || !fb) return fa || fb;
  if (a.getTime() === b.getTime()) return fa;
  return `${fa} – ${fb}`;
}

function tryParseDateFromListingUrl(url, scrapedAt) {
  if (!url || typeof url !== 'string') return null;
  const u = url.toLowerCase();
  const m1 = u.match(/(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4})\b/);
  if (m1) {
    const mo = parseMonthToken(m1[2]);
    if (mo < 0) return null;
    const d = localNoon(Number(m1[3]), mo, Number(m1[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m2 = u.match(/(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:-tickets|-[a-z0-9-]*tickets)/);
  if (m2) {
    const mo = parseMonthToken(m2[2]);
    if (mo < 0) return null;
    const day = Number(m2[1]);
    const y = inferYearForMonthDay(scrapedAt, mo, day);
    const d = localNoon(y, mo, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function deriveHumanEventDate(ev) {
  const scrapedAt = ev.scrapedAt || '';
  const rawDate = ev.date != null ? String(ev.date).trim() : '';
  const weakListingDate = rawDate && !/\d{4}/.test(rawDate);
  const blobs = [
    ev.eventStartDate,
    ...(weakListingDate ? [] : rawDate ? [rawDate] : []),
    firstMeaningfulLine(ev.details),
    firstMeaningfulLine(ev.description),
    firstMeaningfulLine(ev.shortDescription),
    ...(weakListingDate ? [rawDate] : []),
  ].filter(Boolean);

  const isoStart = tryParseIsoToDate(ev.eventStartDate);
  const isoEnd = tryParseIsoToDate(ev.eventEndDate);
  if (isoStart) {
    if (isoEnd && isoEnd.getTime() !== isoStart.getTime()) {
      const s0 = startOfLocalDay(isoStart);
      const s1 = startOfLocalDay(isoEnd);
      if (s0.getTime() !== s1.getTime()) return formatRangeLong(isoStart, isoEnd);
    }
    return formatUkLongDate(isoStart);
  }

  const urlDate = tryParseDateFromListingUrl(ev.url, scrapedAt);
  if (urlDate) return formatUkLongDate(urlDate);

  for (const raw of blobs) {
    const s = String(raw).trim();
    if (!s) continue;
    const r1 = tryParseUkRangeTwoDaysOneMonthYear(s.replace(/\s+/g, ' '));
    if (r1) return formatRangeLong(r1.start, r1.end);
    const r2 = tryParseDayMonthRangeYear(s);
    if (r2) return formatRangeLong(r2.start, r2.end);
    const r3 = tryParseSameMonthDayRange(s);
    if (r3) return formatRangeLong(r3.start, r3.end);
    const dShort = tryParseShortUkDayMonYear(s);
    if (dShort) return formatUkLongDate(dShort);
    const dSlash = tryParseDdMmYyyy(s);
    if (dSlash) return formatUkLongDate(dSlash);
    const gateDt = tryParseWeekdayOrdinalMonthYear(s);
    if (gateDt) return formatUkLongDate(gateDt);
    const dOrd = tryParseOrdinalMonthOptionalYear(s, scrapedAt);
    if (dOrd) return formatUkLongDate(dOrd);
    const dMonDay = tryParseMonthDayAtTime(s, scrapedAt);
    if (dMonDay) return formatUkLongDate(dMonDay);
    const dLine = tryParseDayOrdinalMonthNoYear(firstMeaningfulLine(s) || s, scrapedAt);
    if (dLine) return formatUkLongDate(dLine);
  }

  for (const raw of blobs) {
    const s = String(raw).trim();
    if (/\d{4}/.test(s) && s.length >= 8) return s;
  }

  const hay = [ev.title, rawDate, ev.details, ev.description, ev.shortDescription].filter(Boolean).join('\n');
  const h = hay.replace(/\s+/g, ' ');
  const rRange = tryParseUkRangeTwoDaysOneMonthYear(h);
  if (rRange) return formatRangeLong(rRange.start, rRange.end);
  const rDm = tryParseDayMonthRangeYear(hay);
  if (rDm) return formatRangeLong(rDm.start, rDm.end);
  const rSame = tryParseSameMonthDayRange(hay);
  if (rSame) return formatRangeLong(rSame.start, rSame.end);
  const dS = tryParseShortUkDayMonYear(h);
  if (dS) return formatUkLongDate(dS);
  const dSlash = tryParseDdMmYyyy(h);
  if (dSlash) return formatUkLongDate(dSlash);

  return '';
}

// ---------------------------------------------------------------------------
// Genre / music genre helpers
// ---------------------------------------------------------------------------

function tidyBreadcrumbTrail(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  const noise = /^(home|events|what'?s\s*on|ticket(s)?|shop|store)\s*>\s*/i;
  for (let i = 0; i < 6 && noise.test(t); i++) t = t.replace(noise, '');
  return t.replace(/^>\s*|\s*>$/g, '').trim();
}

const GENERIC_LISTING_CATEGORIES = new Set([
  "what's on", 'whats on', 'events', 'home', 'tickets', 'ticket',
  'box office', 'venue', 'live music', 'music', 'whatson', 'what\u2019s on',
]);

function categoryAsGenreHint(raw) {
  const c = String(raw || '').trim();
  if (!c) return '';
  const low = c.toLowerCase().replace(/\s+/g, ' ');
  if (GENERIC_LISTING_CATEGORIES.has(low)) return '';
  return c;
}

function subcategoryLineAsGenreHint(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 72 || />/.test(s)) return '';
  return s.split(';')[0].trim();
}

function splitGenreStringToMusicGenres(genreString) {
  if (!genreString || typeof genreString !== 'string') return [];
  const parts = genreString.split(/[,;]/g).map((s) => String(s || '').trim()).filter(Boolean);
  return parts.slice(0, 12);
}

function unionMusicGenres(existing, incoming) {
  const out = [];
  const seen = new Set();
  const add = (s) => {
    if (s == null) return;
    const str = String(s).trim();
    if (!str) return;
    const k = str.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(str);
  };
  for (const s of existing || []) add(s);
  for (const s of incoming || []) add(s);
  return out;
}

// ---------------------------------------------------------------------------
// MusicBrainz genre lookup
// ---------------------------------------------------------------------------

function normalizeArtistNameForMb(name) {
  if (!name) return '';
  return String(name).replace(/\s+/g, ' ').trim();
}

function extractMusicBrainzGenreNames(mbArtistJson) {
  if (!mbArtistJson || typeof mbArtistJson !== 'object') return [];
  const list = Array.isArray(mbArtistJson.genres)
    ? mbArtistJson.genres
    : Array.isArray(mbArtistJson.tags) ? mbArtistJson.tags : [];
  const out = [];
  const seen = new Set();
  for (const g of list) {
    if (g == null) continue;
    const name = typeof g === 'string' ? g : g.name || g.genre || g.tag || '';
    const s = String(name || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Genre tags on MusicBrainz that indicate a Welsh-language artist
const MB_WELSH_LANGUAGE_TAGS = new Set([
  'canu pop cymraeg',
  'welsh language',
  'cerdd dant',
  'caneuon gwerin cymraeg',
  'welsh folk',
  'cymraeg',
  'welsh hip hop',
  'welsh language music',
  'welsh language rock',
  'welsh psychedelia',
]);

/**
 * Fetch genres AND Welsh-language signal for a single artist from MusicBrainz.
 * Returns { genres: string[], isWelshLanguage: boolean }.
 * Results are cached by lowercased artist name.
 */
async function fetchMusicBrainzArtistData(artistName, cacheByKey, mbUserAgent) {
  const raw = normalizeArtistNameForMb(artistName);
  if (!raw) return { genres: [], isWelshLanguage: false };
  const key = raw.toLowerCase();
  if (cacheByKey.has(key)) return cacheByKey.get(key);
  const p = (async () => {
    try {
      const q = `artist:${raw}`;
      const searchUrl = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
      const searchRes = await axios.get(searchUrl, { headers: { 'User-Agent': mbUserAgent }, timeout: 15_000 });
      const mbid = searchRes?.data?.artists?.[0]?.id;
      if (!mbid) return { genres: [], isWelshLanguage: false };
      const artistUrl = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=genres+tags+area&fmt=json`;
      const artistRes = await axios.get(artistUrl, { headers: { 'User-Agent': mbUserAgent }, timeout: 15_000 });
      const data = artistRes?.data;
      const genres = extractMusicBrainzGenreNames(data);

      // Welsh-language signal: any MB tag/genre name overlapping with known Welsh tags
      const allTagNames = [
        ...( Array.isArray(data?.genres) ? data.genres : [] ),
        ...( Array.isArray(data?.tags)   ? data.tags   : [] ),
      ].map((t) => String(t?.name || t?.tag || t || '').toLowerCase().trim()).filter(Boolean);

      const isWelshLanguage = allTagNames.some((t) => MB_WELSH_LANGUAGE_TAGS.has(t));

      return { genres, isWelshLanguage };
    } catch { return { genres: [], isWelshLanguage: false }; }
  })();
  cacheByKey.set(key, p);
  return p;
}

// Kept for callers that only need genres (backwards-compatible shim)
async function fetchMusicBrainzGenresForArtistName(artistName, cacheByKey, mbUserAgent) {
  const { genres } = await fetchMusicBrainzArtistData(artistName, cacheByKey, mbUserAgent);
  return genres;
}

// ---------------------------------------------------------------------------
// Image URL helpers
// ---------------------------------------------------------------------------

const IMAGE_TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id',
  'fbclid','gclid','mc_cid','mc_eid','msclkid','_ga','ref',
]);

function normalizeHotlinkImageUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.startsWith('data:')) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    for (const k of [...u.searchParams.keys()]) {
      const lk = k.toLowerCase();
      if (IMAGE_TRACKING_PARAMS.has(lk) || lk.startsWith('utm_')) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return s; }
}

function dedupeHotlinkImageUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const n = normalizeHotlinkImageUrl(raw);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function mergeHotlinkImagesIntoEvent(ev, en) {
  const listingPool = [];
  if (ev.imageUrl) listingPool.push(ev.imageUrl);
  if (Array.isArray(ev.imageUrls)) listingPool.push(...ev.imageUrls);
  const detailPool = [];
  if (en?.imageUrl) detailPool.push(en.imageUrl);
  if (Array.isArray(en?.imageUrls)) detailPool.push(...en.imageUrls);
  const listing = dedupeHotlinkImageUrls(listingPool);
  const detail = dedupeHotlinkImageUrls(detailPool);
  const out = { ...ev };
  if (detail.length) {
    out.imageUrl = detail[0];
    out.imageUrls = dedupeHotlinkImageUrls([...detail, ...listing]).slice(0, 16);
    return out;
  }
  if (listing.length) {
    if (!String(out.imageUrl || '').trim()) out.imageUrl = listing[0];
    out.imageUrls = listing.slice(0, 16);
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enrichment merging
// ---------------------------------------------------------------------------

function mergeEnrichmentIntoEvent(ev, en) {
  if (!en) return ev;
  let out = { ...ev };

  const desc = (en.description || '').trim();
  const shortD = (en.shortDescription || '').trim();
  if (desc && desc.length > (out.description || '').length) out.description = desc;
  if (shortD) {
    out.shortDescription = shortD;
    if (!out.description) out.description = shortD;
  }
  if (en.genre && !out.genre) out.genre = en.genre;

  // Schema-derived music genres
  const schemaMusicGenres = Array.isArray(en.musicGenresFromSchema) ? en.musicGenresFromSchema : [];
  if (schemaMusicGenres.length) {
    const existing = Array.isArray(out.musicGenres) ? out.musicGenres : [];
    const merged = unionMusicGenres(existing, schemaMusicGenres);
    if (merged.length) out.musicGenres = merged;
  }


  out = mergeHotlinkImagesIntoEvent(out, en);

  if (en.startDate) out.eventStartDate = en.startDate;
  if (en.endDate) out.eventEndDate = en.endDate;

  out = mergeAllOfferBlobsIntoEvent(out, [en.offersFromEvent, en.offersFromGraph]);

  if (en.microdataPrice && en.microdataPrice.low != null && !Number.isNaN(en.microdataPrice.low)) {
    const low = en.microdataPrice.low;
    const high = en.microdataPrice.high;
    if (out.ticketPriceFrom == null || Number.isNaN(out.ticketPriceFrom)) {
      out.ticketPriceFrom = low;
      if (high != null && !Number.isNaN(high) && high !== low) out.ticketPriceTo = high;
      out.ticketCurrency = en.microdataPrice.currency || out.ticketCurrency || 'GBP';
    }
  }

  if (en.soldOut && !out.availability) {
    // A waitlist-only event has no buyable inventory (100% gone) but still lets
    // people join a waitlist, so surface that distinction rather than a flat
    // "SOLD OUT".
    out.availability         = en.waitlist ? 'WAITLIST AVAILABLE' : 'SOLD OUT';
    out.availabilityRange    = '100%';
    out.availabilityEstimate = 100;
  }

  const trail = tidyBreadcrumbTrail(en.breadcrumbTrail);
  if (trail && !out.subcategory) out.subcategory = trail;
  if (en.eventKeywords && !out.eventKeywords) out.eventKeywords = String(en.eventKeywords).trim();

  if (out.ticketPriceFrom == null && en.bodySnippet) {
    const vis = scrapePriceFromVisibleText(en.bodySnippet);
    if (vis.low != null) {
      out.ticketPriceFrom = vis.low;
      if (vis.high != null) out.ticketPriceTo = vis.high;
      out.ticketCurrency = vis.currency || 'GBP';
      out.ticketPriceLabel = vis.label;
    }
  }

  // tixr.com face-value price (last resort — used when no structured price found)
  if (out.ticketPriceFrom == null && en.tixrPrice) {
    out.ticketPriceFrom = en.tixrPrice.low;
    if (en.tixrPrice.high !== en.tixrPrice.low) out.ticketPriceTo = en.tixrPrice.high;
    out.ticketCurrency = out.ticketCurrency || 'GBP';
  }

  return out;
}

function tryAttachPriceFromListingText(ev) {
  if (ev.ticketPriceFrom != null && !Number.isNaN(ev.ticketPriceFrom)) return ev;
  const blob = [ev.details, ev.description, ev.shortDescription, ev.title].filter(Boolean).join('\n');
  const vis = scrapePriceFromVisibleText(blob);
  if (vis.low == null) return ev;
  return {
    ...ev,
    ticketPriceFrom: vis.low,
    ...(vis.high != null ? { ticketPriceTo: vis.high } : {}),
    ticketCurrency: vis.currency || ev.ticketCurrency || 'GBP',
    ticketPriceLabel: vis.label || ev.ticketPriceLabel,
  };
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function addTag(ev, tag) {
  const existing = Array.isArray(ev.tags) ? ev.tags : [];
  if (existing.includes(tag)) return ev;
  return { ...ev, tags: [...existing, tag] };
}

// ---------------------------------------------------------------------------
// Event finalisation
// ---------------------------------------------------------------------------

function finalizeEvent(ev) {
  // --- Build musicGenres array ---
  let musicGenres = Array.isArray(ev.musicGenres) ? [...ev.musicGenres] : [];

  // Supplement from genre string if musicGenres is empty
  if (!musicGenres.length && ev.genre) {
    musicGenres = splitGenreStringToMusicGenres(ev.genre);
  }

  // Supplement from title signals if still empty
  if (!musicGenres.length) {
    const titleSignals = extractGenreSignalsFromText(ev.title);
    if (titleSignals.length) musicGenres = titleSignals;
  }


  // --- Build genre string (human-readable) ---
  const musicGenreHint = musicGenres.length ? musicGenres.join(', ') : '';
  const genre = (
    ev.genre ||
    musicGenreHint ||
    categoryAsGenreHint(ev.category) ||
    ''
  ).trim();

  // --- Primary category (uses the improved function) ---
  const primaryCategory = inferPrimaryCategory({ ...ev, genre, musicGenres });

  // For non-music events, clear musicGenres to avoid noise
  // (e.g. a comedy show description mentioning "rock music" as context)
  const cleanedMusicGenres = primaryCategory === 'Music' ? musicGenres : [];

  const description =
    (ev.description || '').trim() ||
    (ev.shortDescription || '').trim() ||
    (ev.details || '').trim() ||
    '';

  let next = {
    ...ev,
    primaryCategory,
    ...(genre ? { genre } : {}),
    ...(description ? { description } : {}),
    ...(cleanedMusicGenres.length ? { musicGenres: cleanedMusicGenres } : {}),
  };

  // Remove musicGenres key entirely for non-music events to keep JSON clean
  if (primaryCategory !== 'Music') delete next.musicGenres;

  const date = deriveHumanEventDate(next);
  if (date) next.date = date;

  next = tryAttachPriceFromListingText(next);

  if (next.ticketPriceFrom != null && !next.ticketPriceLabel) {
    const cur = next.ticketCurrency || 'GBP';
    const sym = cur === 'GBP' ? '£' : `${cur} `;
    next.ticketPriceLabel =
      next.ticketPriceTo != null && next.ticketPriceTo !== next.ticketPriceFrom
        ? `${sym}${next.ticketPriceFrom}–${sym}${next.ticketPriceTo}`
        : `${sym}${next.ticketPriceFrom}`;
  }

  next = mergeHotlinkImagesIntoEvent(next, null);

  return next;
}

// ---------------------------------------------------------------------------
// Enrichment pipeline
// ---------------------------------------------------------------------------

async function enrichAllEvents(context, allEvents) {
  if (SKIP_ENRICH) {
    console.log('\nSkipping detail enrichment (SCRAPE_NO_ENRICH=1).');
    return allEvents.map(finalizeEvent);
  }

  const gateListing = 'https://www.thegate.org.uk/whats-on';
  const uniqueUrls = [
    ...new Set(
      allEvents
        .map((e) => e.url)
        .filter((u) => u && /^https?:\/\//i.test(u) && u.split('?')[0] !== gateListing)
    ),
  ];

  console.log(`\nEnriching ${uniqueUrls.length} unique ticket URLs (concurrency ${ENRICH_CONCURRENCY})...`);
  const cache = new Map();
  const queue = [...uniqueUrls];
  let done = 0;

  async function worker() {
    const page = await context.newPage();
    try {
      while (queue.length) {
        const url = queue.shift();
        try {
          const raw = await fetchPageEnrichment(page, url);
          cache.set(url, raw);
        } catch { cache.set(url, null); }
        done++;
        if (done % 40 === 0 || done === uniqueUrls.length) {
          console.log(`  enriched ${done}/${uniqueUrls.length}`);
        }
      }
    } finally { await page.close(); }
  }

  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));

  const WANT_MUSICBRAINZ = process.env.SCRAPE_MUSICBRAINZ === '1';
  const mbUserAgent = process.env.SCRAPE_MUSICBRAINZ_USER_AGENT || 'cardiff-gigs/1.0 (music genre enrichment)';
  const mbCacheByKey = new Map();
  const MUSICBRAINZ_CONCURRENCY = 3;

  const merged = new Array(allEvents.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: MUSICBRAINZ_CONCURRENCY }, async () => {
      while (i < allEvents.length) {
        const idx = i++;
        const ev = allEvents[idx];
        const en = ev.url ? cache.get(ev.url) : null;
        let out = mergeEnrichmentIntoEvent(ev, en);

        const performerNames = en && Array.isArray(en.performerNames) ? en.performerNames : [];

        // Welsh-acts file check (no MB needed — runs always)
        const welshByList = performerNames.some((n) => WELSH_ACTS.has(n.toLowerCase().trim()));
        if (welshByList) out = addTag(out, 'Welsh Language');

        if (WANT_MUSICBRAINZ && performerNames.length) {
          const needsGenres = !Array.isArray(out.musicGenres) || out.musicGenres.length === 0;
          let mergedGenres = Array.isArray(out.musicGenres) ? out.musicGenres : [];
          const names = performerNames.slice(0, 3);
          for (const n of names) {
            const { genres, isWelshLanguage } = await fetchMusicBrainzArtistData(n, mbCacheByKey, mbUserAgent);
            if (isWelshLanguage) out = addTag(out, 'Welsh Language');
            if (needsGenres) {
              mergedGenres = unionMusicGenres(mergedGenres, genres);
              if (mergedGenres.length >= 8) break;
            }
          }
          if (mergedGenres.length) out.musicGenres = mergedGenres;
        }

        merged[idx] = finalizeEvent(out);
      }
    })
  );

  return merged;
}

// ---------------------------------------------------------------------------
// Venue scrapers
// ---------------------------------------------------------------------------

async function scrapeGlobe(context) {
  console.log('Scraping The Globe...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.globecardiff.co.uk/listings/', 'article.elementor-post');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('.elementor-post__thumbnail img, .elementor-post__card img, figure img, img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
        details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
        url: item.querySelector('h3.elementor-post__title a')?.href || '',
        venue: 'The Globe Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Globe: ${events.length} events`);
  return events;
}
async function scrapeWMC(context) {
  console.log('Scraping WMC...');
  const page = await context.newPage();
 
  // Retry listing load up to 3 times if Angular doesn't render cards
  let events = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await gotoAndSettle(page, 'https://www.wmc.org.uk/en/whats-on/events', 'div.production-card');
    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll('div.production-card');
        if (cards.length === 0) return false;
        const title = cards[0].querySelector('h4.production-card__title');
        return title && !title.innerText.includes('{{');
      },
      { timeout: 25_000 }
    ).catch(() => {});
 
    events = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('div.production-card')).map((item) => {
        let imageUrl = '';
        const img = item.querySelector('img[src], img[data-src], img[data-lazy-src]');
        if (img) {
          const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
          if (raw && !raw.startsWith('data:')) {
            try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
          }
        }
        const prefixEl = item.querySelector('p.production-card__prefix');
        const prefix = (!prefixEl || prefixEl.getAttribute('aria-hidden') === 'true')
          ? '' : prefixEl.innerText.trim();
        return {
          title:     item.querySelector('h4.production-card__title')?.innerText.trim() || '',
          date:      item.querySelector('p.production-card__date')?.innerText.trim() || '',
          url:       item.querySelector('a.production-card__link-overlay')?.href || '',
          venue:     'Wales Millennium Centre',
          scrapedAt: new Date().toISOString(),
          _prefix:   prefix,
          ...(imageUrl ? { imageUrl } : {}),
        };
      }).filter((e) => e.title);
    });
 
    if (events.length > 0) break;
    console.log(`  WMC: 0 cards on attempt ${attempt}, retrying...`);
    await new Promise(r => setTimeout(r, 3_000));
  }
 
  // Resolve sub-venues
  for (const event of events) {
    const subVenue = wmcParseSubVenue(event._prefix);
    if (subVenue) event.subVenue = subVenue;
    delete event._prefix;
  }
 
  await page.close();
  console.log(`  WMC: ${events.length} events found, fetching availability + descriptions...`);
 
  // ── Description fetch: concurrency 4 ──────────────────────────────────────
  const DESC_CONCURRENCY = 4;
  async function fetchDescription(event) {
    if (!event.url) return;
    const descPage = await context.newPage();
    try {
      await descPage.goto(event.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Wait for Angular to render the production detail content.
      // Try for up to 6 s; fall through gracefully if it never appears.
      await descPage.waitForSelector('.production-details, .o-lede, [class*="elemental"]', { timeout: 6_000 }).catch(() => {});
      await descPage.waitForTimeout(1000);
      const pageData = await descPage.evaluate(() => {
        // Description — try structured elemental content blocks first
        const detailsEl = document.querySelector('.production-details');
        let description = '';
        if (detailsEl) {
          const contentBlocks = detailsEl.querySelectorAll('.dnadesign__elemental__models__elementcontent .content-element__content');
          const paragraphs = [];
          contentBlocks.forEach(block => {
            // Only skip blocks that are *entirely* a .o-well (practical info box);
            // blocks that merely contain one should still yield their other paragraphs.
            const wells = block.querySelectorAll('.o-well');
            block.querySelectorAll('p').forEach(p => {
              // skip paragraphs that live inside an .o-well
              let inWell = false;
              for (const w of wells) { if (w.contains(p)) { inWell = true; break; } }
              if (inWell) return;
              // Use textContent rather than innerText: wow.js starts elements with
              // visibility:hidden, and innerText returns "" for hidden elements.
              const text = (p.textContent || '').trim();
              if (text) paragraphs.push(text);
            });
          });
          if (paragraphs.length) {
            description = paragraphs.join('\n\n');
          } else {
            // Fallbacks: lede, any paragraph, or the whole details block text
            const lede = detailsEl.querySelector('p.o-lede, .o-lede p');
            if (lede) {
              description = (lede.textContent || '').trim();
            } else {
              const firstP = detailsEl.querySelector('p');
              description = (firstP?.textContent || detailsEl.textContent || '').trim().slice(0, 1000);
            }
          }
        }
        // Last-resort: og:description meta tag
        if (!description) {
          description = document.querySelector('meta[property="og:description"], meta[name="description"]')?.getAttribute('content')?.trim() || '';
        }

        // Sub-venue from event page header (fallback when card had no prefix)
        // textContent used for the same visibility reason
        const headerVenue = (document.querySelector('.production-header__venue')?.textContent || '').trim();

        // Booking ticket URL from the CTA button
        const ticketUrl = document.querySelector('.production-header__cta a[href]')?.href || '';

        // Price shown on the booking button
        const ticketPrice = (document.querySelector('.production-header__btn-price')?.textContent || '').trim();

        // On-sale schedule (.production-header__onsale) — only rendered when the
        // production isn't bookable yet but has scheduled pre-sale/public on-sale
        // dates. Grab the "on sale to public" tier (or the last tier if there's
        // no public one) so we can show a real date instead of guessing at
        // availability. textContent is used since these items can be ng-hide'd.
        let onSaleDate = '';
        const onsaleEl = document.querySelector('.production-header__onsale');
        if (onsaleEl && onsaleEl.getAttribute('aria-hidden') !== 'true') {
          const items = Array.from(onsaleEl.querySelectorAll('.production-header__onsale-item'));
          const publicItem = items.find((it) =>
            /public/i.test((it.querySelector('.production-header__onsale-label')?.textContent || ''))
          ) || items[items.length - 1];
          if (publicItem) {
            onSaleDate = (publicItem.querySelector('.production-header__onsale-date')?.textContent || '').trim();
          }
        }

        return { description, headerVenue, ticketUrl, ticketPrice, onSaleDate };
      });

      event.description = pageData.description;

      // Apply sub-venue from header if not already resolved from listing card prefix
      if (!event.subVenue && pageData.headerVenue) {
        const subVenue = wmcParseSubVenue(pageData.headerVenue);
        if (subVenue) event.subVenue = subVenue;
      }

      // Stash ticket URL, price and on-sale date for use in the availability pass
      if (pageData.ticketUrl) event._ticketUrl = pageData.ticketUrl;
      if (pageData.onSaleDate) event._onSaleDate = pageData.onSaleDate;
      if (pageData.ticketPrice && !event.ticketPriceLabel) {
        const m = pageData.ticketPrice.match(/£(\d+(?:\.\d+)?)/);
        if (m) {
          event.ticketPriceFrom = Number(m[1]);
          event.ticketPriceTo   = Number(m[1]);
          event.ticketCurrency  = 'GBP';
          event.ticketPriceLabel = `£${m[1]}`;
        }
      }
    } catch (err) {
      console.warn(`  WMC: could not scrape description for ${event.url}: ${err.message}`);
      event.description = '';
    } finally {
      await descPage.close();
    }
  }

  // Run descriptions in batches of DESC_CONCURRENCY
  for (let i = 0; i < events.length; i += DESC_CONCURRENCY) {
    await Promise.all(events.slice(i, i + DESC_CONCURRENCY).map(fetchDescription));
  }

  // ── Availability (sequential — hits /performances sub-page, with ticket-page fallback) ──
  for (const event of events) {
    if (!event.url) continue;
    const computed = await wmcScrapeAvailability(context, event.url);
    if (computed) {
      event.availability         = computed.availability;
      event.availabilityRange    = computed.availabilityRange;
      event.availabilityEstimate = computed.availabilityEstimate;
      if (computed.seatingAggregate) event.seatingAggregate = computed.seatingAggregate;
      if (computed.performances && computed.performances.length > 1) {
        event.performances = computed.performances;
      }
      Object.assign(event, wmcComputePopularity(event));
    } else if (event._onSaleDate) {
      // Not bookable yet, but the page told us exactly when it goes on sale —
      // show that instead of guessing at a tier or a generic "unknown".
      event.availability         = `Tickets on sale: ${event._onSaleDate}`;
      event.availabilityRange    = null;
      event.availabilityEstimate = null;
      Object.assign(event, wmcComputePopularity(event));
    } else if (event._ticketUrl) {
      // No /performances page — check the direct booking page for sold-out status
      const bestAvailUrl = event._ticketUrl.replace(
        /\/en\/booking\/production\/(\d+)$/,
        '/en/booking/production/bestavailable/$1'
      );
      const ticketPage = await context.newPage();
      try {
        await ticketPage.goto(bestAvailUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await ticketPage.waitForTimeout(1000);
        const soldOut = await ticketPage.evaluate(() => {
          const content = document.querySelector('.content.group, #page-content');
          if (!content) return false;
          return /\bsold\s*out\b/i.test(content.innerText || '');
        });
        if (soldOut) {
          event.availability         = 'SOLD OUT';
          event.availabilityRange    = '100%';
          event.availabilityEstimate = 100;
        } else {
          // No seat-map/tier breakdown is exposed on this page — it's just an
          // unreserved "on sale" or not-yet-public "upcoming" allocation, so
          // there's no real signal to estimate a tier from. Don't guess.
          event.availability         = 'UNKNOWN';
          event.availabilityRange    = null;
          event.availabilityEstimate = null;
        }
        Object.assign(event, wmcComputePopularity(event));
      } catch {
        // leave availability unset
      } finally {
        await ticketPage.close();
      }
    }
    delete event._ticketUrl;
    delete event._onSaleDate;
  }

  const withAvailability = events.filter((e) => e.availability).length;
  const withSubVenue     = events.filter((e) => e.subVenue).length;
  const withDescription  = events.filter((e) => e.description).length;
  console.log(`  WMC: done. ${withAvailability}/${events.length} with availability, ${withSubVenue}/${events.length} with sub-venue, ${withDescription}/${events.length} with description.`);
  return events;
}

// ─── New Theatre availability + popularity helpers ────────────────────────────

/**
 * NT weekday demand weights.
 * Trafalgar Tickets shows have more Saturday matinees than WMC, so Saturday
 * is bumped slightly vs the WMC table.
 */
const NT_WEEKDAY_WEIGHTS = {
  0: 0.70, // Sunday
  1: 1.00, // Monday
  2: 1.00, // Tuesday
  3: 0.95, // Wednesday
  4: 0.90, // Thursday
  5: 0.75, // Friday
  6: 0.70, // Saturday (higher than WMC — more matinees fill naturally)
};

// Fixed estimate for events where seating is intentionally skipped
// (all-green status, no "selling fast" flag).
const NT_GOOD_ONLY_ESTIMATE = 40;

// Max individual booking pages to visit per event when seating IS scraped.
// Singin'-in-the-Rain data shows variance across a 15-perf run is ≤14 pts,
// so 8 samples captures the spread without visiting every page.
const NT_MAX_SEATING_PAGES = 8;

// Concurrency for detail + seating pages within scrapeNewTheatre.
const NT_DETAIL_CONCURRENCY = 5;

function ntOccupancyToLabel(pct) {
  if (pct == null) return null;
  if (pct >= 100)  return 'sold out';
  if (pct >= 85)   return 'limited';
  return 'good';
}

/**
 * Derive availability fields from seating scrape results.
 * Mirrors the deriveAvailabilityFields logic from debug.js.
 */
function ntDeriveAvailabilityFields(performances, sellingFast, seatingResults, skippedSeating) {
  const occMap = new Map();
  for (const s of seatingResults) {
    if (s.seating?.occupancyPct != null) occMap.set(s.bookingUrl, s.seating.occupancyPct);
  }

  const enriched = performances.map(p => {
    const occ          = occMap.get(p.bookingUrl) ?? null;
    const derivedLabel = ntOccupancyToLabel(occ);
    return {
      ...p,
      occupancyPct:       occ,
      statusLabel:        p.statusLabel || derivedLabel || '',
      derivedStatusLabel: derivedLabel,
    };
  });

  const occs      = enriched.map(p => p.occupancyPct).filter(v => v != null);
  const allLabels = enriched.map(p => p.statusLabel).filter(Boolean);
  const allSoldOut = allLabels.length > 0 && allLabels.every(l => l === 'sold out');
  const hasLimited = allLabels.some(l => l === 'limited') ||
                     (occs.length > 0 && Math.max(...occs) >= 85);

  let availabilityEstimate, availabilityRange, availability;

  if (occs.length > 0) {
    availabilityEstimate = Math.round(occs.reduce((a, b) => a + b, 0) / occs.length);
    const lo = Math.floor(availabilityEstimate / 10) * 10;
    const hi = Math.min(100, lo + 10);
    availabilityRange    = `${lo}-${hi}%`;
    const worstLabel     = ntOccupancyToLabel(Math.max(...occs));
    const suffix         = sellingFast ? ' - SELLING FAST' : '';
    availability         = (allSoldOut ? 'SOLD OUT' : (worstLabel || 'GOOD').toUpperCase()) + suffix;

  } else if (skippedSeating) {
    availabilityEstimate = NT_GOOD_ONLY_ESTIMATE;
    availabilityRange    = '20-50%';
    availability         = 'GOOD';

  } else if (allSoldOut) {
    availability = 'SOLD OUT'; availabilityEstimate = 100; availabilityRange = '100%';
  } else if (hasLimited) {
    availabilityEstimate = sellingFast ? 87 : 78;
    availabilityRange    = '75-90%';
    availability         = sellingFast ? 'LIMITED - SELLING FAST' : 'LIMITED';
  } else {
    availabilityEstimate = 50;
    availabilityRange    = '40-60%';
    availability         = 'GOOD - SELLING FAST';
  }

  const seatingAggregate = occs.length > 0 ? {
    avgOccupancyPct:      availabilityEstimate,
    maxOccupancyPct:      Math.max(...occs),
    minOccupancyPct:      Math.min(...occs),
    totalAvailable:       seatingResults.reduce((a, s) => a + (s.seating?.available || 0), 0),
    totalOccupied:        seatingResults.reduce((a, s) => a + (s.seating?.occupied  || 0), 0),
    performancesWithData: occs.length,
  } : null;

  return { availability, availabilityRange, availabilityEstimate, sellingFast, seatingAggregate, performances: enriched };
}

/**
 * Compute popularity score (0–100) for a New Theatre event.
 * Uses the same algorithm as wmcComputePopularity but with NT weekday weights
 * and ISO startDate from JSON-LD rather than raw listing date strings.
 *
 * For multi-performance events, pass the highest availabilityEstimate (worst
 * supply pressure) so the score reflects peak demand, not the average.
 */
function ntComputePopularity(ev) {
  const estimate = ev.availabilityEstimate;
  if (estimate == null || Number.isNaN(Number(estimate))) {
    return { popularityScore: null, popularityLabel: null };
  }

  const scrapedAt = ev.scrapedAt || new Date().toISOString();
  const refDate   = new Date(scrapedAt);

  // Prefer ISO startDate from JSON-LD; fall back to raw listing date helpers
  let eventDate = null;
  const isoStart = ev.eventStartDate || ev.jsonLdStartDate;
  if (isoStart) {
    const d = new Date(isoStart);
    if (!Number.isNaN(d.getTime())) eventDate = d;
  }
  if (!eventDate) {
    const rawDate = String(ev.date || '').trim();
    if (rawDate) {
      const range =
        tryParseUkRangeTwoDaysOneMonthYear(rawDate) ||
        tryParseSameMonthDayRange(rawDate)           ||
        tryParseDayMonthRangeYear(rawDate);
      eventDate = range ? range.start : (
        tryParseShortUkDayMonYear(rawDate)                   ||
        tryParseDdMmYyyy(rawDate)                             ||
        tryParseWeekdayOrdinalMonthYear(rawDate)              ||
        tryParseOrdinalMonthOptionalYear(rawDate, scrapedAt)  ||
        tryParseMonthDayAtTime(rawDate, scrapedAt)            ||
        tryParseDayOrdinalMonthNoYear(rawDate, scrapedAt)
      );
    }
  }
  if (!eventDate && ev.url) eventDate = tryParseDateFromListingUrl(ev.url, scrapedAt);
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return { popularityScore: null, popularityLabel: null };
  }

  const msPerDay       = 86_400_000;
  const daysUntil      = Math.max(0, (eventDate.getTime() - refDate.getTime()) / msPerDay);
  const leadNorm       = Math.min(daysUntil, 365) / 365;
  const leadMultiplier = 0.7 + 0.3 * leadNorm;

  const dayOfWeek     = eventDate.getDay();
  const weekdayWeight = NT_WEEKDAY_WEIGHTS[dayOfWeek] ?? 0.85;

  const hasLimitedOrWorse  = /limited|sold.?out/i.test(ev.availability || '');
  const isAtLeastMonthAway = daysUntil >= 30;
  const flooredEstimate    = (hasLimitedOrWorse && isAtLeastMonthAway)
    ? Math.max(Number(estimate), 60)
    : Number(estimate);
  const demandScore = flooredEstimate / 100;

  const raw = demandScore * leadMultiplier * weekdayWeight * 100;
  let popularityScore = Math.min(100, Math.max(0, Math.round(raw)));
  if (/sold.?out/i.test(ev.availability || '')) popularityScore = Math.max(popularityScore, 80);

  let popularityLabel;
  if      (popularityScore >= 75) popularityLabel = 'Very high demand';
  else if (popularityScore >= 50) popularityLabel = 'High demand';
  else if (popularityScore >= 30) popularityLabel = 'Moderate demand';
  else if (popularityScore >= 15) popularityLabel = 'Low demand';
  else                            popularityLabel = 'Very low demand';

  return { popularityScore, popularityLabel };
}

/**
 * Scrape a single Trafalgar booking/seating page and return seat counts.
 * Returns isCalendarFlow=true when the page uses a date-picker flow with no
 * seat map (which means we cannot get occupancy from it).
 */
async function ntScrapeSeatingPage(context, bookingUrl) {
  const page = await context.newPage();
  try {
    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for real seat elements before concluding it's a calendar-flow page
    let seatsFound = false;
    try {
      await page.waitForSelector('.seat.clk, .seat.occ', { timeout: 20_000 });
      seatsFound = true;
    } catch (_) {}

    await new Promise(r => setTimeout(r, 1_500));

    const counts = await page.evaluate((seatsFound) => {
      const hasCalendar    = !!document.getElementById('calendar-hallview');
      const isCalendarFlow = !seatsFound && hasCalendar;
      const all = [...document.querySelectorAll('[class]')].filter(el =>
        (el.getAttribute('class') || '').includes('seat')
      );
      let available = 0, occupied = 0, other = 0;
      for (const el of all) {
        const cls = el.getAttribute('class') || '';
        if      (cls.includes('clk')) available++;
        else if (cls.includes('occ')) occupied++;
        else                          other++;
      }
      const total = available + occupied;
      return {
        isCalendarFlow,
        available, occupied, total, other,
        occupancyPct: total > 0 ? Math.round((occupied / total) * 100) : null,
        pageTitle: document.title || '',
      };
    }, seatsFound);

    await page.close();
    return { bookingUrl, ...counts, error: null };
  } catch (err) {
    try { await page.close(); } catch (_) {}
    return { bookingUrl, isCalendarFlow: false, available: 0, occupied: 0, total: 0, occupancyPct: null, error: err.message };
  }
}

/**
 * Scrape the Trafalgar event detail page for a single event URL.
 * Returns { sellingFast, jsonLd, performances }.
 */
async function ntScrapeEventDetail(context, eventUrl) {
  const page = await context.newPage();
  try {
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await new Promise(r => setTimeout(r, 2_000));

    // Scroll to reveal all performance rows
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 150));
      }
    });
    await new Promise(r => setTimeout(r, 600));

    const result = await page.evaluate(() => {
      const sellingFast = /selling\s+fast/i.test(document.body.innerText || '');

      let jsonLd = null;
      try {
        const el = document.getElementById('structured-data-event');
        if (el) jsonLd = JSON.parse(el.textContent);
      } catch (_) {}

      // ── React payload sold-out detection ────────────────────────────────────
      // Trafalgar's JSON-LD keeps availability as InStock even when sold out.
      // The authoritative sold-out state is in the __next_f streaming payload
      // (Tixly data): "SoldOut":true / "SaleStatusText":"SoldOut" /
      // "hasAllDatesSoldOut":true. We scan inline scripts for these signals.
      let payloadSoldOut = false;
      try {
        for (const s of document.querySelectorAll('script:not([src])')) {
          const t = s.textContent || '';
          if (/"SoldOut"\s*:\s*true/.test(t) ||
              /"SaleStatusText"\s*:\s*"SoldOut"/.test(t) ||
              /"hasAllDatesSoldOut"\s*:\s*true/.test(t)) {
            payloadSoldOut = true;
            break;
          }
        }
      } catch (_) {}

      // ── Page-level sold-out banner ───────────────────────────────────────────
      // Matches the specific card-header banner inside event-tag-card-wrapper:
      // <div class="px-lg pt-xs pb-xl bg-gradient-to-r ..."><div ...>Sold out</div></div>
      const bannerSoldOut = [...document.querySelectorAll('[data-testid="event-tag-card-wrapper"]')]
        .some(el => /^\s*sold\s*out\s*$/i.test(
          (el.querySelector(':scope > div:first-child > div')?.innerText ||
           el.querySelector(':scope > div:first-child')?.innerText || '')
        ));

      const pageSoldOut = payloadSoldOut || bannerSoldOut;

      const isRealTicketUrl = href =>
        href.includes('buyingflow/tickets/') &&
        !href.includes('/membership/') &&
        !href.includes('/priority-');

      const seen = new Set(), performances = [];
      for (const a of document.querySelectorAll('a[href*="booking.trafalgartickets.com"]')) {
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (!isRealTicketUrl(href) || seen.has(href)) continue;
        seen.add(href);
        const timeEl  = a.querySelector('span.text-md');
        const time    = timeEl ? timeEl.innerText.trim() : '';

        // Status: try the sibling span first, then fall back to dot colour.
        // (deep-red = sold out, amber/yellow = limited, green = good)
        const statusSpan = a.querySelector('[data-testid="status-indicator"] ~ span, [data-testid="status-indicator"] + span');
        const dotEl      = a.querySelector('[data-testid="status-indicator"]');
        const dotClass   = dotEl ? (dotEl.getAttribute('class') || '') : '';
        let statusLabel  = statusSpan ? statusSpan.innerText.trim().toLowerCase() : '';
        if (!statusLabel) {
          if (dotClass.includes('bg-deep-red'))                                     statusLabel = 'sold out';
          else if (dotClass.includes('bg-amber') || dotClass.includes('bg-yellow')) statusLabel = 'limited';
          else if (dotClass.includes('bg-emerald') || dotClass.includes('bg-green')) statusLabel = 'good';
        }
        // If the page-level sold-out signal fired and this performance still has
        // no explicit status (Trafalgar leaves the link rendered but Remaining=0),
        // override it to sold out.
        if (!statusLabel && pageSoldOut) statusLabel = 'sold out';

        const priceBadges = [...a.querySelectorAll('.bg-emerald-green-500\\/5')];
        let price = '';
        for (const b of priceBadges) {
          const t = (b.innerText || '').trim();
          if (t && !['good', 'limited', 'sold out'].includes(t.toLowerCase())) { price = t; break; }
        }
        const noteEl = a.querySelector('.text-slate-500');
        performances.push({ time, price, statusLabel, dotClass, bookingUrl: href, note: noteEl?.innerText.trim() || '' });
      }
      return { sellingFast, pageSoldOut, jsonLd, performances };
    });

    await page.close();

    // Merge JSON-LD offers into performances (adds schemaAvailability + schemaPrice,
    // and appends any JSON-LD-only entries not found in the DOM listing)
    const offerMap = new Map();
    if (result.jsonLd?.offers) {
      for (const o of [].concat(result.jsonLd.offers)) {
        const url = (o.url || '').split('?')[0];
        if (url) offerMap.set(url, o);
      }
    }
    const enriched = result.performances.map(p => ({
      ...p,
      schemaAvailability: offerMap.get(p.bookingUrl)?.availability || null,
      schemaPrice: offerMap.get(p.bookingUrl)?.price ? Number(offerMap.get(p.bookingUrl).price) : null,
    }));
    for (const [url, offer] of offerMap) {
      if (!enriched.find(p => p.bookingUrl === url)) {
        const schemaAvail = offer.availability || '';
        const schemaStatusLabel =
          schemaAvail.includes('SoldOut')          ? 'sold out' :
          schemaAvail.includes('LimitedAvailability') ? 'limited'  : '';
        enriched.push({
          time: '', price: `£${offer.price}`, bookingUrl: url,
          statusLabel: schemaStatusLabel, schemaAvailability: schemaAvail,
          schemaPrice: Number(offer.price), dotClass: '', note: '',
          _source: 'jsonld-only',
        });
      }
    }

    // pageSoldOut: two cases to handle:
    //   1. No booking links at all — synthesise a sentinel entry.
    //   2. Booking links exist but Trafalgar hasn't updated the dot/span status
    //      (link is rendered but Remaining=0 in Tixly data). Override any
    //      performances that still have an empty statusLabel.
    if (result.pageSoldOut) {
      if (enriched.length === 0) {
        enriched.push({ time: '', price: '', bookingUrl: '', statusLabel: 'sold out', dotClass: '', note: '', _source: 'page-banner' });
      } else {
        for (const p of enriched) {
          if (!p.statusLabel) p.statusLabel = 'sold out';
        }
      }
    }

    return { sellingFast: result.sellingFast, pageSoldOut: result.pageSoldOut, jsonLd: result.jsonLd, performances: enriched, error: null };
  } catch (err) {
    try { await page.close(); } catch (_) {}
    return { sellingFast: false, jsonLd: null, performances: [], error: err.message };
  }
}

// ─── New Theatre listing pagination ───────────────────────────────────────────

const NT_LISTING_URL = 'https://trafalgartickets.com/new-theatre-cardiff/en-GB/whats-on';
const NT_EVENT_ANCHOR = 'a[href*="/new-theatre-cardiff/en-GB/event/"]';
/** Safety cap on listing page navigations. */
const NT_MAX_LISTING_PAGES = 40;

/** How many event links the listing page currently renders. */
async function ntCountListingEvents(page) {
  return page.$$eval(NT_EVENT_ANCHOR, (els) => els.length).catch(() => 0);
}

/**
 * Read the "Showing 10 of 121 events" counter rendered beside the Load more
 * link. Returns null if the wording changes, in which case callers fall back
 * to following the pagination links blindly.
 */
async function ntReadListingTotal(page) {
  const m = (await page.content()).match(/Showing\s+(\d+)\s+of\s+(\d+)\s+events/i);
  if (!m) return null;
  const shown = Number(m[1]);
  const total = Number(m[2]);
  if (!shown || !total) return null;
  return { shown, total };
}

/**
 * Get every event onto the listing page.
 *
 * The listing is server-paginated: it renders a page of events plus an
 * `<a href="?page=N" rel="next">Load more</a>` link, and each page renders
 * *every* event up to that page (page=2 → 20 events), so navigating to the
 * last page yields the whole listing in a single document.
 *
 * Prefer jumping straight there using the "Showing X of Y events" counter,
 * and fall back to walking the rel="next" links when that counter or the
 * cumulative behaviour is not there any more.
 */
async function ntLoadFullListing(page) {
  let count = await ntCountListingEvents(page);
  const counter = await ntReadListingTotal(page);

  if (counter && counter.total > counter.shown) {
    const lastPage = Math.ceil(counter.total / counter.shown);
    if (lastPage > 1 && lastPage <= NT_MAX_LISTING_PAGES) {
      await gotoAndSettle(page, `${NT_LISTING_URL}?page=${lastPage}`, NT_EVENT_ANCHOR);
      await new Promise((r) => setTimeout(r, 1_500));
      count = await ntCountListingEvents(page);
      if (count >= counter.total) {
        console.log(`  New Theatre: listing page ${lastPage} holds all ${count} events`);
        return count;
      }
      // Pages are no longer cumulative — restart from the first page so the
      // link walk below still collects everything it can.
      console.log(
        `  New Theatre: page ${lastPage} rendered ${count}/${counter.total} events, ` +
        `walking Load more links instead`
      );
      await gotoAndSettle(page, NT_LISTING_URL, NT_EVENT_ANCHOR);
      await new Promise((r) => setTimeout(r, 1_500));
      count = await ntCountListingEvents(page);
    }
  }

  let pages = 0;
  for (let i = 0; i < NT_MAX_LISTING_PAGES; i++) {
    const next = await page
      .$eval('a[rel="next"], a[href*="?page="]:has-text("Load more")', (a) => a.getAttribute('href'))
      .catch(() => null);
    if (!next) break;
    await gotoAndSettle(page, new URL(next, page.url()).href, NT_EVENT_ANCHOR);
    await new Promise((r) => setTimeout(r, 1_500));
    const after = await ntCountListingEvents(page);
    if (after <= count) break; // pagination stopped yielding new rows
    count = after;
    pages++;
  }

  const total = (await ntReadListingTotal(page))?.total;
  console.log(
    `  New Theatre: listing loaded via ${pages} Load more link(s) — ` +
    `${count}${total ? ` of ${total}` : ''} events`
  );
  return count;
}

async function scrapeNewTheatre(context) {
  console.log('Scraping New Theatre...');
  const page = await context.newPage();
  await gotoAndSettle(page, NT_LISTING_URL, 'body');
  await new Promise((r) => setTimeout(r, 2_000));

  // Dismiss cookie banner if present
  try {
    const cookieBtn = await page.$('button:has-text("Accept Cookies"), button:has-text("Allow Cookies"), button:has-text("Accept All")');
    if (cookieBtn && await cookieBtn.isVisible()) {
      await cookieBtn.click();
      await new Promise((r) => setTimeout(r, 1_000));
      console.log('  New Theatre: dismissed cookie banner');
    }
  } catch (_) {}

  await ntLoadFullListing(page);

  // ── Step 1: collect listing-page data (title, date, price, image, url) ──────
  const domEvents = await page.evaluate((anchorSelector) => {
    const seen = new Set();
    const out = [];
    const anchors = [...document.querySelectorAll(anchorSelector)];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const url = (href.startsWith('http') ? href : `https://trafalgartickets.com${href}`).split('?')[0];
      if (seen.has(url)) continue;
      const t = (a.innerText || '').replace(/\u00a0/g, ' ');
      const fromIdx = t.search(/\bfrom\s+£/i);
      const head = fromIdx >= 0 ? t.slice(0, fromIdx) : t;
      const ti = head.indexOf('###');
      let category = '';
      let title = '';
      if (ti >= 0) {
        category = head.slice(0, ti).replace(/\s+/g, ' ').trim();
        title = head.slice(ti + 3).replace(/\s+/g, ' ').trim();
      } else {
        title = a.querySelector('h2, h3, h4')?.innerText?.replace(/\s+/g, ' ').trim() || '';
      }
      const compact = head.replace(/\s+/g, ' ').trim();
      let date = '';
      const rangeM = compact.match(/\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s*[-–]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
      if (rangeM) date = rangeM[1];
      if (!date) {
        const singleM = compact.match(/\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i);
        if (singleM) date = singleM[1];
      }
      let ticketPriceFrom = null;
      let ticketPriceLabel = '';
      const pm = t.match(/from\s+£\s*([\d.]+)/i);
      if (pm) { ticketPriceFrom = Number(pm[1]); ticketPriceLabel = `from £${pm[1]}`; }
      if (!title || !date) continue;
      seen.add(url);
      let imageUrl = '';
      const imgEl = a.querySelector('img[src], img[data-src], img[data-lazy-src]');
      if (imgEl) {
        const raw = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || imgEl.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const row = {
        title, date, url,
        venue: 'New Theatre Cardiff',
        scrapedAt: new Date().toISOString(),
      };
      if (imageUrl) row.imageUrl = imageUrl;
      if (category) row.category = category;
      if (ticketPriceFrom != null && !Number.isNaN(ticketPriceFrom)) {
        row.ticketPriceFrom = ticketPriceFrom;
        row.ticketCurrency = 'GBP';
        row.ticketPriceLabel = ticketPriceLabel;
      }
      out.push(row);
    }
    return out;
  }, NT_EVENT_ANCHOR);

  const html = await page.content();
  await page.close();

  // ── Step 2: apply inline JSON meta (categories, promoter, hero images) ───────
  const metaByGroupId = new Map();
  for (const match of html.matchAll(/\{\\?"eventGroupId\\?":\d+.*?\}/g)) {
    try {
      const obj = JSON.parse(match[0].replace(/\\"/g, '"').replace(/\\u0026/g, '&'));
      if (obj.eventGroupId == null || !obj.name) continue;
      const prev = metaByGroupId.get(obj.eventGroupId) || {};
      metaByGroupId.set(obj.eventGroupId, { ...prev, ...obj });
    } catch (_) {}
  }

  const slugToId = new Map();
  for (const [gid, obj] of metaByGroupId) {
    const slug = (obj.slugUrl || obj.urlSlug || '').toString();
    if (slug) slugToId.set(slug, gid);
  }

  function applyNewTheatreMeta(row, obj) {
    const cats = Array.isArray(obj.categories) ? obj.categories.filter(Boolean) : [];
    if (cats.length && !row.category) row.category = cats[0];
    if (cats.length > 1) row.subcategory = cats.slice(1).join('; ');
    if (obj.price != null && !Number.isNaN(Number(obj.price)) && row.ticketPriceFrom == null) {
      row.ticketPriceFrom = Number(obj.price);
      row.ticketCurrency = 'GBP';
      row.ticketPriceLabel = `from £${obj.price}`;
    }
    if (obj.subVenue) row.subVenue = obj.subVenue;
    if (obj.promoter) row.promoter = obj.promoter;
    if (cats.length === 1 && cats[0] && !row.genre) row.genre = cats[0];
    let metaImg = '';
    if (typeof obj.image === 'string' && obj.image.trim()) metaImg = obj.image.trim();
    else if (typeof obj.imageUrl === 'string' && obj.imageUrl.trim()) metaImg = obj.imageUrl.trim();
    else if (typeof obj.heroImage === 'string' && obj.heroImage.trim()) metaImg = obj.heroImage.trim();
    if (metaImg && !row.imageUrl) row.imageUrl = metaImg;
  }

  for (const row of domEvents) {
    const mid = row.url.match(/\/event\/(\d+)(?:\?|$)/);
    if (mid) { const o = metaByGroupId.get(Number(mid[1])); if (o) applyNewTheatreMeta(row, o); }
    const tail = row.url.split('/event/')[1];
    if (tail) {
      const slugKey = tail.split('?')[0];
      const gid = slugToId.get(slugKey);
      if (gid != null) { const o = metaByGroupId.get(gid); if (o) applyNewTheatreMeta(row, o); }
    }
    const byName = [...metaByGroupId.values()].find(
      (o) => o.name && row.title &&
        String(o.name).trim().toLowerCase() === String(row.title).trim().toLowerCase()
    );
    if (byName) applyNewTheatreMeta(row, byName);
  }

  console.log(`  New Theatre: ${domEvents.length} events found, fetching availability...`);

  // ── Step 3: per-event detail + tiered seating scrape ─────────────────────────
  // Build URL list (one per listing event)
  const eventUrls = domEvents.map(e => e.url);

  // Build a lookup so we can write results back to the original row objects
  const rowByUrl = new Map(domEvents.map(e => [e.url, e]));

  // Concurrent processing: detail page → conditional seating pages
  const queue = [...eventUrls];
  let doneCount = 0;
  let seatingAttempted = 0;
  let seatingSkipped = 0;

  async function processOneEvent() {
    while (queue.length) {
      const eventUrl = queue.shift();
      const row = rowByUrl.get(eventUrl);
      if (!row) continue;

      // Fetch detail page (performances + JSON-LD)
      const detail = await ntScrapeEventDetail(context, eventUrl);
      doneCount++;
      if (doneCount % 20 === 0 || doneCount === eventUrls.length) {
        console.log(`  New Theatre: detail ${doneCount}/${eventUrls.length}`);
      }

      if (detail.error || !detail.performances.length) {
        // No performance data — leave availability fields absent; finalizeEvent handles it
        continue;
      }

      // Attach JSON-LD dates and images from detail page
      if (detail.jsonLd) {
        if (detail.jsonLd.startDate && !row.eventStartDate) row.eventStartDate = detail.jsonLd.startDate;
        if (detail.jsonLd.endDate   && !row.eventEndDate)   row.eventEndDate   = detail.jsonLd.endDate;
        if (Array.isArray(detail.jsonLd.image) && detail.jsonLd.image.length) {
          if (!row.imageUrl) row.imageUrl = detail.jsonLd.image[0];
          row.imageUrls = detail.jsonLd.image;
        }
        // Widen price range using all offers
        if (detail.jsonLd.offers) {
          const prices = [].concat(detail.jsonLd.offers)
            .map(o => Number(o.price))
            .filter(p => !Number.isNaN(p) && p > 0);
          if (prices.length) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            if (row.ticketPriceFrom == null || minP < row.ticketPriceFrom) row.ticketPriceFrom = minP;
            if (maxP > (row.ticketPriceTo || 0)) row.ticketPriceTo = maxP;
            if (!row.ticketCurrency) row.ticketCurrency = 'GBP';
            if (!row.ticketPriceLabel) row.ticketPriceLabel = `from £${minP}`;
          }
        }
      }

      const validPerfs = detail.performances.filter(p => p.bookingUrl);
      const hasLimited = validPerfs.some(p => p.statusLabel === 'limited' || p.statusLabel === 'sold out');

      // Tiered gating: skip seating when all performances are "good" with no "selling fast"
      const skipSeating = !hasLimited && !detail.sellingFast;

      if (skipSeating) {
        seatingSkipped++;
        const avail = ntDeriveAvailabilityFields(validPerfs, false, [], true);
        row.availability         = avail.availability;
        row.availabilityRange    = avail.availabilityRange;
        row.availabilityEstimate = avail.availabilityEstimate;
      } else {
        seatingAttempted++;

        // Select which booking pages to visit (capped + deduplicated)
        const seenUrls  = new Set();
        const toScrape  = [];
        for (const p of validPerfs) {
          if (!seenUrls.has(p.bookingUrl)) {
            seenUrls.add(p.bookingUrl);
            toScrape.push(p);
            if (toScrape.length >= NT_MAX_SEATING_PAGES) break;
          }
        }

        const seatingResults    = [];
        let calendarFlowSeen = false;
        for (const perf of toScrape) {
          const seating = await ntScrapeSeatingPage(context, perf.bookingUrl);
          if (seating.isCalendarFlow) { calendarFlowSeen = true; break; }
          seatingResults.push({ ...perf, seating });
        }

        const avail = ntDeriveAvailabilityFields(
          validPerfs, detail.sellingFast, seatingResults,
          calendarFlowSeen && seatingResults.length === 0
        );

        row.availability         = avail.availability;
        row.availabilityRange    = avail.availabilityRange;
        row.availabilityEstimate = avail.availabilityEstimate;
        if (avail.seatingAggregate) row.seatingAggregate = avail.seatingAggregate;
      }

      // Popularity score — use max occupancy across performances as the demand signal
      const maxOcc = row.seatingAggregate?.maxOccupancyPct ?? row.availabilityEstimate;
      Object.assign(row, ntComputePopularity({
        ...row,
        availabilityEstimate: maxOcc,
      }));
    }
  }

  await Promise.all(
    Array.from({ length: NT_DETAIL_CONCURRENCY }, () => processOneEvent())
  );

  const withAvailability = domEvents.filter(e => e.availability).length;
  console.log(
    `  New Theatre: done. ${withAvailability}/${domEvents.length} with availability, ` +
    `${seatingAttempted} seating scraped, ${seatingSkipped} skipped (all-good).`
  );

  return domEvents;
}

async function scrapeTramshed(context) {
  console.log('Scraping Tramshed...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.tramshedcardiff.com/', 'article.elementor-post');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.elementor-post')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('.elementor-post__thumbnail img, .elementor-post__card img, figure img, img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('h3.elementor-post__title a')?.innerText.trim() || '',
        details: item.querySelector('.elementor-post__excerpt p')?.innerText.trim() || '',
        url: item.querySelector('h3.elementor-post__title a')?.href || '',
        venue: 'Tramshed Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Tramshed: ${events.length} events`);
  return events;
}

async function scrapeUtilitaArena(context) {
  console.log('Scraping Utilita Arena...');
  const page = await context.newPage();
  await gotoAndSettle(
    page,
    'https://www.livenation.co.uk/utilita-arena-cardiff-tickets-vdp3915',
    'li[data-testid="aedp-event"]'
  );
  await new Promise((r) => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li[data-testid="aedp-event"]')).map((item) => {
      const titleEl = item.querySelector('h4[data-testid="aedp-event-information-block-venuedetails"]');
      const timeEl = item.querySelector('time[datetime]');
      const timesEl = item.querySelector('p[data-testid="aedp-event-information-block-times"]');
      const supportEl = item.querySelector('p[data-testid="aedp-event-information-support-artists"]');
      const linkEl = item.querySelector('a');

      const title = titleEl?.innerText?.trim() || '';
      const datetime = timeEl?.getAttribute('datetime') || '';
      const times = timesEl?.innerText?.trim() || '';
      const support = supportEl?.innerText?.trim() || '';
      const href = linkEl?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : `https://www.livenation.co.uk${href}`;

      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }

      return {
        title,
        date: datetime,
        details: [times, support].filter(Boolean).join(' • '),
        url,
        venue: 'Utilita Arena Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title && e.url);
  });

  await page.close();
  console.log(`  Utilita Arena: ${events.length} events`);
  return events;
}


async function scrapeDepot(context) {
  console.log('Scraping Depot...');
  const page = await context.newPage();

  await page.goto('https://depotcardiff.com/events/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('load').catch(() => {});

  // Wait broadly for any recognisable event container
  await page.waitForSelector(
    [
      'li.fusion-layout-column',
      '.fusion-layout-column',
      'article.tribe_events_cat',
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container',
      'article[class*="event"]',
      '.event-item',
      '.events-list__item',
    ].join(', '),
    { state: 'attached', timeout: 20_000 }
  ).catch(() => {});

  // Scroll to trigger lazy-loads
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 400);
        total += 400;
        if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
      }, 300);
    });
  });
  await new Promise(r => setTimeout(r, 3_000));

  // Extended selector audit including tribe and common WP event patterns
  const selectorAudit = await page.evaluate(() => {
    const checks = [
      'li.fusion-layout-column',
      '.fusion-layout-column',
      'article[class*="tribe"]',
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
      '.events-list__item',
      'a[href*="/event/"]',
      'a[href*="/events/"]',
      'a[href*="seetickets"]',
      'a[href*="ticketweb"]',
      'a[href*="eventbrite"]',
    ];
    return checks.map(sel => ({ sel, count: document.querySelectorAll(sel).length }));
  });
  console.log('  Depot selector audit:', JSON.stringify(selectorAudit));

  // Page structure dump to diagnose unknown layouts
  const pageDump = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').slice(0, 800).replace(/\s+/g, ' ');
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') || '')
      .filter(h => h && !h.startsWith('#') && !h.startsWith('javascript'))
      .slice(0, 40);
    const tagClasses = {};
    for (const tag of ['article', 'li', 'div', 'section']) {
      const els = document.querySelectorAll(tag + '[class]');
      const cls = new Set();
      for (const el of els) for (const c of el.classList) cls.add(c);
      if (cls.size) tagClasses[tag] = [...cls].slice(0, 30).join(' ');
    }
    return { bodyText, allLinks, tagClasses };
  });
  console.log('  Depot body snippet:', pageDump.bodyText);
  console.log('  Depot all links (sample):', pageDump.allLinks);
  console.log('  Depot element classes:', JSON.stringify(pageDump.tagClasses));

  const events = await page.evaluate(() => {
    function extractItem(item, linkSel) {
      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const link = item.querySelector(linkSel) || item.querySelector('a[href]');
      const title = item.querySelector('h2 a, h3 a, h2, h3, .tribe-event-url, .event-title')?.innerText?.trim()
        || link?.innerText?.trim() || '';
      const dateEl = item.querySelector(
        '.tribe-event-date-start, time, .event-date, .date, p[class*="date"], span[class*="date"]'
      );
      return {
        title,
        date: dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
        url: link?.href || '',
        venue: 'Depot Cardiff',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }

    // Try selectors in priority order
    const strategies = [
      // Old Avada layout
      { sel: 'li.fusion-layout-column', linkSel: 'a[href*="/event/"]' },
      { sel: '.fusion-layout-column:not(.fusion-layout-column .fusion-layout-column)', linkSel: 'a[href]' },
      // The Events Calendar (tribe) layouts
      { sel: 'article.type-tribe_events', linkSel: 'a.url, a[href*="/event"]' },
      { sel: '.tribe-events-pro-grid__event', linkSel: 'a' },
      { sel: '.tribe-common-l-container article', linkSel: 'a' },
      // Generic WP event patterns
      { sel: 'article[class*="event"]', linkSel: 'a[href]' },
      { sel: '.event-item', linkSel: 'a[href]' },
      { sel: '.events-list__item', linkSel: 'a[href]' },
    ];

    for (const { sel, linkSel } of strategies) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) {
        return items.map(item => extractItem(item, linkSel)).filter(e => e.title);
      }
    }
    return [];
  });

  await page.close();

  // Strip "SOLD OUT:" prefix from titles and set availability fields
  for (const ev of events) {
    if (/^sold\s*out\s*:/i.test(ev.title)) {
      ev.title               = ev.title.replace(/^sold\s*out\s*:\s*/i, '').trim();
      ev.availability        = 'SOLD OUT';
      ev.availabilityRange   = '100%';
      ev.availabilityEstimate = 100;
    }
  }

  console.log(`  Depot: ${events.length} events`);
  return events;
}
 


async function scrapeCardiffSU(context) {
  console.log('Scraping Cardiff SU...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.cardiffstudents.com/whatson/live-music/', 'div.event_item, .msl_eventlist');
  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.event_item')).map((item) => {
      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      return {
        title: item.querySelector('a.msl_event_name')?.innerText.trim() || '',
        date: item.querySelector('dd.msl_event_time')?.innerText.trim() || '',
        location: item.querySelector('dd.msl_event_location')?.innerText.trim() || '',
        url: 'https://www.cardiffstudents.com' + (item.querySelector('a.msl_event_name')?.getAttribute('href') || ''),
        venue: 'Cardiff SU',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }).filter((e) => e.title);
  });
  await page.close();
  console.log(`  Cardiff SU: ${events.length} events`);
  return events;
}

async function scrapeTheGate(context) {
  console.log('Scraping The Gate...');

  const page = await context.newPage();

  await gotoAndSettle(
    page,
    'https://www.thegate.org.uk/whats-on',
    '.sqs-html-content'
  );

  const events = await page.evaluate(() => {

    const dateLike = (t) =>
      t &&
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(t) &&
      /\d{4}/.test(t);

    function cleanText(t) {
      return t?.replace(/\s+/g, ' ').trim() || '';
    }

    function pickDate(block) {
      const trySelectors = [
        'p strong u',
        'p u strong',
        'p span[style*="text-decoration:underline"] strong',
        'p span[style*="text-decoration: underline"] strong',
      ];

      for (const sel of trySelectors) {
        const el = block.querySelector(sel);
        const t = cleanText(el?.innerText);

        if (dateLike(t)) return t;
      }

      for (const el of block.querySelectorAll('p.sqsrte-large strong')) {
        const t = cleanText(el.innerText);

        if (dateLike(t)) return t;
      }

      return '';
    }

    function pickDescription(block) {
      const paras = Array.from(
        block.querySelectorAll('p:not(.sqsrte-large)')
      )
        .map(p => cleanText(p.innerText))
        .filter(t =>
          t &&
          !dateLike(t) &&
          t.length > 30
        );

      return paras.join(' ') || '';
    }

    function pickSupport(block) {
      const paras = Array.from(
        block.querySelectorAll('p.sqsrte-large')
      )
        .map(p => cleanText(p.innerText))
        .filter(t =>
          t &&
          !dateLike(t)
        );

      return paras.join(', ') || '';
    }

    function getFeBlock(node) {
      while (node && !node.classList?.contains('fe-block')) {
        node = node.parentElement;
      }

      return node;
    }

    function isEventStartBlock(sib) {
      return !!sib.querySelector(
        '.sqs-html-content h1, .sqs-html-content h2, .sqs-html-content h3, .sqs-html-content h4'
      );
    }

    function findAssociatedData(textBlock) {

      const feBlock = getFeBlock(textBlock);

      if (!feBlock || !feBlock.parentElement) {
        return {
          imageUrl: '',
          url: 'https://www.thegate.org.uk/whats-on'
        };
      }

      const siblings = Array.from(feBlock.parentElement.children);
      const idx = siblings.indexOf(feBlock);

      let imageUrl = '';
      let url = '';

      // Search FORWARD first
      for (let i = idx; i < siblings.length; i++) {

        const sib = siblings[i];

        // Stop at next event
        if (
          i !== idx &&
          isEventStartBlock(sib)
        ) {
          break;
        }

        // Find ticket URL
        if (!url) {
          const a = sib.querySelector(`
            a[href*="gigantic"],
            a[href*="ticketmaster"],
            a[href*="seetickets"],
            a[href*="eventbrite"]
          `);

          if (a?.href) {
            url = a.href;
          }
        }

        // Find image
        if (!imageUrl) {

          const img = sib.querySelector(
            'img[data-src], img[src]'
          );

          if (img) {

            const src =
              img.getAttribute('data-src') ||
              img.getAttribute('src') ||
              '';

            if (
              src &&
              !src.startsWith('data:')
            ) {
              imageUrl = src;
            }
          }

          // Background image fallback
          if (!imageUrl) {

            const bgEl = sib.querySelector(
              '[style*="background-image"]'
            );

            if (bgEl) {

              const style =
                bgEl.getAttribute('style') || '';

              const match = style.match(
                /background-image:\s*url\(["']?(.*?)["']?\)/
              );

              if (match?.[1]) {
                imageUrl = match[1];
              }
            }
          }
        }
      }

      // Fallback backward search
      if (!imageUrl || !url) {

        for (let i = idx - 1; i >= 0; i--) {

          const sib = siblings[i];

          // Stop at previous event
          if (isEventStartBlock(sib)) {
            break;
          }

          if (!url) {

            const a = sib.querySelector(`
              a[href*="gigantic"],
              a[href*="ticketmaster"],
              a[href*="seetickets"],
              a[href*="eventbrite"]
            `);

            if (a?.href) {
              url = a.href;
            }
          }

          if (!imageUrl) {

            const img = sib.querySelector(
              'img[data-src], img[src]'
            );

            if (img) {

              const src =
                img.getAttribute('data-src') ||
                img.getAttribute('src') ||
                '';

              if (
                src &&
                !src.startsWith('data:')
              ) {
                imageUrl = src;
              }
            }
          }
        }
      }

      return {
        imageUrl,
        url: url || 'https://www.thegate.org.uk/whats-on'
      };
    }

    return Array.from(
      document.querySelectorAll('.sqs-html-content')
    )
      .map(block => {

        const title = cleanText(
          block.querySelector('h2, h3, h4')?.innerText
        );

        const date = pickDate(block);

        if (!title || !date) {
          return null;
        }

        const description = pickDescription(block);

        const support = pickSupport(block);

        const {
          imageUrl,
          url
        } = findAssociatedData(block);

        return {
          title,
          date,

          ...(description
            ? { description }
            : {}),

          ...(support
            ? { support }
            : {}),

          ...(imageUrl
            ? { imageUrl }
            : {}),

          url,

          venue: 'The Gate Cardiff',

          scrapedAt: new Date().toISOString(),
        };
      })
      .filter(e => e && e.title && e.date);
  });

  await page.close();

  console.log(`  The Gate: ${events.length} events`);

  return events;
}

async function scrapeFuel(context) {
  console.log('Scraping Fuel Rock Club...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.fuelrockclub.co.uk/events/', null);

  // Wait for iframes or direct event containers to appear
  await new Promise(r => setTimeout(r, 5_000));

  const iframeAudit = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.getAttribute('src') || '(no src)',
      id: f.id || '',
      className: f.className || '',
    }))
  );
  console.log('  Fuel: iframes found:', iframeAudit.length ? iframeAudit : ['none']);

  // --- Path A: SociableKit or Facebook iframe ---
  const iframeSelectors = [
    'iframe[src*="sociablekit"]',
    'iframe[src*="sociable"]',
    'iframe[src*="facebook.com/plugins/page"]',
    'iframe[src*="facebook.com/events"]',
    'iframe[id*="sociable"]',
    'iframe[class*="sociable"]',
  ];

  let iframeElement = null;
  for (const sel of iframeSelectors) {
    iframeElement = await page.$(sel);
    if (iframeElement) {
      console.log(`  Fuel: matched iframe selector: ${sel}`);
      break;
    }
  }

  if (iframeElement) {
    const frame = await iframeElement.contentFrame();
    if (frame) {
      await frame.waitForSelector('.sk-event-item', { timeout: 15_000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2_000));
      const events = await frame.evaluate(() => {
        function cleanText(t) { return t?.replace(/\s+/g, ' ').trim() || ''; }
        return Array.from(document.querySelectorAll('.sk-event-item')).map(item => {
          const title = cleanText(item.querySelector('.sk-event-item-title')?.innerText);
          const url =
            item.querySelector('.sk-event-item-fb-link')?.href ||
            item.querySelector('.sk-event-item-gettickets')?.href || '';
          const rawImage = item.querySelector('img')?.getAttribute('src') || '';
          const timeEl = item.querySelector('.sk-event-item-date time');
          return {
            title, date: cleanText(timeEl?.innerText), eventStartDate: timeEl?.getAttribute('datetime') || '',
            url, imageUrl: rawImage && !rawImage.startsWith('data:') ? rawImage : '',
            venue: 'Fuel Rock Club', scrapedAt: new Date().toISOString(),
          };
        }).filter(e => e.title && e.url);
      });
      await page.close();
      console.log(`  Fuel: ${events.length} events (via iframe)`);
      return events;
    }
    console.log('  Fuel: iframe found but content not accessible (cross-origin)');
  }

  // --- Path B: Direct on-page event listing (tribe / WP / custom) ---
  const selectorAudit = await page.evaluate(() => {
    const checks = [
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
      '.events-list__item',
      'a[href*="/event"]',
      'a[href*="eventbrite"]',
      'a[href*="seetickets"]',
      'a[href*="dice.fm"]',
      'a[href*="ticketweb"]',
      'a[href*="wegottickets"]',
    ];
    return checks.map(sel => ({ sel, count: document.querySelectorAll(sel).length }));
  });
  console.log('  Fuel selector audit:', JSON.stringify(selectorAudit));

  // Full page structure dump
  const pageDump = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').slice(0, 1000).replace(/\s+/g, ' ');
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') || '')
      .filter(h => h && !h.startsWith('#') && !h.startsWith('javascript'))
      .slice(0, 50);
    const tagClasses = {};
    for (const tag of ['article', 'li', 'div', 'section']) {
      const els = document.querySelectorAll(tag + '[class]');
      const cls = new Set();
      for (const el of els) for (const c of el.classList) cls.add(c);
      if (cls.size) tagClasses[tag] = [...cls].slice(0, 30).join(' ');
    }
    return { bodyText, allLinks, tagClasses };
  });
  console.log('  Fuel body snippet:', pageDump.bodyText);
  console.log('  Fuel all links (sample):', pageDump.allLinks);
  console.log('  Fuel element classes:', JSON.stringify(pageDump.tagClasses));

  const events = await page.evaluate(() => {
    function extractItem(item) {
      let imageUrl = '';
      const img = item.querySelector('img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const title = item.querySelector('h2 a, h3 a, h2, h3, .tribe-event-url, .event-title')?.innerText?.trim() || '';
      const dateEl = item.querySelector(
        '.tribe-event-date-start, time, .event-date, .date, span[class*="date"], p[class*="date"]'
      );
      const url = item.querySelector('a.url, a[href*="/event"]')?.href || item.querySelector('a[href]')?.href || '';
      return {
        title, date: dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
        eventStartDate: dateEl?.getAttribute('datetime') || '',
        url, imageUrl, venue: 'Fuel Rock Club', scrapedAt: new Date().toISOString(),
      };
    }

    const strategies = [
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
      '.events-list__item',
    ];

    for (const sel of strategies) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) return items.map(extractItem).filter(e => e.title);
    }
    return [];
  });

  await page.close();
  console.log(`  Fuel: ${events.length} events (direct)`);
  return events;
}
 


async function scrapePrincipality(context) {
  console.log('Scraping Principality Stadium...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.principalitystadium.wales/events-and-ticket-information/', 'div.event-aggregator-item');
  await new Promise(r => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.event-aggregator-item')).map(item => {
      const titleEl = item.querySelector('.event-item-title h4 a');
      const dateEl = item.querySelector('.event-item-info span');
      const descEl = item.querySelector('.event-item-desc p');
      const linkEl = item.querySelector('a.event-item-link');
      const img = item.querySelector('img.sotic_images');
      const raw = img?.getAttribute('src') || '';
      const cats = Array.from(item.querySelectorAll('.event-item-category li a'))
        .map(a => a.innerText.trim()).join(', ');
      return {
        title: titleEl?.innerText.trim() || '',
        date: dateEl?.innerText.trim() || '',
        description: descEl?.innerText.trim() || '',
        category: cats,
        url: linkEl?.href || titleEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Principality Stadium',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Principality: ${events.length} events`);
  return events;
}

// ─── Sherman Theatre availability helpers ─────────────────────────────────────

/**
 * Sherman weekday demand weights.
 * Sherman is a mid-size civic theatre; mid-week shows in a smaller space
 * imply stronger interest than equivalent weekend ones.
 */
const SHERMAN_WEEKDAY_WEIGHTS = {
  0: 0.70, // Sunday
  1: 1.00, // Monday
  2: 1.00, // Tuesday
  3: 0.95, // Wednesday
  4: 0.90, // Thursday
  5: 0.75, // Friday
  6: 0.70, // Saturday
};

/**
 * Scrape a Spektrix seat-map page for Sherman Theatre.
 *
 * The /book-online/XXXXX wrapper page embeds a CROSS-ORIGIN iframe at
 *   https://tickets.shermantheatre.co.uk/shermantheatre/website/chooseseats.aspx?EventInstanceId=XXXXX
 * page.evaluate() cannot reach inside a cross-origin iframe, so we derive
 * the Spektrix URL directly and navigate there instead.
 *
 * Seat images use class "Seat" (unavailable) vs "SeatSelectable" (available).
 * Returns { available, occupied, total, occupancyPct, error }.
 */
function shermanBuildSpektrixUrl(bookingUrl) {
  const match = (bookingUrl || '').match(/\/book-online\/(\d+)/);
  if (!match) return null;
  return `https://tickets.shermantheatre.co.uk/shermantheatre/website/chooseseats.aspx?EventInstanceId=${match[1]}&resize=true`;
}

async function shermanScrapeSeatingPage(context, bookingUrl) {
  const spektrixUrl = shermanBuildSpektrixUrl(bookingUrl);
  if (!spektrixUrl) {
    return { available: 0, occupied: 0, total: 0, occupancyPct: null, error: `Cannot derive Spektrix URL from ${bookingUrl}` };
  }
  const page = await context.newPage();
  try {
    await page.goto(spektrixUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for the Spektrix seating area to render.
    // .SeatingArea is present for both allocated and unallocated seating.
    // For allocated seating the seat images appear inside it.
    let seatsFound = false;
    try {
      await page.waitForSelector('.SeatingArea', { timeout: 20_000 });
      // Give seat images a moment to render after the container appears
      await new Promise(r => setTimeout(r, 2_000));
      // Check if any seat images actually loaded inside it
      seatsFound = await page.evaluate(() =>
        document.querySelectorAll('img').length > 5
      );
    } catch (_) {}

    await new Promise(r => setTimeout(r, 1_500));

    const counts = await page.evaluate((seatsFound) => {
      if (!seatsFound) {
        // Check if there's a seating area at all (might be general admission / unallocated)
        const hasSeatingArea = !!document.querySelector('.SeatingArea, .SeatingSelector');
        return { available: 0, occupied: 0, total: 0, occupancyPct: null, unallocated: !hasSeatingArea, error: 'no seat images found' };
      }

      let available = 0, occupied = 0;
      for (const img of document.querySelectorAll('img')) {
        const cn = img.getAttribute('classname') || '';
        if (cn.includes('SeatSelectable')) {
          available++;
        } else if (cn.includes('Seat') && !cn.includes('SeatSelectable')) {
          occupied++;
        }
      }
      const total = available + occupied;
      return {
        available, occupied, total,
        occupancyPct: total > 0 ? Math.round((occupied / total) * 100) : null,
        unallocated: false,
        error: null,
      };
    }, seatsFound);

    await page.close();
    return counts;
  } catch (err) {
    try { await page.close(); } catch (_) {}
    return { available: 0, occupied: 0, total: 0, occupancyPct: null, error: err.message };
  }
}

/**
 * Derive Sherman availability label + estimate from a seat scrape result.
 * If no seat data (sold-out page, no booking link), pass { soldOut: true }.
 */
function shermanDeriveAvailability(seating, soldOut) {
  if (soldOut || (seating?.occupancyPct != null && seating.occupancyPct >= 100)) {
    return { availability: 'SOLD OUT', availabilityRange: '100%', availabilityEstimate: 100 };
  }
  // General-admission / unallocated seating — no seat map to read
  if (seating?.unallocated) {
    return { availability: 'GOOD', availabilityRange: '20-50%', availabilityEstimate: 40 };
  }
  if (seating?.occupancyPct == null) {
    return { availability: null, availabilityRange: null, availabilityEstimate: null };
  }
  const pct = seating.occupancyPct;
  const lo = Math.floor(pct / 10) * 10;
  const hi = Math.min(100, lo + 10);
  const range = `${lo}-${hi}%`;
  let label;
  if (pct >= 100)      label = 'SOLD OUT';
  else if (pct >= 85)  label = 'LIMITED';
  else if (pct >= 50)  label = 'GOOD - SELLING FAST';
  else                 label = 'GOOD';
  return { availability: label, availabilityRange: range, availabilityEstimate: pct };
}

/**
 * Compute popularity for a Sherman event (same algorithm as NT/WMC).
 */
function shermanComputePopularity(ev) {
  const estimate = ev.availabilityEstimate;
  if (estimate == null || Number.isNaN(Number(estimate))) {
    return { popularityScore: null, popularityLabel: null };
  }
  const scrapedAt = ev.scrapedAt || new Date().toISOString();
  const refDate   = new Date(scrapedAt);
  let eventDate = null;
  const isoStart = ev.eventStartDate;
  if (isoStart) {
    const d = new Date(isoStart);
    if (!Number.isNaN(d.getTime())) eventDate = d;
  }
  if (!eventDate) {
    const rawDate = String(ev.date || '').trim();
    if (rawDate) {
      const range =
        tryParseUkRangeTwoDaysOneMonthYear(rawDate) ||
        tryParseSameMonthDayRange(rawDate)           ||
        tryParseDayMonthRangeYear(rawDate);
      eventDate = range ? range.start : (
        tryParseShortUkDayMonYear(rawDate)                   ||
        tryParseDdMmYyyy(rawDate)                             ||
        tryParseWeekdayOrdinalMonthYear(rawDate)              ||
        tryParseOrdinalMonthOptionalYear(rawDate, scrapedAt)  ||
        tryParseMonthDayAtTime(rawDate, scrapedAt)            ||
        tryParseDayOrdinalMonthNoYear(rawDate, scrapedAt)
      );
    }
  }
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return { popularityScore: null, popularityLabel: null };
  }
  const msPerDay       = 86_400_000;
  const daysUntil      = Math.max(0, (eventDate.getTime() - refDate.getTime()) / msPerDay);
  const leadNorm       = Math.min(daysUntil, 365) / 365;
  const leadMultiplier = 0.7 + 0.3 * leadNorm;
  const dayOfWeek     = eventDate.getDay();
  const weekdayWeight = SHERMAN_WEEKDAY_WEIGHTS[dayOfWeek] ?? 0.85;
  const hasLimitedOrWorse  = /limited|sold.?out/i.test(ev.availability || '');
  const isAtLeastMonthAway = daysUntil >= 30;
  const flooredEstimate    = (hasLimitedOrWorse && isAtLeastMonthAway)
    ? Math.max(Number(estimate), 60)
    : Number(estimate);
  const raw = (flooredEstimate / 100) * leadMultiplier * weekdayWeight * 100;
  let popularityScore = Math.min(100, Math.max(0, Math.round(raw)));
  if (/sold.?out/i.test(ev.availability || '')) popularityScore = Math.max(popularityScore, 80);
  let popularityLabel;
  if      (popularityScore >= 75) popularityLabel = 'Very high demand';
  else if (popularityScore >= 50) popularityLabel = 'High demand';
  else if (popularityScore >= 30) popularityLabel = 'Moderate demand';
  else if (popularityScore >= 15) popularityLabel = 'Low demand';
  else                            popularityLabel = 'Very low demand';
  return { popularityScore, popularityLabel };
}

async function scrapeSherman(context) {
  console.log('Scraping Sherman Theatre...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.shermantheatre.co.uk/whats-on/', 'div.card-event');
  await new Promise(r => setTimeout(r, 2_000));

  // Click "Show More" until it disappears
  let clicks = 0;
  while (true) {
    try {
      const btn = await page.$('a.load-more');
      if (!btn || !(await btn.isVisible())) break;
      await btn.scrollIntoViewIfNeeded();
      await new Promise(r => setTimeout(r, 500));
      await btn.click({ timeout: 10_000 });
      await new Promise(r => setTimeout(r, 1_500));
      clicks++;
      if (clicks > 20) break;
    } catch (_) { break; }
  }
  if (clicks > 0) console.log(`  Sherman: clicked Show More ${clicks} times`);

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.card-event')).map(item => {
      const titleEl = item.querySelector('h3.card-title');
      const dateEl  = item.querySelector('span.date');
      const descEl  = item.querySelector('.card-description');
      const catEl   = item.querySelector('.item-categories span');
      const linkEl  = item.querySelector('a.card-link');
      const imgEl   = item.querySelector('div.card-image[data-src]');
      const raw     = imgEl?.getAttribute('data-src') || '';
      return {
        title:    titleEl?.innerText.trim() || '',
        date:     dateEl?.innerText.trim() || '',
        description: descEl?.innerText.trim() || '',
        category: catEl?.innerText.trim() || '',
        url:      linkEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue:    'Sherman Theatre',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Sherman: ${events.length} events found, fetching availability...`);

  // ── Per-event detail: check sold-out status + optional seat scrape ────────
  for (const ev of events) {
    if (!ev.url) continue;

    const detailPage = await context.newPage();
    let soldOut = false;
    let bookingUrl = null;

    try {
      await detailPage.goto(ev.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await new Promise(r => setTimeout(r, 1_000));

      const detail = await detailPage.evaluate(() => {
        // Each performance appears as .instance; check if any have a booking link
        const instances = [...document.querySelectorAll('.instance')];

        let anyBookingLink = null;
        let allSoldOut = instances.length > 0;

        for (const inst of instances) {
          const ctaEl  = inst.querySelector('.instance-cta');
          const ctaTxt = (ctaEl?.innerText || '').trim().toLowerCase();
          const link   = inst.querySelector('a.btn-book-instance');

          if (link?.href) {
            anyBookingLink = link.href;
            allSoldOut = false; // at least one bookable performance exists
          } else if (!ctaTxt.includes('sold out')) {
            // Something else — not clearly sold out, not bookable
            allSoldOut = false;
          }
          // if ctaTxt is "sold out" and no link, allSoldOut stays true for this instance
        }

        // Also check for a global sold-out marker (no instances with links at all)
        const soldOutText = [...document.querySelectorAll('.instance-cta')]
          .every(el => /sold\s*out/i.test(el.innerText || ''));

        return {
          soldOut: instances.length > 0 && allSoldOut && soldOutText,
          bookingUrl: anyBookingLink,
        };
      });

      soldOut    = detail.soldOut;
      bookingUrl = detail.bookingUrl;

      // Extract date/time from the detail page for better ISO date
      const isoDate = await detailPage.evaluate(() => {
        const dateEl = document.querySelector('.date');
        const timeEl = document.querySelector('.show-meta-length');
        return {
          dateText: dateEl?.innerText?.trim() || '',
          timeText: timeEl?.innerText?.trim() || '',
        };
      });
      if (isoDate.dateText && !ev.eventStartDate) ev.details = isoDate.dateText;

    } catch (_) {
    } finally {
      await detailPage.close();
    }

    if (soldOut) {
      const avail = shermanDeriveAvailability(null, true);
      Object.assign(ev, avail);
      Object.assign(ev, shermanComputePopularity(ev));
      continue;
    }

    if (!bookingUrl) continue; // no booking link and not sold out — skip availability

    // Scrape seat map
    const seating = await shermanScrapeSeatingPage(context, bookingUrl);
    if (seating.error && !seating.total) continue;

    const avail = shermanDeriveAvailability(seating, false);
    Object.assign(ev, avail);
    if (seating.total > 0) {
      ev.seatingAggregate = {
        avgOccupancyPct:  seating.occupancyPct,
        available:        seating.available,
        occupied:         seating.occupied,
        total:            seating.total,
      };
    }
    Object.assign(ev, shermanComputePopularity(ev));
  }

  const withAvailability = events.filter(e => e.availability).length;
  console.log(`  Sherman: done. ${withAvailability}/${events.length} with availability.`);
  return events;
}

async function scrapeCanopi(context) {
  console.log('Scraping Canopi...');
  const page = await context.newPage();
  await gotoAndSettle(page, 'https://www.thecanopi.org/events', 'article.eventlist-event');
  await new Promise(r => setTimeout(r, 2_000));

  const events = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article.eventlist-event')).filter(item => {
      // Exclude past events
      return !item.classList.contains('eventlist-event--past');
    }).map(item => {
      const titleEl = item.querySelector('h1.eventlist-title a, h2.eventlist-title a');
      const dateEl = item.querySelector('time.event-date');
      const excerptEl = item.querySelector('.eventlist-excerpt');
      const img = item.querySelector('img[data-src], img[src]');
      const raw = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
      return {
        title: titleEl?.innerText.trim() || '',
        date: dateEl?.getAttribute('datetime') || dateEl?.innerText.trim() || '',
        description: excerptEl?.innerText.trim() || '',
        url: titleEl?.href || '',
        imageUrl: raw && !raw.startsWith('data:') ? raw : '',
        venue: 'Canopi Cardiff',
        scrapedAt: new Date().toISOString(),
      };
    }).filter(e => e.title);
  });

  await page.close();
  console.log(`  Canopi: ${events.length} events`);
  return events;
}
async function scrapeAcapela(context) {
  console.log('Scraping Acapela...');
  const page = await context.newPage();
  const allRaw = [];

  for (let p = 1; p <= 10; p++) {
    const url = p === 1
      ? 'https://acapela.co.uk/whats-on'
      : `https://acapela.co.uk/whats-on/page/${p}/`;
    await gotoAndSettle(page, url, 'article');

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article')).map(item => {
        const titleEl  = item.querySelector('h1,h2,h3,.entry-title,.post-title');
        const dateEl   = item.querySelector('time,.entry-date,.event-date,[class*="date"]');
        const linkEl   = item.querySelector('a[href*="/event"],a[href*="/whats-on"],.entry-title a,h2 a,h3 a');
        const img      = item.querySelector('img[src],img[data-src]');
        const statusEl = item.querySelector('[class*="status"],[class*="sold"],[class*="label"]');
        const raw = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        return {
          title:    titleEl?.innerText?.trim() || '',
          date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
          url:      linkEl?.href || '',
          imageUrl: raw && !raw.startsWith('data:') ? raw : '',
          status:   statusEl?.innerText?.trim() || '',
        };
      }).filter(e => e.title);
    });

    if (pageEvents.length === 0) break;
    allRaw.push(...pageEvents);
  }

  await page.close();

  // Normalise
  const events = allRaw.map(e => {
    const { cleanTitle, status } = extractAcapelaStatus(e.title);
    return {
      title:        cleanTitle,
      date:         normaliseAcapelaDate(e.date),
      url:          e.url,
      venue:        'Acapela',
      scrapedAt:    new Date().toISOString(),
      imageUrl:     e.imageUrl,
      availability: e.status || status,
    };
  });

  console.log(`  Acapela: ${events.length} events`);
  return events;
}

async function scrapeChapterArts(context) {
  console.log('Scraping Chapter Arts Centre...');
  const page = await context.newPage();
  const allRaw = [];

  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? 'https://www.chapter.org/whats-on'
      : `https://www.chapter.org/whats-on?page=${p}`;
    await gotoAndSettle(page, url, 'article');

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article')).map(item => {
        const titleEl = item.querySelector('h2,h3,h4,.title');
        const dateEl  = item.querySelector('time,[class*="date"],[datetime]');
        const linkEl  = item.querySelector('a[href]');
        const img     = item.querySelector('img[src],img[data-src],img[data-lazy]');
        const catEl   = item.querySelector('[class*="category"],[class*="tag"],[class*="genre"]');
        const raw     = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        const title   = titleEl?.innerText?.trim() || '';
        if (!title) return null;
        return {
          title,
          date:     dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
          url:      linkEl?.href || '',
          imageUrl: raw && !raw.startsWith('data:') ? raw : '',
          category: catEl?.innerText?.trim() || '',
        };
      }).filter(Boolean);
    });

    if (pageEvents.length === 0) break;
    allRaw.push(...pageEvents);
  }

  await page.close();

  // Deduplicate by URL, filter junk, clean titles
  const seen = new Set();
  const events = allRaw
    .filter(e => {
      const key = e.url || e.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter(e => !isChapterJunk(e))
    .map(e => ({
      title:     (e.title).replace(/[\u00a0\u200b\u202f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim(),
      date:      e.date,
      url:       e.url,
      venue:     'Chapter Arts Centre',
      scrapedAt: new Date().toISOString(),
      imageUrl:  e.imageUrl,
      category:  e.category,
    }));

  console.log(`  Chapter Arts: ${events.length} events`);
  return events;
}

async function scrapeCultVR(context) {
  console.log('Scraping CultVR...');
  const page = await context.newPage();
  const allRaw = [];

  for (let p = 1; p <= 5; p++) {
    const url = p === 1
      ? 'https://www.cultvr.cymru/whats-on/'
      : `https://www.cultvr.cymru/whats-on/page/${p}/`;
    await gotoAndSettle(page, url, 'article');

    const pageEvents = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('article.event,article.post,.event')).map(item => {
        const titleEl   = item.querySelector('h1,h2,h3,.entry-title');
        const dateEl    = item.querySelector('time[datetime],.event-date,[class*="date"]');
        const linkEl    = item.querySelector('a[href]');
        const img       = item.querySelector('img[src],img[data-src]');
        const excerptEl = item.querySelector('.entry-excerpt,.entry-summary,p');
        const raw       = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
        return {
          title:       titleEl?.innerText?.trim() || '',
          date:        dateEl?.innerText?.trim() || '',
          datetime:    dateEl?.getAttribute('datetime') || '',
          url:         linkEl?.href || '',
          imageUrl:    raw && !raw.startsWith('data:') ? raw : '',
          description: excerptEl?.innerText?.trim().slice(0, 200) || '',
        };
      }).filter(e => e.title);
    });

    if (pageEvents.length === 0) break;
    allRaw.push(...pageEvents);
  }

  await page.close();

  // Parse DD/MM/YYYY dates and filter past events
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July',
                       'August','September','October','November','December'];

  const events = allRaw
    .map(e => {
      const raw = e.date || e.datetime || '';
      const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      let formatted = raw;
      let startDate = null;
      if (m) {
        const [, dd, mm, yyyy] = m;
        const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
        if (!isNaN(d)) {
          formatted = `${DAY_NAMES[d.getDay()]}, ${Number(dd)} ${MONTH_NAMES[Number(mm)-1]} ${yyyy}`;
          startDate = d;
        }
      }
      return { ...e, _formatted: formatted, _startDate: startDate };
    })
    .filter(e => !e._startDate || e._startDate >= today)
    .map(({ _formatted, _startDate, datetime, ...e }) => ({
      title:       e.title,
      date:        _formatted,
      url:         e.url,
      venue:       'CultVR',
      scrapedAt:   new Date().toISOString(),
      imageUrl:    e.imageUrl,
      description: e.description,
    }));

  console.log(`  CultVR: ${events.length} events`);
  return events;
}
// ---------------------------------------------------------------------------
// Acapela / Chapter / CultVR helpers
// ---------------------------------------------------------------------------

function extractAcapelaStatus(title) {
  const m = title.match(/\s*[(-]?\s*(SOLD\s*OUT|SELLING\s*FAST|FEW\s*LEFT|LIMITED)\s*[)-]?\s*$/i);
  if (!m) return { cleanTitle: title.trim(), status: '' };
  return {
    cleanTitle: title.slice(0, m.index).trim(),
    status:     m[1].toUpperCase().replace(/\s+/g, ' '),
  };
}

function normaliseAcapelaDate(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
  const m = clean.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return raw;
  const dayNum   = parseInt(m[1], 10);
  const monthIdx = ['January','February','March','April','May','June','July',
                    'August','September','October','November','December']
                    .findIndex(mn => mn.toLowerCase() === m[2].toLowerCase());
  if (monthIdx === -1) return raw;
  const d = new Date(Number(m[3]), monthIdx, dayNum);
  if (isNaN(d)) return raw;
  return d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

const CHAPTER_NAV_URL_PATTERNS = [
  /\/about(\/|$)/, /\/hire(\/|$)/, /\/visit(\/|$)/,
  /\/support-us(\/|$)/, /\/guide\//, /\/food-drink(\/|$)/,
];
const CHAPTER_NAV_TITLES = new Set([
  'CINEMA','THEATRE','GALLERY','FOOD & DRINK','VISIT','HIRE','SUPPORT US','ABOUT',
]);

function isChapterJunk(e) {
  const title = (e.title || '').trim();
  const url   = (e.url   || '').trim();
  const date  = (e.date  || '').trim();
  if (CHAPTER_NAV_TITLES.has(title.toUpperCase())) return true;
  if (url && CHAPTER_NAV_URL_PATTERNS.some(p => p.test(url))) return true;
  if (/first name|last name|email address/i.test(date)) return true;
  if (!date && !e.imageUrl && /[.!?]$/.test(title)) return true;
  if (!date && /^[A-Z\s'':–-]+$/.test(title) && title.includes(':')) return true;
  return false;
}

async function scrapeClwb(context) {
  console.log('Scraping Clwb Ifor Bach...');
  const page = await context.newPage();

  // Wait for any recognisable event container
  await page.goto('https://clwb.net/whats-on/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForSelector(
    [
      '#eventsListings li.grid-item',
      'li.grid-item',
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
    ].join(', '),
    { state: 'attached', timeout: 20_000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 2_000));

  // Diagnostic dump when needed
  const selectorAudit = await page.evaluate(() => {
    const checks = [
      '#eventsListings li.grid-item',
      'li.grid-item',
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
      'a[href*="/event"]',
      'a[href*="seetickets"]',
    ];
    return checks.map(sel => ({ sel, count: document.querySelectorAll(sel).length }));
  });
  console.log('  Clwb selector audit:', JSON.stringify(selectorAudit));

  if (selectorAudit.every(r => r.count === 0)) {
    const pageDump = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').slice(0, 800).replace(/\s+/g, ' ');
      const allLinks = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href') || '')
        .filter(h => h && !h.startsWith('#') && !h.startsWith('javascript'))
        .slice(0, 40);
      const tagClasses = {};
      for (const tag of ['article', 'li', 'div', 'section']) {
        const els = document.querySelectorAll(tag + '[class]');
        const cls = new Set();
        for (const el of els) for (const c of el.classList) cls.add(c);
        if (cls.size) tagClasses[tag] = [...cls].slice(0, 30).join(' ');
      }
      return { bodyText, allLinks, tagClasses };
    });
    console.log('  Clwb body snippet:', pageDump.bodyText);
    console.log('  Clwb all links (sample):', pageDump.allLinks);
    console.log('  Clwb element classes:', JSON.stringify(pageDump.tagClasses));
  }

  const events = await page.evaluate(() => {
    function extractItem(item) {
      let imageUrl = '';
      const img = item.querySelector('figure img, .grid-item-image img, img[src], img[data-src], img[data-lazy-src]');
      if (img) {
        const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (raw && !raw.startsWith('data:')) {
          try { imageUrl = new URL(raw, location.href).href; } catch { imageUrl = raw.trim(); }
        }
      }
      const title = item.querySelector('h3.grid-item-title, h2, h3, .tribe-event-url, .event-title')?.innerText?.trim() || '';
      const dateEl = item.querySelector(
        'p.grid-item-support.date-translate, p.date-translate, .tribe-event-date-start, time, .event-date, span[class*="date"]'
      );
      const details = Array.from(item.querySelectorAll('p.grid-item-support:not(.date-translate)'))
        .map(p => p.innerText.trim()).filter(Boolean).join(' • ');
      const url =
        item.querySelector('a.tickets-button, a[href*="seetickets"], a[href*="fatsoma"], figure a, .grid-item-image a')?.href ||
        item.querySelector('a.url, a[href*="/event"]')?.href ||
        item.querySelector('a[href^="http"]')?.href || '';
      return {
        title,
        date: dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '',
        details,
        url,
        venue: 'Clwb Ifor Bach',
        scrapedAt: new Date().toISOString(),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }

    const strategies = [
      '#eventsListings li.grid-item',
      'li.grid-item',
      'article.type-tribe_events',
      '.tribe-events-pro-grid__event',
      '.tribe-common-l-container article',
      'article[class*="event"]',
      '.event-item',
    ];

    for (const sel of strategies) {
      const items = Array.from(document.querySelectorAll(sel));
      if (items.length > 0) return items.map(extractItem).filter(e => e.title);
    }
    return [];
  });

  await page.close();
  console.log(`  Clwb: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function normalizeUrlForDedupe(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch { return s.split('?')[0].split('#')[0].replace(/\/+$/, '').trim().toLowerCase(); }
}

function normalizeTitleForDedupe(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const GENERIC_LISTING_URLS = new Set([
  normalizeUrlForDedupe('https://www.thegate.org.uk/whats-on'),
]);

function isGenericListingUrl(normalizedUrl) {
  if (GENERIC_LISTING_URLS.has(normalizedUrl)) return true;
  if (/paradise-garden\.co\.uk\/events\/[a-z]+\d{4}$/.test(normalizedUrl)) return true;
  return false;
}

function eventDedupeKey(ev) {
  const url = typeof ev.url === 'string' ? ev.url.trim() : '';
  const nu = normalizeUrlForDedupe(url);
  if (nu && /^https?:\/\//i.test(url) && !isGenericListingUrl(nu)) return `url:${nu}`;
  const title = normalizeTitleForDedupe(ev.title);
  const date = String(ev.date || ev.eventStartDate || '').trim().toLowerCase();
  const venue = String(ev.venue || '').trim().toLowerCase();
  return `meta:${title}|${date}|${venue}`;
}

function dedupeEventsPreservingOrder(events) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const ev of events) {
    const k = eventDedupeKey(ev);
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k);
    out.push(ev);
  }
  return { events: out, dropped };
}

function findDuplicateEventGroups(events) {
  if (!Array.isArray(events)) return [];
  const map = new Map();
  for (let i = 0; i < events.length; i++) {
    const k = eventDedupeKey(events[i]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map.entries()].filter(([, idxs]) => idxs.length > 1).map(([key, indices]) => ({ key, indices }));
}

function summarizeEventLine(ev, index) {
  const bits = [
    typeof index === 'number' ? `[${index}]` : '',
    (ev.title || '(no title)').slice(0, 80),
    ev.date ? `— ${String(ev.date).slice(0, 60)}` : '',
    ev.venue ? `@ ${ev.venue}` : '',
    ev.url ? `<${String(ev.url).slice(0, 90)}${String(ev.url).length > 90 ? '…' : ''}>` : '',
  ];
  return bits.filter(Boolean).join(' ');
}

function printDuplicateReview(events) {
  const groups = findDuplicateEventGroups(events);
  if (!groups.length) {
    console.log(`No duplicates among ${events.length} events.`);
    return { groups: [], redundant: 0 };
  }
  let redundant = 0;
  console.log(`\nDuplicate review: ${groups.length} group(s) among ${events.length} events\n`);
  for (let g = 0; g < groups.length; g++) {
    const { key, indices } = groups[g];
    redundant += indices.length - 1;
    console.log(`--- Group ${g + 1} (${indices.length} rows) ${key.slice(0, 120)}`);
    for (const i of indices) console.log(`  ${summarizeEventLine(events[i], i)}`);
    console.log('');
  }
  console.log(`Summary: ${redundant} redundant row(s) could be dropped.`);
  return { groups, redundant };
}

// ---------------------------------------------------------------------------
// Main scrape orchestration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Llandaff Cathedral — sourced from ents24.com venue page
// ---------------------------------------------------------------------------
async function scrapeLlandaffCathedral(context) {
  console.log('Scraping Llandaff Cathedral...');
  const page = await context.newPage();
  const BASE = 'https://www.ents24.com';

  await gotoAndSettle(page, `${BASE}/cardiff-events/llandaff-cathedral`, 'li.strip');
  await new Promise(r => setTimeout(r, 2_000));

  const listings = await page.evaluate((base) => {
    return Array.from(document.querySelectorAll('li.strip')).map(li => {
      const timeEl   = li.querySelector('time[datetime]');
      const whatEl   = li.querySelector('.what.text-bold');
      const perfEl   = li.querySelector('.what.text-bold .text-dull');
      const linkEl   = li.querySelector('a.what-and-where');
      const ctaEl    = li.querySelector('.going-cta a');

      const cancelled = ctaEl?.textContent?.trim().toLowerCase() === 'cancelled';
      const relHref   = linkEl?.getAttribute('href') || '';

      // Strip the performer span text from the title
      const performerName = perfEl?.textContent?.trim() || '';
      let title = whatEl?.textContent?.trim() || '';
      if (performerName) title = title.replace(performerName, '').trim();

      return {
        date:          timeEl?.getAttribute('datetime') || '',
        title,
        performerName,
        url:           relHref ? base + relHref : '',
        cancelled,
      };
    }).filter(e => e.title && !e.cancelled && e.date);
  }, BASE);

  // Visit each event page for start time, image and description
  const events = [];
  for (const item of listings) {
    try {
      await gotoAndSettle(page, item.url, 'main.event-page', { timeout: 15_000 });
      await new Promise(r => setTimeout(r, 1_000));

      const detail = await page.evaluate(() => {
        // Time: look for "at HH:MMpm" pattern in the date/time block
        const dateBlock = document.querySelector('.bg-card');
        const timeMatch = dateBlock?.textContent?.match(/at\s+(\d{1,2}:\d{2}(?:am|pm))/i);
        const startTime = timeMatch ? timeMatch[1] : '';

        // Description
        const descEl = document.querySelector('.bg-dank-card .space-y-4');
        const description = descEl?.innerText?.trim() || '';

        // Image
        const imgEl = document.querySelector('picture source[srcset], .entity img[src]');
        const imageUrl = imgEl?.getAttribute('srcset')?.split('?')[0] ||
                         imgEl?.getAttribute('src')?.split('?')[0] || '';

        return { startTime, description, imageUrl };
      });

      events.push({
        title:          item.title,
        date:           item.date,
        startTime:      detail.startTime,
        venue:          'Llandaff Cathedral',
        url:            item.url,
        description:    detail.description,
        imageUrl:       detail.imageUrl,
        performerNames: item.performerName ? [item.performerName] : [],
        scrapedAt:      new Date().toISOString(),
      });
    } catch (e) {
      console.log(`  Llandaff Cathedral: skipping ${item.title} — ${e.message.split('\n')[0]}`);
    }
  }

  await page.close();
  console.log(`  Llandaff Cathedral: ${events.length} events`);
  return events;
}

// ---------------------------------------------------------------------------
// Paradise Garden
// ---------------------------------------------------------------------------

async function scrapeParadiseGarden(context) {
  console.log('Scraping Paradise Garden...');
  const page = await context.newPage();

  // Determine the current and next month slugs (e.g. "june2026", "july2026")
  const MONTH_NAMES = ['january','february','march','april','may','june',
                       'july','august','september','october','november','december'];
  const now = new Date();
  const monthSlugs = [
    MONTH_NAMES[now.getMonth()] + now.getFullYear(),
    MONTH_NAMES[(now.getMonth() + 1) % 12] + (now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear()),
  ];

  const events = [];

  for (const slug of monthSlugs) {
    const url = `https://www.paradise-garden.co.uk/events/${slug}`;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {});
      // Wait for the event text block to appear (Squarespace renders via JS)
      await page.waitForSelector('.sqs-html-content h3, .sqs-html-content h4, .sqs-html-content p strong', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(1500);

      // Check the page actually has content (month may not be published yet)
      const hasContent = await page.evaluate(() =>
        !!document.querySelector('.sqs-html-content h3, .sqs-html-content h4')
      );
      if (!hasContent) {
        console.log(`  Paradise Garden: no event content at ${url}, skipping`);
        continue;
      }

      const pageData = await page.evaluate((slug) => {
        // Extract month/year from slug (e.g. "june2026")
        const monthMatch = slug.match(/^([a-z]+)(\d{4})$/);
        const monthName = monthMatch ? monthMatch[1] : '';
        const year = monthMatch ? parseInt(monthMatch[2], 10) : new Date().getFullYear();
        const MONTH_MAP = {
          january:1, february:2, march:3, april:4, may:5, june:6,
          july:7, august:8, september:9, october:10, november:11, december:12,
        };
        const monthNum = MONTH_MAP[monthName] || 1;

        // First image from the gallery grid — used for all events this month.
        // Squarespace can use data-src, data-image, or src on the img element.
        const gridImg = document.querySelector(
          '.gallery-grid-item img, figure[class*="gallery"] img, [class*="gallery-grid"] img'
        );
        const imageUrl = gridImg
          ? (
              gridImg.getAttribute('data-image') ||
              gridImg.getAttribute('data-src') ||
              gridImg.getAttribute('src') || ''
            ).split('?format=')[0]
          : '';

        // Find the .sqs-html-content block that contains the event listing.
        // There may be several blocks; pick the one with the most h3/h4 headings.
        const allBlocks = Array.from(document.querySelectorAll('.sqs-html-content'));
        const content = allBlocks.reduce((best, block) => {
          const count = block.querySelectorAll('h3, h4').length;
          return count > (best ? best.querySelectorAll('h3, h4').length : 0) ? block : best;
        }, null);

        if (!content) return { imageUrl, events: [], debug: 'no .sqs-html-content found' };

        // Flatten all descendant elements (not just direct children) so we handle
        // nested wrappers that Squarespace sometimes injects.
        const elements = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,p'));

        const parsedEvents = [];
        let currentDate = null;
        let currentTitle = null;
        let currentDesc = [];

        function flushEvent() {
          if (!currentDate || !currentTitle) return;
          const titleText = currentTitle.trim();
          if (titleText) {
            const dateStr = `${year}-${String(monthNum).padStart(2,'0')}-${String(currentDate.day).padStart(2,'0')}`;
            parsedEvents.push({ dateStr, title: titleText, description: currentDesc.join('\n').trim() });
          }
          currentTitle = null;
          currentDesc = [];
        }

        function tryParseDate(text) {
          const m = text.trim().match(/^(?:mon|tue|tues|wed|thur|thu|fri|sat|sun)\.?\s+(\d{1,2})(?:\s|\(|$)/i);
          return m ? parseInt(m[1], 10) : null;
        }

        for (const el of elements) {
          const tag = el.tagName.toLowerCase();
         const rawText = (el.textContent || '').trim();
          if (!rawText) continue;

          // Date: h4 like "wed 3", or p>strong like "fri 5" or "fri 5 (new distraktions)"
          if (tag === 'h4' || tag === 'h5') {
            const dayNum = tryParseDate(rawText);
            if (dayNum != null) {
              flushEvent();
              currentDate = { day: dayNum };
              continue;
            }
            // h4 with no day number may be a sub-description — treat as desc if we have a title
            if (currentTitle) currentDesc.push(rawText);
            continue;
          }

          if (tag === 'p') {
            // Bold paragraph used as date marker: <p><strong>fri 5</strong></p>
            const strongText = (el.querySelector('strong, b')?.textContent || '').trim();
            const candidateText = strongText || rawText;
            const dayNum = tryParseDate(candidateText);
            if (dayNum != null) {
              flushEvent();
              currentDate = { day: dayNum };
              // If the <p> had extra text after the date (e.g. "(new distraktions)") ignore it
              continue;
            }
            if (currentTitle) currentDesc.push(rawText);
            continue;
          }

          if (tag === 'h3') {
            if (!currentDate) continue;
            // Each h3 is a distinct event on the same date
            flushEvent();
            currentTitle = rawText;
            continue;
          }

          if (tag === 'h2') {
            // Section headers like "june 2026 events at paradise garden:" — skip
            continue;
          }
        }
        flushEvent();

        return { imageUrl, events: parsedEvents };
      }, slug);

      for (const ev of pageData.events) {
        // Skip "private hire" and blank titles
        if (!ev.title || /^private\s+hire$/i.test(ev.title)) continue;
        events.push({
          title: ev.title,
          date: ev.dateStr,
          eventStartDate: ev.dateStr,
          description: ev.description || '',
          venue: 'Paradise Garden',
          url: url,
          imageUrl: pageData.imageUrl,
          scrapedAt: new Date().toISOString(),
        });
      }

      console.log(`  Paradise Garden: ${pageData.events.length} events from ${slug}`);
    } catch (err) {
      console.warn(`  Paradise Garden: failed to scrape ${url}: ${err.message}`);
    }
  }

  await page.close();
  console.log(`  Paradise Garden: ${events.length} total events`);
  return events;
}

// ---------------------------------------------------------------------------
// Per-venue result sanity check
// ---------------------------------------------------------------------------

/** Venues with fewer previous events than this are too small to judge. */
const VENUE_DROP_MIN_BASELINE = 15;
/** Warn when a venue returns less than this share of its previous count. */
const VENUE_DROP_RATIO = 0.5;

function countEventsByVenue(events) {
  const counts = new Map();
  for (const ev of events) {
    const venue = String(ev.venue || '').trim();
    if (!venue) continue;
    counts.set(venue, (counts.get(venue) || 0) + 1);
  }
  return counts;
}

/**
 * Log a GitHub Actions warning annotation for any venue whose fresh event
 * count collapsed relative to the previous scrape. A broken listing page
 * usually still yields its first page of results, so the scrape looks
 * successful — this is the signal that it wasn't.
 */
function reportVenueCountDrops(previousEvents, freshEvents) {
  const prevCounts = countEventsByVenue(previousEvents);
  const freshCounts = countEventsByVenue(freshEvents);
  for (const [venue, freshCount] of freshCounts) {
    const prevCount = prevCounts.get(venue) || 0;
    if (prevCount < VENUE_DROP_MIN_BASELINE) continue;
    if (freshCount >= prevCount * VENUE_DROP_RATIO) continue;
    console.log(
      `::warning title=Venue event count dropped::${venue}: scraped ${freshCount} ` +
      `events, down from ${prevCount} in the previous run. The listing page or its ` +
      `pagination has probably changed — check the scraper before trusting this run.`
    );
  }
}

// ---------------------------------------------------------------------------
// Venue registry — single source of truth for name → scraper mapping
// ---------------------------------------------------------------------------

const SCRAPERS = [
  { name: 'Globe',          fn: scrapeGlobe         },
  { name: 'WMC',            fn: scrapeWMC            },
  { name: 'New Theatre',    fn: scrapeNewTheatre     },
  { name: 'Tramshed',       fn: scrapeTramshed       },
  { name: 'Utilita Arena',  fn: scrapeUtilitaArena   },
  { name: 'Depot',          fn: scrapeDepot          },
  { name: 'Cardiff SU',     fn: scrapeCardiffSU      },
  { name: 'The Gate',       fn: scrapeTheGate        },
  { name: 'Clwb',           fn: scrapeClwb           },
  { name: 'Fuel',           fn: scrapeFuel           },
  { name: 'Principality',   fn: scrapePrincipality   },
  { name: 'Sherman',        fn: scrapeSherman        },
  { name: 'Canopi',         fn: scrapeCanopi         },
  { name: 'CultVR',              fn: scrapeCultVR              },
  { name: 'Llandaff Cathedral',  fn: scrapeLlandaffCathedral  },
  { name: 'Paradise Garden',    fn: scrapeParadiseGarden     },
  // { name: 'Acapela',          fn: scrapeAcapela             },
  // { name: 'Chapter Arts',     fn: scrapeChapterArts         },
];

/**
 * Resolve which scrapers to run from CLI args and env var.
 *
 * Priority:
 *   1. --venue <Name> flags (repeatable, case-insensitive)
 *   2. SCRAPE_VENUES=Name1,Name2 env var
 *   3. No filter → run all enabled scrapers
 *
 * Logs the resolved set and exits with an error if an unknown name is given.
 */
function resolveScrapers(argv) {
  const flagVenues = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--venue' && argv[i + 1]) flagVenues.push(argv[++i]);
  }
  const envVenues = (process.env.SCRAPE_VENUES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const requested = flagVenues.length ? flagVenues : envVenues;
  if (!requested.length) return SCRAPERS;

  const byNameLower = new Map(SCRAPERS.map((s) => [s.name.toLowerCase(), s]));
  const resolved = [];
  for (const r of requested) {
    const s = byNameLower.get(r.toLowerCase());
    if (!s) {
      console.error(`Unknown venue "${r}". Known venues: ${SCRAPERS.map((x) => x.name).join(', ')}`);
      process.exit(1);
    }
    resolved.push(s);
  }
  return resolved;
}

async function scrapeAll(selectedScrapers) {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
  });

  const failedScrapers = new Set();

  async function safeScrap(fn, name, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await fn(); } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          console.log(`  ${name}: attempt ${attempt + 1} failed (${e.message.split('\n')[0]}), retrying...`);
          await new Promise(r => setTimeout(r, 3_000));
        }
      }
    }
    console.log(`  ${name} failed: ${lastErr.message.split('\n')[0]}`);
    failedScrapers.add(name);
    return [];
  }

  const partial = selectedScrapers.length < SCRAPERS.length;
  if (partial) {
    console.log(`Running partial scrape: ${selectedScrapers.map((s) => s.name).join(', ')}`);
  }

  let freshEvents = [];
  for (const { name, fn } of selectedScrapers) {
    const results = await safeScrap(() => fn(context), name);
    freshEvents.push(...results);
  }

  freshEvents = await enrichAllEvents(context, freshEvents);

  await browser.close();

  const { events: dedupedFresh, dropped } = dedupeEventsPreservingOrder(freshEvents);
  if (dropped > 0) console.log(`\nRemoved ${dropped} duplicate event row(s).`);

  // Load existing events.json
  let previousEvents = [];
  if (fs.existsSync('events.json')) {
    try {
      previousEvents = JSON.parse(fs.readFileSync('events.json', 'utf8'));
    } catch (_) {}
  }

  // A scraper can "succeed" while returning only a fraction of a venue's
  // listing — a site redesign that breaks pagination leaves the first page
  // intact, so nothing throws and the rest of the venue is silently deleted
  // from events.json. Make a large drop loud instead of invisible.
  reportVenueCountDrops(previousEvents, dedupedFresh);

  // Only replace a venue's events if we actually got results back for it.
  // Failed scrapers (returned [] due to error) leave previous events untouched
  // so a transient failure doesn't wipe the venue from events.json.
  const successVenueNames = new Set(dedupedFresh.map((e) => e.venue));
  let baseEvents;
  if (partial) {
    // Keep events from venues we didn't attempt, plus any failed venues.
    baseEvents = previousEvents.filter((e) => !successVenueNames.has(e.venue));
  } else {
    // Full scrape: clear only venues we successfully retrieved data for.
    if (failedScrapers.size > 0) {
      console.log(`Preserving previous events for failed venues: ${[...failedScrapers].join(', ')}`);
    }
    baseEvents = previousEvents.filter((e) => !successVenueNames.has(e.venue));
  }

  // Build a lookup of previous event data by dedupe key (across all previous events)
  const previousScrapedAt = new Map();
  const previousDescriptions = new Map();
  for (const ev of previousEvents) {
    const k = eventDedupeKey(ev);
    if (ev.scrapedAt && !previousScrapedAt.has(k)) {
      previousScrapedAt.set(k, ev.scrapedAt);
    }
    if (ev.description && !previousDescriptions.has(k)) {
      previousDescriptions.set(k, ev.description);
    }
  }

  // Stamp new events, preserve scrapedAt for events we've seen before.
  // Also preserve description from the previous scrape if the fresh scrape
  // returned an empty string — transient page-load failures shouldn't wipe
  // a description that was successfully captured in an earlier run.
  const now = new Date().toISOString();
  let newCount = 0;
  const stamped = dedupedFresh.map((ev) => {
    const k = eventDedupeKey(ev);
    const existingScrapedAt = previousScrapedAt.get(k);
    const existingDescription = previousDescriptions.get(k);
    const description = ev.description || existingDescription || ev.description;
    const base = existingScrapedAt ? { ...ev, scrapedAt: existingScrapedAt } : { ...ev, scrapedAt: now };
    if (!existingScrapedAt) newCount++;
    return description !== ev.description ? { ...base, description } : base;
  });

  if (newCount > 0) console.log(`\n${newCount} new event(s) detected since last scrape`);

  // Merge: untouched venues first (preserving their order), then fresh results
  const { events: final } = dedupeEventsPreservingOrder([...baseEvents, ...stamped]);

  fs.writeFileSync('events.json', JSON.stringify(final, null, 2));
  console.log(`Total: ${final.length} events saved to events.json`);
}

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------

if (require.main === module && process.argv.includes('--dates-only')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  const out = list.map((ev) => finalizeEvent(ev));
  fs.writeFileSync('events.json', JSON.stringify(out, null, 2));
  const missing = out.filter((e) => !e.date || !String(e.date).trim()).length;
  console.log(`--dates-only: wrote ${out.length} events (${missing} still missing date)`);
} else if (require.main === module && process.argv.includes('--review-duplicates')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  printDuplicateReview(list);
  if (process.argv.includes('--strict') && findDuplicateEventGroups(list).length) process.exit(1);
} else if (require.main === module && process.argv.includes('--dedupe-events')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  const finalized = list.map((ev) => finalizeEvent(ev));
  printDuplicateReview(finalized);
  const { events: deduped, dropped } = dedupeEventsPreservingOrder(finalized);
  if (dropped > 0) {
    fs.writeFileSync('events.json', JSON.stringify(deduped, null, 2));
    console.log(`\n--dedupe-events: wrote ${deduped.length} events (removed ${dropped}).`);
  } else {
    console.log('\n--dedupe-events: nothing to remove.');
  }
} else if (require.main === module && process.argv.includes('--music-genre-stats')) {
  const list = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  if (!Array.isArray(list)) { console.error('events.json must be a JSON array.'); process.exit(1); }
  const total = list.length;
  const musicGenresFilled = list.filter((e) => Array.isArray(e.musicGenres) && e.musicGenres.length > 0).length;
  const genreFilled = list.filter((e) => typeof e.genre === 'string' && e.genre.trim()).length;
  console.log(`--music-genre-stats`);
  console.log(`  total events: ${total}`);
  console.log(`  musicGenres filled: ${musicGenresFilled} (${total ? Math.round((musicGenresFilled / total) * 100) : 0}%)`);
  console.log(`  genre filled: ${genreFilled}`);
} else if (require.main === module) {
  scrapeAll(resolveScrapers(process.argv.slice(2))).catch(console.error);
}
