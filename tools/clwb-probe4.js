/* Temporary diagnostic round 4: what does an individual clwb.net event page
   carry? Determines whether the tm-events sitemap is a viable fallback source
   (title, date, ticket link) when the listing page cannot be read. */
const UA = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';
const H = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-GB,en;q=0.9' };

(async () => {
  console.log('######## CLWB EVENT-PAGE STRUCTURE ########');
  const sm = await (await fetch('https://clwb.net/tm-events-sitemap.xml', { headers: H })).text();
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    .filter(u => /\/events\/[^/]+\/$/.test(u));
  console.log(`event URLs in sitemap: ${locs.length}`);
  console.log(`sample: ${JSON.stringify(locs.slice(0, 5), null, 1)}`);

  for (const url of locs.slice(0, 3)) {
    console.log(`\n==== ${url}`);
    const res = await fetch(url, { headers: H });
    const html = await res.text();
    console.log(`    status ${res.status} | bytes ${html.length}`);

    const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    console.log(`    ld+json blocks: ${ld.length}`);
    for (const b of ld) {
      try {
        const j = JSON.parse(b);
        const found = [];
        (function walk(n, d) {
          if (!n || typeof n !== 'object' || d > 10) return;
          if (Array.isArray(n)) return n.forEach(x => walk(x, d + 1));
          const t = [].concat(n['@type'] || []);
          if (t.some(x => /Event/.test(x))) found.push(n);
          Object.values(n).forEach(v => v && typeof v === 'object' && walk(v, d + 1));
        })(j, 0);
        if (found.length) console.log(`    EVENT NODE: ${JSON.stringify(found[0]).slice(0, 700)}`);
      } catch {}
    }

    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const ogTitle = (html.match(/property=["']og:title["'][^>]*content=["']([^"']*)/) || [])[1] || '';
    const ogImage = (html.match(/property=["']og:image["'][^>]*content=["']([^"']*)/) || [])[1] || '';
    console.log(`    <title> ${title.trim().slice(0,120)}`);
    console.log(`    og:title ${ogTitle} | og:image ${ogImage}`);

    const tickets = [...new Set([...html.matchAll(/href=["'](https?:\/\/[^"']*(?:seetickets|fatsoma)[^"']*)["']/g)].map(m => m[1]))];
    console.log(`    ticket links (${tickets.length}): ${JSON.stringify(tickets.slice(0, 4))}`);

    // Date-ish text blocks the listing normally supplies.
    const dateish = [...html.matchAll(/class=["'][^"']*date[^"']*["'][^>]*>([^<]{4,60})</gi)].map(m => m[1].trim());
    console.log(`    date-ish: ${JSON.stringify([...new Set(dateish)].slice(0, 6))}`);
    const timeTag = [...html.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>([^<]*)</g)].map(m => m[1] + ' | ' + m[2].trim());
    console.log(`    <time>: ${JSON.stringify(timeTag.slice(0, 6))}`);
  }
  console.log('\n######## ROUND 4 COMPLETE ########');
})();

/* Appended: dump current listing markup so extraction can be verified against
   the live DOM rather than assumed from the old format. */
(async () => {
  const { chromium } = require('playwright');
  console.log('\n######## CLWB LISTING MARKUP DUMP ########');
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1365, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://clwb.net/whats-on/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('#eventsListings li.grid-item', { state: 'attached', timeout: 20_000 }).catch(()=>{});

  const dump = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#eventsListings li.grid-item')];
    const selCounts = {};
    for (const s of ['p.grid-item-support.date-translate','p.date-translate','p.grid-item-support',
                     'h3.grid-item-title','a.tickets-button','figure img','.grid-item-image a'])
      selCounts[s] = document.querySelectorAll(s).length;
    return {
      total: items.length,
      selCounts,
      firstHtml: items[0] ? items[0].outerHTML.slice(0, 1800) : '(none)',
      extracted: items.slice(0, 6).map(it => ({
        title: it.querySelector('h3.grid-item-title, h2, h3')?.innerText?.trim() || '',
        dateTranslate: it.querySelector('p.grid-item-support.date-translate, p.date-translate')?.innerText?.trim() || '',
        supports: [...it.querySelectorAll('p.grid-item-support')].map(p => p.innerText.trim()),
        url: it.querySelector('a.tickets-button, a[href*="seetickets"], a[href*="fatsoma"], figure a, .grid-item-image a')?.href || '',
      })),
    };
  });
  console.log(`items: ${dump.total}`);
  console.log(`selector counts: ${JSON.stringify(dump.selCounts, null, 1)}`);
  console.log(`\nFIRST ITEM HTML:\n${dump.firstHtml}`);
  console.log(`\nEXTRACTED (as current code would):\n${JSON.stringify(dump.extracted, null, 1)}`);
  await browser.close();
  console.log('\n######## MARKUP DUMP COMPLETE ########');
})();
