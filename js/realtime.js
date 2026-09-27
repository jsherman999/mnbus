// Live data from Metro Transit (all endpoints send Access-Control-Allow-Origin: *).
//   GTFS-realtime trip updates  -> adjust the timetable before planning "leave now" trips
//   GTFS-realtime vehicles      -> live bus/train markers
//   GTFS-realtime alerts        -> detours, stop closures
//   NexTrip v2                  -> per-stop departure boards
// Includes a small protobuf reader so no library is needed.

import { serviceDayStart } from './util.js';

const BASE = 'https://svc.metrotransit.org';
export const URLS = {
  tripUpdates: `${BASE}/mtgtfs/tripupdates.pb`,
  vehicles: `${BASE}/mtgtfs/vehiclepositions.pb`,
  alerts: `${BASE}/mtgtfs/alerts.pb`,
  nextrip: (stopId) => `${BASE}/nextrip/${encodeURIComponent(stopId)}`,
};

// ------------------------------------------------------------------ protobuf

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  more() { return this.pos < this.end; }
  varint() { // returns [lo, hi] 32-bit halves
    let lo = 0, hi = 0, shift = 0, b;
    do {
      b = this.buf[this.pos++];
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >> 4; }
      else hi |= (b & 0x7f) << (shift - 32);
      shift += 7;
    } while (b & 0x80);
    return [lo >>> 0, hi >>> 0];
  }
  uint() { const [lo, hi] = this.varint(); return hi * 4294967296 + lo; }
  int32() { return this.varint()[0] | 0; }
  int64() { const [lo, hi] = this.varint(); return (hi | 0) * 4294967296 + lo; }
  bytes() { const len = this.uint(); const start = this.pos; this.pos += len; return [start, this.pos]; }
  string() { const [a, b] = this.bytes(); return textDecoder.decode(this.buf.subarray(a, b)); }
  float() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  double() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  sub() { const [a, b] = this.bytes(); return new Reader(this.buf, a, b); }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  /** Iterate fields: fn(fieldNumber, wireType) must consume or return false to skip. */
  fields(fn) {
    while (this.more()) {
      const key = this.uint();
      const field = Math.floor(key / 8), wire = key & 7;
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
}
const textDecoder = new TextDecoder();

function tripDescriptor(r) {
  const t = { tripId: '', startDate: '', routeId: '', directionId: null, rel: 0 };
  r.fields((f, w) => {
    if (f === 1 && w === 2) t.tripId = r.string();
    else if (f === 3 && w === 2) t.startDate = r.string();
    else if (f === 4 && w === 0) t.rel = r.uint();
    else if (f === 5 && w === 2) t.routeId = r.string();
    else if (f === 6 && w === 0) t.directionId = r.uint();
    else return false;
  });
  return t;
}

function stopTimeEvent(r) {
  const e = { delay: null, time: null };
  r.fields((f, w) => {
    if (f === 1 && w === 0) e.delay = r.int32();
    else if (f === 2 && w === 0) e.time = r.int64();
    else return false;
  });
  return e;
}

function translated(r) {
  let text = '';
  r.fields((f, w) => {
    if (f === 1 && w === 2) {
      const t = r.sub();
      let s = '', lang = '';
      t.fields((f2, w2) => {
        if (f2 === 1 && w2 === 2) s = t.string();
        else if (f2 === 2 && w2 === 2) lang = t.string();
        else return false;
      });
      if (!text || lang === 'en') text = s;
    } else return false;
  });
  return text;
}

/** Decode a GTFS-realtime FeedMessage into {timestamp, tripUpdates, vehicles, alerts}. */
export function decodeFeed(arrayBuffer) {
  const r = new Reader(new Uint8Array(arrayBuffer));
  const out = { timestamp: 0, tripUpdates: [], vehicles: [], alerts: [] };
  r.fields((f, w) => {
    if (f === 1 && w === 2) {
      const h = r.sub();
      h.fields((f2, w2) => {
        if (f2 === 3 && w2 === 0) out.timestamp = h.uint();
        else return false;
      });
    } else if (f === 2 && w === 2) {
      const e = r.sub();
      let id = '';
      e.fields((f2, w2) => {
        if (f2 === 1 && w2 === 2) id = e.string();
        else if (f2 === 3 && w2 === 2) out.tripUpdates.push(tripUpdate(e.sub()));
        else if (f2 === 4 && w2 === 2) out.vehicles.push(vehicle(e.sub()));
        else if (f2 === 5 && w2 === 2) out.alerts.push({ id, ...alert(e.sub()) });
        else return false;
      });
    } else return false;
  });
  return out;
}

function tripUpdate(r) {
  const tu = { trip: null, updates: [], delay: null, timestamp: 0, vehicleLabel: '' };
  r.fields((f, w) => {
    if (f === 1 && w === 2) tu.trip = tripDescriptor(r.sub());
    else if (f === 2 && w === 2) {
      const s = r.sub();
      const u = { seq: null, stopId: '', arr: null, dep: null, rel: 0 };
      s.fields((f2, w2) => {
        if (f2 === 1 && w2 === 0) u.seq = s.uint();
        else if (f2 === 2 && w2 === 2) u.arr = stopTimeEvent(s.sub());
        else if (f2 === 3 && w2 === 2) u.dep = stopTimeEvent(s.sub());
        else if (f2 === 4 && w2 === 2) u.stopId = s.string();
        else if (f2 === 5 && w2 === 0) u.rel = s.uint();
        else return false;
      });
      tu.updates.push(u);
    } else if (f === 4 && w === 0) tu.timestamp = r.uint();
    else if (f === 5 && w === 0) tu.delay = r.int32();
    else return false;
  });
  return tu;
}

function vehicle(r) {
  const v = { trip: null, lat: 0, lon: 0, bearing: null, speed: null, timestamp: 0, stopId: '', id: '', label: '', status: null };
  r.fields((f, w) => {
    if (f === 1 && w === 2) v.trip = tripDescriptor(r.sub());
    else if (f === 2 && w === 2) {
      const p = r.sub();
      p.fields((f2, w2) => {
        if (f2 === 1 && w2 === 5) v.lat = p.float();
        else if (f2 === 2 && w2 === 5) v.lon = p.float();
        else if (f2 === 3 && w2 === 5) v.bearing = p.float();
        else if (f2 === 5 && w2 === 5) v.speed = p.float();
        else return false;
      });
    } else if (f === 4 && w === 0) v.status = r.uint();
    else if (f === 5 && w === 0) v.timestamp = r.uint();
    else if (f === 7 && w === 2) v.stopId = r.string();
    else if (f === 8 && w === 2) {
      const d = r.sub();
      d.fields((f2, w2) => {
        if (f2 === 1 && w2 === 2) v.id = d.string();
        else if (f2 === 2 && w2 === 2) v.label = d.string();
        else return false;
      });
    } else return false;
  });
  return v;
}

function alert(r) {
  const a = { periods: [], routes: new Set(), stops: new Set(), header: '', description: '', effect: null, url: '' };
  r.fields((f, w) => {
    if (f === 1 && w === 2) {
      const t = r.sub();
      const p = { start: 0, end: 0 };
      t.fields((f2, w2) => {
        if (f2 === 1 && w2 === 0) p.start = t.uint();
        else if (f2 === 2 && w2 === 0) p.end = t.uint();
        else return false;
      });
      a.periods.push(p);
    } else if (f === 5 && w === 2) {
      const e = r.sub();
      e.fields((f2, w2) => {
        if (f2 === 2 && w2 === 2) a.routes.add(e.string());
        else if (f2 === 5 && w2 === 2) a.stops.add(e.string());
        else return false;
      });
    } else if (f === 7 && w === 0) a.effect = r.uint();
    else if (f === 8 && w === 2) a.url = translated(r.sub());
    else if (f === 10 && w === 2) a.header = translated(r.sub());
    else if (f === 11 && w === 2) a.description = translated(r.sub());
    else return false;
  });
  return a;
}

// ---------------------------------------------------------- apply to timetable

/**
 * Copy a compiled timetable, replacing scheduled times with predictions.
 * Delays propagate downstream to stops without their own prediction (GTFS-rt rule).
 */
export function applyTripUpdates(net, ct, feed) {
  const patterns = ct.patterns.slice();
  const touched = new Map();
  const base = serviceDayStart(ct.date) / 1000;
  let applied = 0, cancelled = 0;
  const toSecs = (epoch) => Math.round(epoch - base);

  for (const tu of feed.tripUpdates) {
    if (!tu.trip || !tu.trip.tripId) continue;
    const date = tu.trip.startDate || ct.date;
    const hit = ct.tripIndex.get(`${tu.trip.tripId}|${date}`);
    if (!hit) continue;
    const [p, j] = hit;
    let cp = touched.get(p);
    if (!cp) {
      const orig = ct.patterns[p];
      cp = { ...orig, dep: orig.dep.slice(), arr: orig.arr.slice(), base: orig, rt: new Uint8Array(orig.nTrips),
        cancelled: orig.cancelled ? orig.cancelled.slice() : new Uint8Array(orig.nTrips) };
      touched.set(p, cp);
      patterns[p] = cp;
    }
    if (tu.trip.rel === 3) { cp.cancelled[j] = 1; cancelled++; continue; }
    const n = cp.n, row = j * n;
    let ptr = 0, delay = null, any = false;
    const stops = cp.stops;
    for (const u of tu.updates) {
      // locate this update's stop at or after the pointer
      let i = -1;
      if (u.stopId) {
        const idx = net.stopIndex.get(u.stopId);
        for (let k = ptr; k < n; k++) if (stops[k] === idx) { i = k; break; }
      }
      if (i < 0) continue;
      // propagate previous delay across stops between updates
      if (delay !== null) for (let k = ptr; k < i; k++) { cp.arr[row + k] += delay; cp.dep[row + k] += delay; }
      if (u.rel === 2) { delay = null; ptr = i + 1; continue; } // NO_DATA
      const sa = cp.base.arr[row + i], sd = cp.base.dep[row + i];
      const ev = (e, sched) => (e.time ? toSecs(e.time) : e.delay !== null ? sched + e.delay : null);
      let a = u.arr ? ev(u.arr, sa) : null;
      let d = u.dep ? ev(u.dep, sd) : null;
      if (a === null && d !== null) a = d - (sd - sa);
      if (d === null && a !== null) d = a + (sd - sa);
      if (a !== null) {
        cp.arr[row + i] = a;
        cp.dep[row + i] = Math.max(a, d);
        delay = cp.dep[row + i] - sd;
        any = true;
      }
      ptr = i + 1;
    }
    if (delay !== null) for (let k = ptr; k < n; k++) { cp.arr[row + k] += delay; cp.dep[row + k] += delay; }
    // keep times non-decreasing along the trip
    for (let k = 1; k < n; k++) {
      if (cp.arr[row + k] < cp.dep[row + k - 1]) cp.arr[row + k] = cp.dep[row + k - 1];
      if (cp.dep[row + k] < cp.arr[row + k]) cp.dep[row + k] = cp.arr[row + k];
    }
    if (any) { cp.rt[j] = 1; applied++; }
  }
  return {
    ...ct, patterns, realtime: true, rtStats: { applied, cancelled, timestamp: feed.timestamp },
    _reversed: undefined,
  };
}

// ------------------------------------------------------------------ fetching

async function fetchBuffer(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

const cache = new Map();
/** Fetch + decode a GTFS-rt feed, cached for `maxAge` ms. */
export async function getFeed(kind, maxAge = 30000) {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < maxAge) return hit.promise;
  const promise = fetchBuffer(URLS[kind]).then(decodeFeed);
  cache.set(kind, { at: Date.now(), promise });
  promise.catch(() => cache.delete(kind));
  return promise;
}

/** NexTrip departures for a stop: {stops, alerts, departures} */
export async function getNexTrip(stopId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(URLS.nextrip(stopId), { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`NexTrip ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Alerts that are active now, indexed by route_id and stop_id. */
export function indexAlerts(feed, nowSec = Date.now() / 1000) {
  const byRoute = new Map(), byStop = new Map();
  for (const a of feed.alerts) {
    const active = !a.periods.length || a.periods.some((p) => (!p.start || p.start <= nowSec) && (!p.end || p.end >= nowSec));
    if (!active || !a.header) continue;
    for (const r of a.routes) { if (!byRoute.has(r)) byRoute.set(r, []); byRoute.get(r).push(a); }
    for (const s of a.stops) { if (!byStop.has(s)) byStop.set(s, []); byStop.get(s).push(a); }
  }
  return { byRoute, byStop };
}
