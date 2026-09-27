// Planner tests.
//   node tests/test_planner.mjs fixture <data-dir>   assertions against tests/make_fixture.py data
//   node tests/test_planner.mjs smoke <data-dir>     sample UMN trips against the real Metro Transit build
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Network } from '../js/network.js';
import { Planner } from '../js/planner.js';
import { formatClock, formatDuration, formatDistance, nowChicago, addDays, weekday } from '../js/util.js';

const [mode = 'fixture', dir] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node tests/test_planner.mjs fixture|smoke <data-dir>');
  process.exit(2);
}
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const t0 = Date.now();
const net = new Network(load('network.json'), load('timetable.json'), load('shapes.json'));
console.log(`loaded ${net.nStops} stops, ${net.patterns.length} patterns, ${net.routes.length} routes in ${Date.now() - t0} ms`);
const planner = new Planner(net);

const hm = (h, m = 0) => h * 3600 + m * 60;

function describe(it) {
  const lines = [`  ${formatClock(it.date, it.depart)} -> ${formatClock(it.date, it.arrive)} (${formatDuration(it.duration)}, ` +
    `${it.rides} vehicle${it.rides > 1 ? 's' : ''}, walk ${formatDistance(it.walkMeters)}) ${it.tags?.join(', ') || ''}`];
  for (const l of it.legs) {
    if (l.type === 'walk') {
      lines.push(`     walk ${formatDuration(l.end - l.start)} ${l.from.name} -> ${l.to.name}`);
    } else {
      lines.push(`     ${formatClock(it.date, l.start)} ride ${l.routeLabel} toward ${l.headsign}: ${l.from.name} -> ${l.to.name} ` +
        `(${formatClock(it.date, l.end)}, ${l.alight - l.board} stops, trip ${l.tripId})`);
    }
  }
  return lines.join('\n');
}

function run(name, q, opts) {
  const t = Date.now();
  const res = planner.plan(q, opts);
  const ms = Date.now() - t;
  console.log(`\n${name} [${q.mode} ${formatClock(q.date, q.secs)} ${q.date}] ${res.itineraries.length} options in ${ms} ms ` +
    `(access ${res.access}, egress ${res.egress}, walk-only ${formatDuration(res.walkOnly.secs)})`);
  for (const it of res.itineraries) console.log(describe(it));
  return { res, ms };
}

/** Timing consistency every itinerary must satisfy. */
function checkItinerary(it, q) {
  let clock = it.depart;
  for (const l of it.legs) {
    assert.ok(l.start >= clock - 1, `leg starts before previous ends (${l.type})`);
    assert.ok(l.end >= l.start, 'leg ends before it starts');
    clock = l.end;
  }
  assert.equal(clock, it.arrive);
  if (q.mode === 'arrive') assert.ok(it.arrive <= q.secs, 'arrive-by option arrives late');
  else assert.ok(it.depart >= q.secs - 1, 'option leaves before the requested time');
  for (let i = 1; i < it.legs.length; i++) {
    const a = it.legs[i - 1], b = it.legs[i];
    if (a.type === 'ride' && b.type === 'ride') assert.ok(b.start - a.end >= 120, 'transfer shorter than slack');
  }
}

const coffman = { lat: 44.9728, lon: -93.2353, name: 'Coffman Union' };
const nicollet = { lat: 44.9786, lon: -93.2735, name: 'Nicollet Mall' };
const dinkytown = { lat: 44.9806, lon: -93.2357, name: 'Dinkytown' };
const stPaul = { lat: 44.9848, lon: -93.1858, name: 'St Paul Student Center' };
const downtownMarquette = { lat: 44.9762, lon: -93.2702, name: 'Marquette & 7th' };

if (mode === 'fixture') {
  const monday = '20260928';
  {
    const q = { from: coffman, to: nicollet, date: monday, secs: hm(8), mode: 'depart' };
    const { res } = run('coffman -> nicollet', q);
    assert.ok(res.itineraries.length >= 2, 'expected several departures');
    for (const it of res.itineraries) checkItinerary(it, q);
    const first = res.itineraries[0];
    assert.equal(first.legs[1].routeLabel, 'Green');
    assert.ok(first.depart >= hm(8) && first.arrive <= hm(8, 30), 'first option should arrive by 8:30');
    // departures increase
    for (let i = 1; i < res.itineraries.length; i++) assert.ok(res.itineraries[i].depart >= res.itineraries[i - 1].depart);
  }
  {
    const q = { from: coffman, to: nicollet, date: monday, secs: hm(9), mode: 'arrive' };
    const { res } = run('coffman -> nicollet arrive by 9', q);
    assert.ok(res.itineraries.length >= 2);
    for (const it of res.itineraries) checkItinerary(it, q);
    assert.ok(res.itineraries[0].arrive > hm(8, 45), 'latest option should arrive close to 9:00');
  }
  {
    const q = { from: dinkytown, to: stPaul, date: monday, secs: hm(12), mode: 'depart' };
    const { res } = run('dinkytown -> st paul', q);
    assert.ok(res.itineraries.length >= 1);
    for (const it of res.itineraries) checkItinerary(it, q);
    assert.ok(res.itineraries.some((it) => it.legs.some((l) => l.routeLabel === '121')), 'campus connector expected');
  }
  {
    // Route 3 runs past midnight (24:10, 24:30) on weekday service.
    const q = { from: dinkytown, to: downtownMarquette, date: monday, secs: hm(23, 58), mode: 'depart' };
    const { res } = run('dinkytown -> downtown after midnight', q);
    assert.ok(res.itineraries.length >= 1, 'late-night trip expected');
    for (const it of res.itineraries) checkItinerary(it, q);
    assert.ok(res.itineraries[0].legs[1].start >= hm(24), 'should use the 24:xx trip');
    // Same trip seen from the next service day (00:05 Tuesday) via the previous day's service
    const q2 = { from: dinkytown, to: downtownMarquette, date: '20260929', secs: hm(0, 5), mode: 'depart' };
    const { res: r2 } = run('same, queried as tuesday 00:05', q2);
    assert.ok(r2.itineraries.length >= 1 && r2.itineraries[0].legs[1].start < hm(1));
  }
  {
    // Thanksgiving: weekday service removed, Saturday service added (no 121/route 3)
    const q = { from: dinkytown, to: stPaul, date: '20261126', secs: hm(12), mode: 'depart' };
    const { res } = run('thanksgiving', q);
    const sameDay = res.itineraries.filter((it) => it.depart < 86400);
    assert.ok(!sameDay.some((it) => it.legs.some((l) => l.routeLabel === '121')), 'no 121 on holiday');
    assert.ok(res.itineraries.every((it) => it.depart >= 86400), 'only next-morning service remains');
  }
  {
    // Excluding the Green Line forces a bus-only answer (or none)
    const q = { from: coffman, to: nicollet, date: monday, secs: hm(8), mode: 'depart' };
    const { res } = run('without green line', q, { excludeRoutes: new Set([0]) });
    assert.ok(!res.itineraries.some((it) => it.legs.some((l) => l.routeLabel === 'Green')));
  }
  console.log('\nfixture tests passed');
} else {
  // Smoke tests on the real feed: next weekday at 8:00 AM and a Saturday evening.
  let date = nowChicago().date;
  while (weekday(date) > 4 || !net.hasService(date)) date = addDays(date, 1);
  let sat = date;
  while (weekday(sat) !== 5) sat = addDays(sat, 1);
  const places = {
    'Coffman Union': coffman,
    'Target Field': { lat: 44.9817, lon: -93.2776, name: 'Target Field' },
    'St Paul Student Center': stPaul,
    'Pioneer Hall area': { lat: 44.9706, lon: -93.2305, name: 'Pioneer Hall area' },
    'MSP Airport Terminal 1': { lat: 44.8808, lon: -93.2050, name: 'MSP Terminal 1' },
    'Mall of America': { lat: 44.8549, lon: -93.2422, name: 'Mall of America' },
    'Dinkytown': dinkytown,
    'Union Depot St Paul': { lat: 44.9480, lon: -93.0860, name: 'Union Depot' },
  };
  const pairs = [
    ['Coffman Union', 'Target Field'], ['Dinkytown', 'St Paul Student Center'],
    ['Pioneer Hall area', 'MSP Airport Terminal 1'], ['St Paul Student Center', 'Mall of America'],
    ['Coffman Union', 'Union Depot St Paul'],
  ];
  let worst = 0, failures = 0;
  for (const [a, b] of pairs) {
    for (const [d, secs, m] of [[date, hm(8), 'depart'], [date, hm(17, 30), 'arrive'], [sat, hm(21), 'depart']]) {
      const q = { from: places[a], to: places[b], date: d, secs, mode: m };
      const { res, ms } = run(`${a} -> ${b}`, q);
      worst = Math.max(worst, ms);
      if (!res.itineraries.length) { failures++; console.log('  !! no itinerary'); }
      for (const it of res.itineraries) checkItinerary(it, q);
    }
  }
  console.log(`\nsmoke: slowest plan ${worst} ms, ${failures} queries without results`);
  if (failures > 2) process.exit(1);
}
