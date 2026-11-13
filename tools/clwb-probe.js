/* Temporary diagnostic: probe which of Clwb Ifor Bach's public data interfaces
   this runner can read. Tests the site's own published endpoints (sitemap, WP
   REST API, RSS) and ordinary page loads. No attempt to evade bot protection:
   where the site blocks us, the probe records the block and moves on. */
const { chromium } = require('playwright');

// Honest, contactable identification rather than a spoofed browser string.
const UA = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';

const JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json, */*' };
const HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-GB,en;q=0.9' };
const XML_HEADERS  = { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,*/*' };

const INTERESTING = ['server','cf-ray','cf-mitigated','cf-cache-status','x-powered-by',
  'content-type','location','retry-after','x-sucuri-block','x-robots-tag'];

const pick = h => Object.fromEntries(INTERESTING.filter(k => h[k]).map(k => [k, String(h[k]).slice(0,160)]));

async function probe(label, url, headers = HTML_HEADERS) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const h = {}; res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    console.log(`\n--- [${label}] ${url}`);
    console.log(`    status ${res.status} ${res.statusText} | bytes ${buf.length} | ${Date.now()-t0}ms | final ${res.url}`);
    console.log(`    headers ${JSON.stringify(pick(h))}`);
    console.log(`    body[0:300] ${text.slice(0,300).replace(/\s+/g,' ')}`);
    return { label, status: res.status, bytes: buf.length, text, headers: h };
  } catch (e) {
    console.log(`\n--- [${label}] ${url}\n    ERROR ${e.message}`);
    return { label, error: e.message };
  }
}

async function pageProbe(label, url) {
  console.log(`\n=== [page:${label}] ${url}`);
  let browser;
  try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      userAgent: UA, viewport: { width: 1365, height: 900 },
      locale: 'en-GB', timezoneId: 'Europe/London',
    });
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    console.log(`    main response ${resp ? resp.status() : 'null'}`);
    if (resp) console.log(`    headers ${JSON.stringify(pick(await resp.allHeaders()))}`);
    const appeared = await page.waitForSelector('#eventsListings li.grid-item', { state: 'attached', timeout: 20_000 })
      .then(() => true).catch(() => false);
    const info = await page.evaluate(() => {
      const counts = {};
      for (const sel of ['#eventsListings li.grid-item','li.grid-item','#eventsListings','article',
                         '.grid-item','a[href*="seetickets"]','a[href*="fatsoma"]'])
        counts[sel] = document.querySelectorAll(sel).length;
      return { title: document.title, counts,
               bodyText: (document.body?.innerText||'').slice(0,400).replace(/\s+/g,' '),
               htmlLen: document.documentElement.outerHTML.length };
    });
    console.log(`    grid-item appeared: ${appeared} | title: ${info.title} | htmlLen ${info.htmlLen}`);
    console.log(`    counts ${JSON.stringify(info.counts)}`);
    console.log(`    bodyText ${info.bodyText}`);
    await browser.close();
    return { label, ok: appeared };
  } catch (e) {
    console.log(`    ERROR ${e.message.split('\n')[0]}`);
    if (browser) await browser.close().catch(()=>{});
    return { label, error: e.message };
  }
}

(async () => {
  console.log('######## CLWB ACCESS PROBE ########');
  console.log('node', process.version, '| playwright', require('playwright/package.json').version);

  console.log('\n======== 1. ordinary page request ========');
  const listing = await probe('whats-on', 'https://clwb.net/whats-on/');
  await probe('robots.txt', 'https://clwb.net/robots.txt');

  console.log('\n======== 2. sitemap (site-published) ========');
  const sm = await probe('tm-events-sitemap', 'https://clwb.net/tm-events-sitemap.xml', XML_HEADERS);
  let firstEventUrl = null;
  if (sm.text) {
    const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    console.log(`    sitemap entries: ${locs.length}`);
    console.log(`    sample: ${JSON.stringify(locs.slice(0,8), null, 1)}`);
    firstEventUrl = locs[0] || null;
  }
  await probe('sitemap-index', 'https://clwb.net/sitemap_index.xml', XML_HEADERS);

  if (firstEventUrl) {
    console.log('\n======== 2b. single event page + structured data ========');
    const one = await probe('event-page', firstEventUrl);
    if (one.text) {
      const ld = [...one.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
      console.log(`    ld+json blocks: ${ld.length}`);
      ld.slice(0,3).forEach((b,i) => console.log(`    ld[${i}][0:500] ${b.slice(0,500).replace(/\s+/g,' ')}`));
      console.log(`    has seetickets link: ${/seetickets/.test(one.text)} | fatsoma: ${/fatsoma/.test(one.text)}`);
    }
  }

  console.log('\n======== 3. WordPress / Events Calendar REST + RSS ========');
  for (const p of ['/wp-json/','/wp-json/wp/v2/types','/wp-json/wp/v2/tm-events?per_page=5',
                   '/wp-json/tribe/events/v1/events?per_page=5','/feed/','/whats-on/feed/']) {
    await probe(`rest:${p}`, `https://clwb.net${p}`, p.includes('feed') ? XML_HEADERS : JSON_HEADERS);
  }

  console.log('\n======== 4. is the listing server-rendered? ========');
  if (listing.text) {
    const t = listing.text;
    for (const [k, v] of Object.entries({
      'eventsListings': t.includes('eventsListings'),
      'grid-item count': (t.match(/grid-item/g)||[]).length,
      'seetickets count': (t.match(/seetickets/g)||[]).length,
      'fatsoma count': (t.match(/fatsoma/g)||[]).length,
      'challenge markers': /cf-browser-verification|challenge-platform|Just a moment|Attention Required/i.test(t),
      'admin-ajax': t.includes('admin-ajax.php'),
    })) console.log(`    ${k}: ${v}`);
  }

  console.log('\n======== 5. headless page load ========');
  await pageProbe('listing', 'https://clwb.net/whats-on/');

  console.log('\n######## PROBE COMPLETE ########');
})();
