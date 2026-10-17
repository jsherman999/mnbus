// Trip planning on top of RAPTOR: builds access/egress walks, runs forward and
// backward searches, collects several departure options and turns raw legs into
// step-by-step itineraries.

import { raptor } from './raptor.js';
import { reverseTimetable, WALK_DETOUR } from './network.js';
import { haversine, addDays } from './util.js';

export const DEFAULTS = {
  walkSpeed: 1.25,       // m/s (about 2.8 mph)
  maxWalk: 805,          // straight-line metres from start/end to a stop (0.5 mi)
  transferSlack: 120,    // seconds needed to change vehicles
  startSlack: 60,        // be at the first stop this early
  maxRounds: 5,          // vehicles per trip
  results: 5,
  iterations: 4,         // how many "next departure" searches to run
};

export class Planner {
  constructor(net) {
    this.net = net;
  }

  /**
   * @param q {from:{lat,lon,name}, to:{lat,lon,name}, date:'YYYYMMDD', secs, mode:'depart'|'arrive',
   *           timetable?: compiled timetable override (real-time), walkDistances?: {from:Map, to:Map, direct}}
   */
  plan(q, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const net = this.net;
    const ct = q.timetable || net.compile(q.date);
    const rev = reverseTimetable(ct);
    const footpaths = net.getFootpaths();
    const walkSecs = (m) => Math.round(m / o.walkSpeed);

    const access = this.endpointStops(q.from, o, q.walkDistances?.from);
    const egress = this.endpointStops(q.to, o, q.walkDistances?.to);
    const accessSecs = new Map(access.map((a) => [a.stop, walkSecs(a.meters)]));
    const egressSecs = new Map(egress.map((e) => [e.stop, walkSecs(e.meters)]));
    const ctx = { net, ct, o, q, access, egress, accessSecs, egressSecs, walkSecs };

    const directMeters = q.walkDistances?.direct ??
      haversine(q.from.lat, q.from.lon, q.to.lat, q.to.lon) * WALK_DETOUR;
    const walkOnly = { meters: directMeters, secs: walkSecs(directMeters) };

    const base = {
      maxRounds: o.maxRounds, transferSlack: o.transferSlack, footpaths, walkSecs,
      excludeRoutes: o.excludeRoutes,
    };
    const fwdOpts = { ...base, startSlack: o.startSlack, endSlack: 0 };
    const revOpts = { ...base, startSlack: 0, endSlack: o.startSlack };

    const candidates = [];
    const seen = new Set();
    const add = (legs) => {
      const it = buildItinerary(ctx, legs);
      if (!it || seen.has(it.signature)) return null;
      seen.add(it.signature);
      candidates.push(it);
      return it;
    };

    if (q.mode === 'arrive') {
      let T = q.secs;
      for (let iter = 0; iter < o.iterations; iter++) {
        const res = raptor(net, rev,
          egress.map((e) => ({ stop: e.stop, time: -(T - egressSecs.get(e.stop)) })),
          accessSecs, revOpts);
        if (!res.journeys.length) break;
        const found = [];
        for (const j of res.journeys) {
          const leave = -j.arrival;
          // tighten: earliest arrival when leaving at that time
          const fw = raptor(net, ct, access.map((a) => ({ stop: a.stop, time: leave + accessSecs.get(a.stop) })),
            egressSecs, { ...fwdOpts, maxRounds: j.rides });
          const bestFw = fw.journeys[fw.journeys.length - 1];
          const legs = bestFw && bestFw.arrival <= T ? bestFw.legs : j.legs;
          const it = add(legs);
          if (it) found.push(it);
        }
        if (!found.length) break;
        T = Math.max(...found.map((it) => it.arrive)) - 60;
        if (T < q.secs - 4 * 3600) break;
      }
      candidates.sort((a, b) => b.depart - a.depart || a.arrive - b.arrive);
    } else {
      let t = q.secs;
      for (let iter = 0; iter < o.iterations; iter++) {
        const res = raptor(net, ct, access.map((a) => ({ stop: a.stop, time: t + accessSecs.get(a.stop) })),
          egressSecs, fwdOpts);
        if (!res.journeys.length) break;
        const found = [];
        for (const j of res.journeys) {
          // tighten: leave as late as possible and still arrive by j.arrival
          const bw = raptor(net, rev, egress.map((e) => ({ stop: e.stop, time: -(j.arrival - egressSecs.get(e.stop)) })),
            accessSecs, { ...revOpts, maxRounds: j.rides });
          const bestBw = bw.journeys[bw.journeys.length - 1];
          const legs = bestBw && -bestBw.arrival >= t ? bestBw.legs : j.legs;
          const it = add(legs);
          if (it) found.push(it);
        }
        if (!found.length) break;
        t = Math.min(...found.map((it) => it.depart)) + 60;
        if (t > q.secs + 6 * 3600) break;
      }
      candidates.sort((a, b) => a.arrive - b.arrive || b.depart - a.depart);
    }

    const itineraries = pareto(candidates)
      .sort(q.mode === 'arrive'
        ? (a, b) => b.depart - a.depart || a.arrive - b.arrive
        : (a, b) => a.depart - b.depart || a.arrive - b.arrive)
      .slice(0, o.results);
    labelItineraries(itineraries);
    return { itineraries, walkOnly, access: access.length, egress: egress.length };
  }

  /** Stops reachable on foot from a point: [{stop, meters}] (walking metres). */
  endpointStops(pt, o, known) {
    const net = this.net;
    let near = net.stopsNear(pt.lat, pt.lon, o.maxWalk);
    if (near.length < 3) near = net.nearestStops(pt.lat, pt.lon, 3, 3000);
    return near.map(({ stop, dist }) => ({
      stop,
      meters: known && known.has(stop) ? known.get(stop) : dist * WALK_DETOUR,
    })).filter((x) => Number.isFinite(x.meters));
  }
}

/** Keep options that are not beaten on all of: leave time, arrival, vehicles, walking. */
function pareto(list) {
  return list.filter((a) => !list.some((b) => b !== a &&
    b.depart >= a.depart && b.arrive <= a.arrive && b.rides <= a.rides &&
    b.walkMeters <= a.walkMeters + 150 &&
    (b.depart > a.depart || b.arrive < a.arrive || b.rides < a.rides)));
}

function labelItineraries(list) {
  if (!list.length) return;
  const minDur = Math.min(...list.map((i) => i.arrive - i.depart));
  const minRides = Math.min(...list.map((i) => i.rides));
  const minWalk = Math.min(...list.map((i) => i.walkMeters));
  for (const it of list) {
    it.tags = [];
    if (it.arrive - it.depart === minDur && list.some((x) => x.arrive - x.depart >= minDur + 120)) it.tags.push('Fastest');
    if (it.rides === minRides && list.some((x) => x.rides > minRides)) it.tags.push('Fewest transfers');
    if (it.walkMeters === minWalk && list.some((x) => x.walkMeters > minWalk + 200)) it.tags.push('Least walking');
  }
}

function stopPoint(net, s) {
  return { kind: 'stop', stop: s, lat: net.stopLat[s], lon: net.stopLon[s], name: net.stopName[s] };
}

/** Convert raw RAPTOR legs into a timed itinerary using the (possibly real-time) timetable. */
export function buildItinerary(ctx, rawLegs) {
  const { net, ct, o, q, accessSecs, egressSecs, walkSecs } = ctx;
  const rides = rawLegs.filter((l) => l.type === 'ride');
  if (!rides.length) return null;

  // Drop stop-to-stop walks at either end: walking straight to/from the endpoint is never longer.
  const legsIn = rawLegs.slice();
  let egressStop = rawLegs.egressStop;
  while (legsIn.length && legsIn[legsIn.length - 1].type === 'walk') egressStop = legsIn.pop().from;
  while (legsIn.length && legsIn[0].type === 'walk') legsIn.shift();
  // Collapse walk chains (stop -> stop -> stop) into one walk.
  for (let i = legsIn.length - 1; i > 0; i--) {
    if (legsIn[i].type === 'walk' && legsIn[i - 1].type === 'walk') {
      legsIn.splice(i - 1, 2, { type: 'walk', from: legsIn[i - 1].from, to: legsIn[i].to });
    }
  }

  const legs = [];
  const firstRide = legsIn[0];
  const fp = ct.patterns[firstRide.pattern];
  const firstDep = fp.dep[firstRide.trip * fp.n + firstRide.board];
  const accessStop = net.patterns[firstRide.pattern].stops[firstRide.board];
  const accessMeters = metersFor(ctx, 'from', accessStop);
  const accessT = accessSecs.get(accessStop) ?? walkSecs(accessMeters);
  const depart = firstDep - o.startSlack - accessT;
  legs.push({
    type: 'walk', from: { kind: 'origin', lat: q.from.lat, lon: q.from.lon, name: q.from.name || 'Start' },
    to: stopPoint(net, accessStop), start: depart, end: depart + accessT, meters: accessMeters,
  });

  let clock = depart + accessT;
  let walkMeters = accessMeters;
  let wait = 0;
  const sig = [];
  for (const l of legsIn) {
    if (l.type === 'walk') {
      const m = haversine(net.stopLat[l.from], net.stopLon[l.from], net.stopLat[l.to], net.stopLon[l.to]) * WALK_DETOUR;
      const d = walkSecs(m);
      legs.push({ type: 'walk', from: stopPoint(net, l.from), to: stopPoint(net, l.to), start: clock, end: clock + d, meters: m });
      clock += d;
      walkMeters += m;
      continue;
    }
    const cp = ct.patterns[l.pattern];
    const pat = net.patterns[l.pattern];
    const route = net.routes[pat.route];
    const n = cp.n;
    const row = l.trip * n;
    const dep = cp.dep[row + l.board], arr = cp.arr[row + l.alight];
    const sched = cp.base || cp;
    const rt = cp.rt ? cp.rt[l.trip] : 0;
    wait += Math.max(0, dep - clock);
    const stopsList = [];
    for (let i = l.board; i <= l.alight; i++) {
      stopsList.push({ stop: pat.stops[i], time: i === l.board ? dep : cp.arr[row + i] });
    }
    legs.push({
      type: 'ride', route: pat.route, routeLabel: route.label, pattern: l.pattern, trip: l.trip,
      tripId: cp.ids[l.trip], serviceDate: tripServiceDate(ct, cp, l.trip),
      headsign: pat.towards, dirText: pat.dirText,
      from: stopPoint(net, pat.stops[l.board]), to: stopPoint(net, pat.stops[l.alight]),
      board: l.board, alight: l.alight, start: dep, end: arr,
      schedStart: sched.dep[row + l.board], schedEnd: sched.arr[row + l.alight],
      realtime: !!rt, stops: stopsList,
    });
    sig.push(`${cp.ids[l.trip]}:${l.board}:${l.alight}`);
    clock = arr;
  }

  const egressMeters = metersFor(ctx, 'to', egressStop);
  const egressT = egressSecs.get(egressStop) ?? walkSecs(egressMeters);
  legs.push({
    type: 'walk', from: stopPoint(net, egressStop),
    to: { kind: 'destination', lat: q.to.lat, lon: q.to.lon, name: q.to.name || 'Destination' },
    start: clock, end: clock + egressT, meters: egressMeters,
  });
  walkMeters += egressMeters;
  const arrive = clock + egressT;

  return {
    date: q.date, depart, arrive, duration: arrive - depart,
    rides: rides.length, transfers: rides.length - 1, walkMeters, wait,
    legs, signature: sig.join('>'), realtime: legs.some((x) => x.realtime),
  };
}

function metersFor(ctx, side, stop) {
  const list = side === 'from' ? ctx.access : ctx.egress;
  const hit = list.find((x) => x.stop === stop);
  if (hit) return hit.meters;
  const pt = side === 'from' ? ctx.q.from : ctx.q.to;
  return haversine(pt.lat, pt.lon, ctx.net.stopLat[stop], ctx.net.stopLon[stop]) * WALK_DETOUR;
}

function tripServiceDate(ct, cp, trip) {
  return cp.offsets[trip] ? addDays(ct.date, cp.offsets[trip]) : ct.date;
}
