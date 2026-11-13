/* Temporary diagnostic round 2: can the venue's own ticketing platforms supply
   the Clwb listing if clwb.net itself stays closed to the runner?
   Probes See Tickets' Clwb box-office subdomain and Fatsoma's venue page. */
const { chromium } = require('playwright');

const UA = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';

async function pageProbe(label, url, selectors) {
  console.log(`\n=== [${label}] ${url}`);
  let browser;
  try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({
      userAgent: UA, viewport: { width: 1365, height: 900 },
      locale: 'en-GB', timezoneId: 'Europe/London',
    });
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    console.log(`    status ${resp ? resp.status() : 'null'} | final ${page.url()}`);
    await page.waitForLoadState('load').catch(()=>{});
    await new Promise(r => setTimeout(r, 2500));

    const info = await page.evaluate((sels) => {
      const counts = {};
      for (const s of sels) { try { counts[s] = document.querySelectorAll(s).length; } catch { counts[s] = 'bad-sel'; } }
      // Harvest anything that looks like an event link.
      const links = [...document.querySelectorAll('a[href]')]
        .map(a => ({ href: a.href, text: (a.innerText||'').trim().replace(/\s+/g,' ').slice(0,70) }))
        .filter(l => /event|tour|\/e\/|ticket/i.test(l.href) && l.text);
      const seen = new Set(); const uniq = [];
      for (const l of links) { if (!seen.has(l.href)) { seen.add(l.href); uniq.push(l); } }
      return {
        title: document.title,
        counts,
        htmlLen: document.documentElement.outerHTML.length,
        bodyText: (document.body?.innerText||'').slice(0,500).replace(/\s+/g,' '),
        linkCount: uniq.length,
        links: uniq.slice(0, 25),
      };
    }, selectors);

    console.log(`    title: ${info.title} | htmlLen ${info.htmlLen}`);
    console.log(`    counts ${JSON.stringify(info.counts)}`);
    console.log(`    bodyText ${info.bodyText}`);
    console.log(`    event-ish links: ${info.linkCount}`);
    info.links.forEach(l => console.log(`      - ${l.text}  ->  ${l.href}`));
    await browser.close();
  } catch (e) {
    console.log(`    ERROR ${e.message.split('\n')[0]}`);
    if (browser) await browser.close().catch(()=>{});
  }
}

(async () => {
  console.log('######## CLWB ALTERNATE-SOURCE PROBE ########');

  await pageProbe('seetickets-boxoffice', 'https://clwbiforbach.seetickets.com/', [
    '.event', '.event-list-item', 'li.event', '[class*="event"]', 'a[href*="/event/"]', 'a[href*="/tour/"]',
  ]);

  await pageProbe('seetickets-venue-search',
    'https://www.seetickets.com/search?q=clwb%20ifor%20bach', [
    '.event', '[class*="event"]', 'a[href*="/event/"]',
  ]);

  await pageProbe('fatsoma-venue', 'https://www.fatsoma.com/venues/clwb-ifor-bach', [
    '[class*="event"]', 'a[href*="/e/"]',
  ]);

  console.log('\n######## ROUND 2 COMPLETE ########');
})();
