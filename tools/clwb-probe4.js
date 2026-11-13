/* Temporary diagnostic round 6: does enrichment still work on Clwb's ticket
   links? Clwb wants an honest UA; See Tickets may want the opposite, and the
   answer decides whether a sitemap fallback (title + ticket link, no date) can
   recover dates downstream. */
const { chromium } = require('playwright');

const SPOOFED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HONEST  = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';

const TARGETS = [
  ['seetickets-event', 'https://clwbiforbach.seetickets.com/event/rammlied/clwb-ifor-bach/3569415'],
  ['fatsoma-event',    'https://www.fatsoma.com/e/x3px83ec/rush'],
];

async function test(label, url, ua) {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 1365, height: 900 } });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load').catch(()=>{});
    await new Promise(r => setTimeout(r, 1200));
    const info = await page.evaluate(() => {
      let ev = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          (function walk(n, d) {
            if (!n || typeof n !== 'object' || d > 12 || ev) return;
            if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return; }
            if ([].concat(n['@type'] || []).some(t => /Event$/.test(String(t)))) { ev = n; return; }
            for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, d + 1);
          })(JSON.parse(s.textContent), 0);
        } catch {}
      }
      return {
        title: document.title,
        ldEvent: ev ? { name: ev.name, startDate: ev.startDate, offers: ev.offers ? 'yes' : 'no' } : null,
        bodySnippet: (document.body?.innerText || '').slice(0, 140).replace(/\s+/g, ' '),
      };
    });
    console.log(`  [${label}] UA=${ua === SPOOFED ? 'SPOOFED' : 'HONEST'} -> status ${resp ? resp.status() : 'null'} | title "${info.title}"`);
    console.log(`      ld Event: ${JSON.stringify(info.ldEvent)}`);
    console.log(`      body: ${info.bodySnippet}`);
    await browser.close();
  } catch (e) {
    console.log(`  [${label}] UA=${ua === SPOOFED ? 'SPOOFED' : 'HONEST'} -> ERROR ${e.message.split('\n')[0]}`);
    if (browser) await browser.close().catch(()=>{});
  }
}

(async () => {
  console.log('######## TICKET-PLATFORM ENRICHMENT CHECK ########');
  for (const [label, url] of TARGETS) {
    console.log(`\n=== ${url}`);
    await test(label, url, SPOOFED);
    await new Promise(r => setTimeout(r, 2000));
    await test(label, url, HONEST);
  }
  console.log('\n######## COMPLETE ########');
})();
