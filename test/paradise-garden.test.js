// Regression tests for the Paradise Garden month-page parser.
//
// fixtures/paradise-garden-pages.json holds the listing block from every
// archived month page (/events/<month><year>), and
// fixtures/paradise-garden-expected.json the reviewed parse of each. The
// layout changes from month to month, so when a new month breaks the
// scraper: add its block to the pages fixture, fix the parser, and check
// that every older month still parses the same.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseParadiseGardenMonth, paradiseGardenMonthSlugs } = require('../scrape.js');

const pages = require('./fixtures/paradise-garden-pages.json');
const expected = require('./fixtures/paradise-garden-expected.json');

for (const [slug, page] of Object.entries(pages)) {
  test(`parses archived month ${slug}`, () => {
    const events = parseParadiseGardenMonth(page.html, page);
    assert.deepEqual(events, expected[slug]);
    assert.ok(events.length >= 10, `only ${events.length} events`);
    for (const ev of events) {
      assert.match(ev.dateStr, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(ev.title.length > 1);
      // Dates stay within the page's month, give or take one either side.
      const [y, m] = ev.dateStr.split('-').map(Number);
      const diff = (y * 12 + m) - (page.year * 12 + page.month);
      assert.ok(diff >= -1 && diff <= 1, `${ev.dateStr} is outside ${slug}`);
    }
  });
}

const wrap = (inner) => `<div class="sqs-html-content">${inner}</div>`;
const NOV_2026 = { year: 2026, month: 11 };

test('ignores the opening-hours box', () => {
  const html = wrap('<h4>hours</h4><p><strong>weds</strong> 17:00 - 23.30 <strong>thur</strong> 17:00 - 23.30</p><p><strong>sun</strong> 16:00 - 22:00</p>');
  assert.deepEqual(parseParadiseGardenMonth(html, NOV_2026), []);
});

test('handles lines split with <br> inside one paragraph', () => {
  const html = wrap('<p>wed 4<br>plug jam w/ skyn,<br>yeti &amp; more<br>dj - techno</p><p></p><p>thu 5<br>bamzu</p>');
  assert.deepEqual(parseParadiseGardenMonth(html, NOV_2026), [
    { dateStr: '2026-11-04', title: 'plug jam w/ skyn, yeti & more', description: 'dj - techno' },
    { dateStr: '2026-11-05', title: 'bamzu', description: '' },
  ]);
});

test('handles long weekday names, ordinals, day-first dates and list items', () => {
  const html = wrap(
    '<ul><li>friday 6th - disco night</li><li>dj - disco</li></ul>' +
    '<p>7 sat</p><p>radio sudd party</p><p></p>' +
    '<p>sunday 8th</p><p>closed</p>'
  );
  assert.deepEqual(parseParadiseGardenMonth(html, NOV_2026), [
    { dateStr: '2026-11-06', title: 'disco night', description: 'dj - disco' },
    { dateStr: '2026-11-07', title: 'radio sudd party', description: '' },
  ]);
});

test('rolls into the next month, by heading or by day numbers wrapping', () => {
  const byHeading = wrap('<h4>thur 31</h4><h3>a</h3><h2>january</h2><h4>fri 1</h4><h3>b</h3>');
  assert.deepEqual(parseParadiseGardenMonth(byHeading, { year: 2026, month: 12 }).map((e) => e.dateStr),
    ['2026-12-31', '2027-01-01']);
  const byWrap = wrap('<p>mon 30</p><p>a</p><p></p><p>tue 1</p><p>b</p>');
  assert.deepEqual(parseParadiseGardenMonth(byWrap, NOV_2026).map((e) => e.dateStr),
    ['2026-11-30', '2026-12-01']);
});

test('finds month pages from the /events index', () => {
  const index = '<a href="/events/october2026">x</a><a href="/events/november2026">x</a>' +
    '<a href="/events/december-2026">x</a><a href="https://www.paradise-garden.co.uk/events/jan2027">x</a>';
  const got = paradiseGardenMonthSlugs(index, new Date(2026, 10, 26));
  assert.deepEqual(got.map((s) => s.path), ['/events/november2026', '/events/december-2026', '/events/jan2027']);
  // With no index, falls back to this month and next.
  assert.deepEqual(paradiseGardenMonthSlugs('', new Date(2026, 11, 2)).map((s) => s.path),
    ['/events/december2026', '/events/january2027']);
});
