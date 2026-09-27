// End-to-end check of the deployed site in a phone-sized browser, on the real
// network: map tiles, schedule data, live predictions, walking directions,
// stop departure boards and search. Saves screenshots to the output directory.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node tests/site_check.mjs https://jsherman999.github.io/mnbus/ site-check
//
// Env: EXPECT_APP_JS=path   wait until the deployed js/app.js matches this file
//      PRINT_SCREENSHOTS=1  also print small JPEG screenshots as base64 (for log-only review)
import { chromium, devices } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [base = 'https://jsherman999.github.io/mnbus/', outDir = 'site-check'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const summary = { base, checks: {}, problems: [] };
const problem = (msg) => { summary.problems.push(msg); console.log(`PROBLEM: ${msg}`); };

// Wait for GitHub Pages to serve the build we expect.
if (process.env.EXPECT_APP_JS) {
  const want = readFileSync(process.env.EXPECT_APP_JS, 'utf8');
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const got = await fetch(`${base}js/app.js?cb=${Date.now()}`).then((r) => r.text()).catch(() => '');
    if (got === want) break;
    if (Date.now() > deadline) { problem('deployed js/app.js never matched this commit'); break; }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 });
const page = await ctx.newPage();
const tiles = new Map();
const failures = [];
page.on('response', (res) => {
  const u = new URL(res.url());
  if (/tile\.openstreetmap\.org|arcgisonline\.com/.test(u.host)) {
    const k = `${u.host} ${res.status()}`;
    tiles.set(k, (tiles.get(k) || 0) + 1);
  }
  if (res.status() >= 400) failures.push(`${res.status()} ${res.url().slice(0, 120)}`);
});
page.on('requestfailed', (req) => failures.push(`failed ${req.url().slice(0, 120)} ${req.failure()?.errorText}`));
page.on('pageerror', (e) => problem(`page error: ${e.message}`));

let shotNo = 0;
async function shot(name) {
  const file = join(outDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  if (process.env.PRINT_SCREENSHOTS) {
    const jpg = await page.screenshot({ type: 'jpeg', quality: 40, scale: 'css' });
    console.log(`SCREENSHOT ${name} ${jpg.toString('base64')}`);
  }
}
const setStyle = (style) => ctx.addInitScript((s) => {
  try { localStorage.setItem('mnbus.settings', JSON.stringify({ mapStyle: s })); } catch { /* ignore */ }
}, style);
const waitTiles = () => page.waitForTimeout(3500);

// 1. Leave-now trip from Comstock Hall to Target Field
await setStyle('osm');
await page.goto(`${base}#from=44.97237,-93.23685,Comstock%20Hall&to=44.98170,-93.27760,Target%20Field`);
await page.waitForSelector('#boot', { state: 'hidden', timeout: 30000 });
await page.waitForSelector('.card.itin, .empty', { timeout: 30000 });
await waitTiles();
const status = await page.textContent('.status-line').catch(() => '');
summary.checks.statusLine = status.trim();
summary.checks.options = await page.locator('.card.itin').count();
if (!summary.checks.options) problem('no trip options for Comstock Hall -> Target Field');
if (!/live times/.test(status)) problem(`live predictions not used: "${status.trim()}"`);
await shot('results');

// 2. Step-by-step details + walking directions
if (summary.checks.options) {
  await page.click('.card.itin');
  await page.waitForSelector('.details');
  await page.waitForTimeout(2500);
  await shot('details');
  summary.checks.boardLine = (await page.textContent('.board-line').catch(() => '')).replace(/\s+/g, ' ').trim();
  summary.checks.liveLine = (await page.textContent('.rt').catch(() => '')).replace(/\s+/g, ' ').trim();
  const link = page.locator('.walk-dir').first();
  if (await link.count()) {
    await link.click();
    await page.waitForSelector('.wsteps li, .walk-steps .muted:not(:has(.inline-spin))', { timeout: 15000 }).catch(() => {});
    summary.checks.walkingSteps = (await page.locator('.wsteps li').allTextContents()).slice(0, 4);
    if (!summary.checks.walkingSteps.length) problem('walking directions did not load');
  }
  await page.click('.details .back');
}

// 3. Campus close-up on each base map (street names, dorm labels)
for (const style of ['osm', 'esri', 'satellite']) {
  await setStyle(style);
  await page.goto(`${base}?style=${style}`);
  await page.waitForSelector('#boot', { state: 'hidden', timeout: 30000 });
  await page.evaluate(() => window.gopher.map.setView([44.9745, -93.2340], 17, { animate: false }));
  await waitTiles();
  summary.checks[`placeLabels_${style}`] = await page.locator('.place-label').count();
  await shot(`campus-${style}`);
}
const tileSummary = Object.fromEntries(tiles);
summary.checks.tiles = tileSummary;
const okTiles = [...tiles].filter(([k]) => / 200$/.test(k)).reduce((a, [, n]) => a + n, 0);
const badTiles = [...tiles].filter(([k]) => !/ 200$/.test(k)).reduce((a, [, n]) => a + n, 0);
if (okTiles < 10 || badTiles > okTiles * 0.2) problem(`map tiles failing: ${JSON.stringify(tileSummary)}`);

// 4. Stop departure board (East Bank Station)
await page.evaluate(() => window.gopher.openStop(window.gopher.state.net.stopIndex.get('56042')));
await page.waitForSelector('.deplist li, .deps .muted:not(:first-child)', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
summary.checks.stopBoard = (await page.textContent('.deps').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
if (!/Live from Metro Transit/.test(summary.checks.stopBoard)) problem('stop board is not using live NexTrip data');
await shot('stop-board');

// 5. Search: campus place and a street address (Nominatim)
await page.goto(base);
await page.waitForSelector('#boot', { state: 'hidden', timeout: 30000 });
await page.click('#to-input');
await page.fill('#to-input', 'comstock');
summary.checks.searchComstock = (await page.locator('.sug .sname').allTextContents()).slice(0, 3);
await page.fill('#to-input', '1313 5th St SE');
await page.click('.sug.action');
await page.waitForSelector('#suggest h3', { timeout: 15000 }).catch(() => {});
summary.checks.searchAddress = (await page.locator('.sug .sname').allTextContents()).slice(0, 3);
await shot('search');

summary.checks.networkFailures = [...new Set(failures)].slice(0, 15);
await browser.close();
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.problems.length) process.exit(1);
