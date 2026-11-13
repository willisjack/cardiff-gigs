/* Temporary diagnostic round 3: the listing loaded fine under an honest
   User-Agent, so compare User-Agent strings head-to-head and check whether a
   run of sequential requests gets throttled. */
const { chromium } = require('playwright');

const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HONEST_UA  = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';

async function listingTest(label, userAgent) {
  console.log(`\n=== [${label}] UA=${userAgent === undefined ? '(playwright default)' : userAgent}`);
  let browser;
  try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ userAgent, viewport: { width: 1365, height: 900 } });
    const page = await ctx.newPage();
    const resp = await page.goto('https://clwb.net/whats-on/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const appeared = await page.waitForSelector('#eventsListings li.grid-item', { state: 'attached', timeout: 20_000 })
      .then(() => true).catch(() => false);
    const n = await page.evaluate(() => document.querySelectorAll('#eventsListings li.grid-item').length);
    const title = await page.title();
    console.log(`    status ${resp ? resp.status() : 'null'} | appeared ${appeared} | grid-items ${n} | title "${title}"`);
    await browser.close();
    return n;
  } catch (e) {
    console.log(`    ERROR ${e.message.split('\n')[0]}`);
    if (browser) await browser.close().catch(()=>{});
    return -1;
  }
}

async function burst(ua) {
  console.log(`\n=== [sequential requests] UA=${ua.slice(0, 40)}...`);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch('https://clwb.net/whats-on/', { headers: { 'User-Agent': ua } });
      codes.push(r.status);
      await r.arrayBuffer();
    } catch (e) { codes.push('ERR:' + e.message.slice(0, 30)); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`    statuses: ${JSON.stringify(codes)}`);
}

(async () => {
  console.log('######## CLWB UA COMPARISON ########');
  const a = await listingTest('scraper-UA (current code)', SCRAPER_UA);
  const b = await listingTest('honest-UA', HONEST_UA);
  const c = await listingTest('playwright-default-UA', undefined);
  console.log(`\nSUMMARY grid-item counts -> scraperUA=${a} honestUA=${b} defaultUA=${c}`);

  await burst(SCRAPER_UA);
  await burst(HONEST_UA);
  console.log('\n######## ROUND 3 COMPLETE ########');
})();
