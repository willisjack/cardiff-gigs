/* Temporary: exercise the sitemap fallback directly, since the listing now
   works and would otherwise never reach it. */
const { chromium } = require('playwright');
process.env.SCRAPE_NO_ENRICH = '1';

(async () => {
  const src = require('fs').readFileSync('scrape.js', 'utf8');
  // scrape.js has no exports; evaluate it and grab the fallback off the module scope.
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const axios = require('axios');

  const CLWB_UA = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';
  const res = await axios.get('https://clwb.net/tm-events-sitemap.xml', {
    headers: { 'User-Agent': CLWB_UA, Accept: 'application/xml,text/xml,*/*' }, timeout: 20_000,
  });
  const urls = [...String(res.data).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1].trim()).filter(u => /\/events\/[^/]+\/?$/.test(u));
  console.log(`sitemap event pages: ${urls.length}`);

  const ctx = await browser.newContext({ userAgent: CLWB_UA, viewport: { width: 1365, height: 900 } });
  const page = await ctx.newPage();
  for (const url of urls.slice(0, 4)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const ev = await page.evaluate(() => {
      const meta = p => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content?.trim() || '';
      let ld = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          (function walk(n, d) {
            if (!n || typeof n !== 'object' || d > 10 || ld) return;
            if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return; }
            if ([].concat(n['@type'] || []).some(t => /Event$/.test(String(t)))) { ld = n; return; }
            for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, d + 1);
          })(JSON.parse(s.textContent), 0);
        } catch {}
      }
      return {
        ldFound: !!ld,
        title: (ld && ld.name) || document.querySelector('h1')?.innerText?.trim() || meta('og:title') || '',
        date: document.querySelector('p.date-translate, .date-translate, .event-date')?.innerText?.trim()
              || document.querySelector('time[datetime]')?.innerText?.trim() || '',
        startDate: (ld && ld.startDate) || '',
        details: [...document.querySelectorAll('p.grid-item-support:not(.date-translate), .event-support')]
                  .map(p => p.innerText.trim()).filter(Boolean).join(' • '),
        ticketUrl: document.querySelector('a.tickets-button, a[href*="seetickets"], a[href*="fatsoma"]')?.href || '',
        imageUrl: meta('og:image'),
      };
    });
    console.log(`\n${url}\n  ${JSON.stringify(ev, null, 2)}`);
  }
  await browser.close();
})();
