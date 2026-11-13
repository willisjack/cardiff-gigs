/* Temporary diagnostic round 5: what does one clwb.net event page actually
   contain? Deliberately gentle — the site answers 429 under load, so this makes
   a handful of requests with pauses and backs off when asked to. */
const UA = 'cardiff-gigs-scraper/1.0 (+https://github.com/J-Hughes-In/cardiff-gigs)';
const H = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-GB,en;q=0.9' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function politeGet(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(url, { headers: H, redirect: 'manual' });
    if (res.status === 429) {
      const wait = 5000 * i;
      console.log(`    429 Too Many Requests; waiting ${wait}ms (try ${i}/${tries})`);
      await sleep(wait);
      continue;
    }
    return res;
  }
  return null;
}

(async () => {
  console.log('######## CLWB EVENT PAGE STRUCTURE (gentle) ########');
  await sleep(3000);

  const smRes = await politeGet('https://clwb.net/tm-events-sitemap.xml');
  if (!smRes) { console.log('sitemap still rate-limited; aborting'); return; }
  const xml = await smRes.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    .filter(u => /\/events\/[^/]+\/$/.test(u));
  console.log(`sitemap status ${smRes.status} | event URLs: ${locs.length}`);

  // Two pages only, well spaced.
  for (const url of locs.slice(0, 2)) {
    await sleep(4000);
    console.log(`\n==== ${url}`);
    const res = await politeGet(url);
    if (!res) { console.log('    gave up (rate limited)'); continue; }
    console.log(`    status ${res.status}`);
    if (res.status >= 300 && res.status < 400) {
      console.log(`    REDIRECTS TO: ${res.headers.get('location')}`);
      continue;
    }
    const html = await res.text();
    console.log(`    bytes ${html.length}`);
    console.log(`    <title> ${((html.match(/<title>([\s\S]*?)<\/title>/)||[])[1]||'').trim().slice(0,120)}`);
    for (const prop of ['og:title','og:image','og:url','og:description']) {
      const v = (html.match(new RegExp(`property=["']${prop}["'][^>]*content=["']([^"']*)`))||[])[1]
             || (html.match(new RegExp(`content=["']([^"']*)["'][^>]*property=["']${prop}["']`))||[])[1] || '';
      console.log(`    ${prop}: ${v.slice(0,120)}`);
    }
    console.log(`    ld+json blocks: ${(html.match(/application\/ld\+json/g)||[]).length}`);
    console.log(`    h1: ${JSON.stringify([...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(m=>m[1].replace(/<[^>]*>/g,'').trim().slice(0,80)).slice(0,4))}`);
    console.log(`    h2: ${JSON.stringify([...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m=>m[1].replace(/<[^>]*>/g,'').trim().slice(0,80)).slice(0,6))}`);
    console.log(`    date-translate present: ${/date-translate/.test(html)}`);
    console.log(`    grid-item present: ${/grid-item/.test(html)}`);
    const tickets = [...new Set([...html.matchAll(/href=["'](https?:\/\/[^"']*(?:seetickets|fatsoma)[^"']*)["']/g)].map(m=>m[1]))];
    console.log(`    ticket links (${tickets.length}): ${JSON.stringify(tickets.slice(0,5))}`);
  }
  console.log('\n######## COMPLETE ########');
})();
