// Real-time tests.
//   node tests/test_realtime.mjs                  decode a hand-built GTFS-rt message
//   node tests/test_realtime.mjs live <data-dir>  fetch Metro Transit's live feeds and apply them
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFeed, applyTripUpdates, indexAlerts, URLS, getNexTrip } from '../js/realtime.js';
import { Network } from '../js/network.js';
import { Planner } from '../js/planner.js';
import { nowChicago, formatClock } from '../js/util.js';

// ---- minimal protobuf writer (test only)
const varint = (n) => {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const key = (f, w) => varint(f * 8 + w);
const str = (f, s) => { const b = [...new TextEncoder().encode(s)]; return [...key(f, 2), ...varint(b.length), ...b]; };
const msg = (f, bytes) => [...key(f, 2), ...varint(bytes.length), ...bytes];
const num = (f, n) => [...key(f, 0), ...varint(n)];
const f32 = (f, x) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, x, true); return [...key(f, 5), ...b]; };

const [mode, dir] = process.argv.slice(2);

{
  const trip = [...str(1, '1166966'), ...str(3, '20260926'), ...str(5, '902'), ...num(6, 0)];
  const stu1 = [...num(1, 3), ...msg(2, [...num(1, -90)]), ...str(4, '56001')];
  const stu2 = [...num(1, 4), ...msg(3, [...num(2, 1790480400)]), ...str(4, '56002')];
  const tu = [...msg(1, trip), ...msg(2, stu1), ...msg(2, stu2), ...num(4, 1790479333)];
  const veh = [...msg(1, trip), ...msg(2, [...f32(1, 44.97), ...f32(2, -93.23), ...f32(3, 90)]), ...num(5, 1790479341),
    ...msg(8, [...str(1, '1647'), ...str(2, '1647')])];
  const al = [...msg(1, [...num(1, 1790000000), ...num(2, 1800000000)]), ...msg(5, [...str(2, '902')]),
    ...msg(10, [...msg(1, [...str(1, 'Buses replace trains'), ...str(2, 'en')])])];
  const feed = [
    ...msg(1, [...str(1, '2.0'), ...num(3, 1790479333)]),
    ...msg(2, [...str(1, 'e1'), ...msg(3, tu)]),
    ...msg(2, [...str(1, 'e2'), ...msg(4, veh)]),
    ...msg(2, [...str(1, 'e3'), ...msg(5, al)]),
  ];
  const d = decodeFeed(new Uint8Array(feed).buffer);
  assert.equal(d.timestamp, 1790479333);
  assert.equal(d.tripUpdates.length, 1);
  assert.equal(d.tripUpdates[0].trip.tripId, '1166966');
  assert.equal(d.tripUpdates[0].trip.routeId, '902');
  assert.equal(d.tripUpdates[0].updates[0].arr.delay, -90, 'negative delays decode');
  assert.equal(d.tripUpdates[0].updates[1].dep.time, 1790480400);
  assert.equal(d.vehicles[0].label, '1647');
  assert.ok(Math.abs(d.vehicles[0].lat - 44.97) < 1e-4 && Math.abs(d.vehicles[0].lon + 93.23) < 1e-4);
  assert.equal(d.alerts[0].header, 'Buses replace trains');
  assert.ok(d.alerts[0].routes.has('902'));
  assert.equal(indexAlerts(d, 1790479333).byRoute.get('902').length, 1);
  console.log('protobuf decode test passed');
}

if (mode === 'live') {
  const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const net = new Network(load('network.json'), load('timetable.json'), null);
  const now = nowChicago();
  const ct = net.compile(now.date);
  for (const kind of ['tripUpdates', 'vehicles', 'alerts']) {
    const res = await fetch(URLS[kind]);
    const buf = await res.arrayBuffer();
    const feed = decodeFeed(buf);
    console.log(`${kind}: ${buf.byteLength} bytes, ${feed.tripUpdates.length} trip updates, ${feed.vehicles.length} vehicles, ` +
      `${feed.alerts.length} alerts, feed time ${new Date(feed.timestamp * 1000).toISOString()}`);
    if (kind === 'tripUpdates') {
      const rt = applyTripUpdates(net, ct, feed);
      console.log(`  matched to timetable: ${rt.rtStats.applied} trips updated, ${rt.rtStats.cancelled} cancelled ` +
        `(of ${feed.tripUpdates.length})`);
      // show a few predictions vs schedule
      let shown = 0;
      for (const cp of rt.patterns) {
        if (!cp.rt || shown >= 5) continue;
        const j = cp.rt.indexOf(1);
        if (j < 0) continue;
        const i = Math.floor(cp.n / 2);
        const s = cp.base.dep[j * cp.n + i], p = cp.dep[j * cp.n + i];
        console.log(`  trip ${cp.ids[j]} at ${net.stopName[cp.stops[i]]}: scheduled ${formatClock(now.date, s)}, predicted ${formatClock(now.date, p)}`);
        shown++;
      }
      if (feed.tripUpdates.length > 50) assert.ok(rt.rtStats.applied > feed.tripUpdates.length * 0.3, 'most live trips should match the static feed');
      // plan a "leave now" trip on the live timetable
      const planner = new Planner(net);
      const res = planner.plan({
        from: { lat: 44.9728, lon: -93.2353, name: 'Coffman Union' }, to: { lat: 44.9817, lon: -93.2776, name: 'Target Field' },
        date: now.date, secs: now.secs, mode: 'depart', timetable: rt,
      });
      console.log(`  live plan Coffman -> Target Field: ${res.itineraries.length} options; first ` +
        (res.itineraries[0] ? `${formatClock(now.date, res.itineraries[0].depart)} -> ${formatClock(now.date, res.itineraries[0].arrive)} ` +
          `via ${res.itineraries[0].legs.filter((l) => l.type === 'ride').map((l) => `${l.routeLabel}${l.realtime ? ' (live)' : ''}`).join(', ')}` : 'none'));
    }
    if (kind === 'vehicles' && feed.vehicles.length) {
      const v = feed.vehicles[0];
      console.log(`  sample vehicle ${v.label} route ${v.trip?.routeId} at ${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}`);
      assert.ok(v.lat > 44 && v.lat < 46 && v.lon < -92 && v.lon > -95, 'vehicle coordinates in the Twin Cities');
    }
    if (kind === 'alerts' && feed.alerts.length) console.log(`  sample alert: ${feed.alerts[0].header.slice(0, 120)}`);
  }
  const nt = await getNexTrip('56043');
  console.log(`NexTrip 56043 (${nt.stops?.[0]?.description}): ${nt.departures?.length} departures; first: ` +
    JSON.stringify(nt.departures?.[0] || null));
}
