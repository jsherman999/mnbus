// Transit network model built from the JSON produced by tools/build_data.py.
// Also compiles a date-specific timetable (typed arrays) for the router.

import { haversine, decodePolyline, addDays, weekday, DAY } from './util.js';

// One colour per route, used for the map line, the badge and the step timeline.
// Official colours for METRO lines; ordinary buses (officially all one purple)
// get distinct colours so they can be told apart on the map.
const BUS_PALETTE = [
  '#1f5fbf', '#c62828', '#2e7d32', '#6a1b9a', '#d84315', '#00838f', '#5d4037', '#ad1457',
  '#827717', '#283593', '#00695c', '#4527a0', '#bf360c', '#0277bd', '#880e4f', '#558b2f',
];
const OFFICIAL = {
  901: '#0053A0', 902: '#008144', 903: '#E71324', 904: '#F68B1F', 905: '#E0A800', 992: '#008144', 906: '#0053A0',
  921: '#5A5B5A', 922: '#5A5B5A', 923: '#5A5B5A', 924: '#5A5B5A', 925: '#5A5B5A',
  120: '#7A0019', 121: '#B5121B', 122: '#C2410C', 123: '#9D174D', 124: '#5B21B6', 125: '#A16207',
};

function hashColor(id) {
  let h = 7;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BUS_PALETTE[h % BUS_PALETTE.length];
}

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#000000' : '#FFFFFF';
}

export const WALK_DETOUR = 1.25; // straight-line to walking-path distance factor

export class Network {
  constructor(net, timetable, shapes) {
    this.meta = { generated: net.generated, feed: net.feed, unit: net.unit || 1 };
    this.unit = net.unit || 1;

    // ---- stops
    const s = net.stops;
    this.nStops = s.id.length;
    this.stopId = s.id;
    this.stopName = s.name;
    this.stopDesc = s.desc;
    this.stopLat = Float64Array.from(s.lat, (v) => v / 1e5);
    this.stopLon = Float64Array.from(s.lon, (v) => v / 1e5);
    this.stopIndex = new Map(s.id.map((id, i) => [String(id), i]));

    // ---- routes
    this.routes = net.routes.map((r, i) => {
      const umnRoute = r.agency.startsWith('University of Minnesota');
      const color = OFFICIAL[r.id] || (umnRoute ? '#7A0019' : hashColor(r.id));
      return { ...r, index: i, umnRoute, color, badge: { bg: color, fg: textOn(color) }, patterns: [] };
    });

    // ---- patterns
    this.patterns = net.patterns.map((p, i) => {
      const pat = {
        index: i, route: p.r, dir: p.d, headsign: p.h, dirText: p.dt || '',
        stops: Int32Array.from(p.s), shape: p.g, verts: p.v, flags: p.f ? Uint8Array.from(p.f) : null,
      };
      this.routes[p.r].patterns.push(i);
      return pat;
    });
    // Headsigns like "Campus Connector" name the route, not where it's going:
    // fall back to the last stop so riders know which direction to take.
    for (const pat of this.patterns) {
      const r = this.routes[pat.route];
      const h = (pat.headsign || '').trim();
      const routeText = `${r.label} ${r.name} ${r.desc}`.toLowerCase();
      const last = this.stopName[pat.stops[pat.stops.length - 1]];
      pat.towards = !h || routeText.includes(h.toLowerCase()) ? last : h;
    }

    // stop -> [pattern, position]
    const sp = Array.from({ length: this.nStops }, () => []);
    this.patterns.forEach((p) => p.stops.forEach((st, pos) => sp[st].push(p.index, pos)));
    this.stopPatterns = sp.map((a) => Int32Array.from(a));
    this.stopRoutes = sp.map((a) => {
      const set = new Set();
      for (let k = 0; k < a.length; k += 2) set.add(this.patterns[a[k]].route);
      return [...set].sort((x, y) => x - y);
    });

    // ---- services
    this.services = net.services.map((sv) => ({
      id: sv.id, days: sv.days || '0000000', start: sv.start || '00000000', end: sv.end || '00000000',
      add: new Set(sv.add || []), rem: new Set(sv.rem || []),
    }));

    this.timetable = timetable.patterns;
    this.shapeStrings = shapes ? shapes.shapes : [];
    this.shapeCache = new Map();
    this.compiled = new Map();

    this.buildGrid();
    this.footpaths = null;
  }

  // -------------------------------------------------------------- geometry

  shape(i) {
    let pts = this.shapeCache.get(i);
    if (!pts) {
      pts = decodePolyline(this.shapeStrings[i] || '');
      this.shapeCache.set(i, pts);
    }
    return pts;
  }

  /** Polyline of a pattern between two stop positions (inclusive). */
  patternPath(patIdx, fromPos, toPos) {
    const p = this.patterns[patIdx];
    const pts = this.shape(p.shape);
    if (!pts.length) {
      const out = [];
      for (let i = fromPos; i <= toPos; i++) out.push([this.stopLat[p.stops[i]], this.stopLon[p.stops[i]]]);
      return out;
    }
    const a = p.verts[fromPos], b = p.verts[toPos];
    return pts.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  buildGrid() {
    this.cell = 0.004; // ~440 m north-south, ~315 m east-west
    this.grid = new Map();
    for (let i = 0; i < this.nStops; i++) {
      const k = this.cellKey(this.stopLat[i], this.stopLon[i]);
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(i);
    }
  }

  cellKey(lat, lon) {
    return `${Math.floor(lat / this.cell)}:${Math.floor(lon / this.cell)}`;
  }

  /** Stops within `radius` metres (straight line), nearest first: [{stop, dist}] */
  stopsNear(lat, lon, radius) {
    const out = [];
    const r = Math.ceil(radius / 300) + 1;
    const ci = Math.floor(lat / this.cell), cj = Math.floor(lon / this.cell);
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        const arr = this.grid.get(`${ci + di}:${cj + dj}`);
        if (!arr) continue;
        for (const st of arr) {
          const d = haversine(lat, lon, this.stopLat[st], this.stopLon[st]);
          if (d <= radius) out.push({ stop: st, dist: d });
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  nearestStops(lat, lon, count, maxRadius = 5000) {
    for (let radius = 400; radius <= maxRadius; radius *= 2) {
      const found = this.stopsNear(lat, lon, radius);
      if (found.length >= count || radius * 2 > maxRadius) return found.slice(0, count);
    }
    return [];
  }

  /** Walking transfers between nearby stops: per stop Int32Array [stop, metres, ...]. */
  getFootpaths(radius = 320) {
    if (this.footpaths && this.footpathRadius === radius) return this.footpaths;
    const fp = new Array(this.nStops);
    for (let i = 0; i < this.nStops; i++) {
      const near = this.stopsNear(this.stopLat[i], this.stopLon[i], radius);
      const arr = [];
      for (const { stop, dist } of near) if (stop !== i) arr.push(stop, Math.round(dist * WALK_DETOUR));
      fp[i] = Int32Array.from(arr);
    }
    this.footpaths = fp;
    this.footpathRadius = radius;
    return fp;
  }

  // -------------------------------------------------------------- calendar

  serviceActive(sv, date) {
    if (sv.rem.has(date)) return false;
    if (sv.add.has(date)) return true;
    return date >= sv.start && date <= sv.end && sv.days[weekday(date)] === '1';
  }

  activeServices(date) {
    return Uint8Array.from(this.services, (sv) => (this.serviceActive(sv, date) ? 1 : 0));
  }

  /** True when the feed has any service on this date. */
  hasService(date) {
    return this.activeServices(date).some((x) => x);
  }

  // -------------------------------------------------------------- timetable

  /**
   * Timetable for one service date. Times are seconds relative to the start of
   * `date`; trips from the previous evening (after midnight) and the next
   * morning are included with shifted times so searches can cross midnight.
   */
  compile(date) {
    if (this.compiled.has(date)) return this.compiled.get(date);
    const unit = this.unit;
    const days = [
      { offset: -1, active: this.activeServices(addDays(date, -1)), keep: (s, e) => e >= DAY },
      { offset: 0, active: this.activeServices(date), keep: () => true },
      { offset: 1, active: this.activeServices(addDays(date, 1)), keep: (s) => s < 10 * 3600 },
    ];
    const pats = new Array(this.patterns.length);
    const tripIndex = new Map(); // "tripId|date" -> [pattern, row]
    for (let p = 0; p < this.patterns.length; p++) {
      const pat = this.patterns[p];
      const n = pat.stops.length;
      const tt = this.timetable[p];
      // decode profiles once per pattern
      if (!tt._profiles) {
        tt._profiles = tt.p.map((prof) => {
          const travel = Array.isArray(prof) ? prof : prof.t;
          const dwell = new Int32Array(n);
          if (!Array.isArray(prof)) for (const [i, w] of prof.w) dwell[i] = w * unit;
          const arr = new Int32Array(n), dep = new Int32Array(n);
          arr[0] = -dwell[0]; dep[0] = 0;
          for (let i = 1; i < n; i++) {
            arr[i] = dep[i - 1] + travel[i - 1] * unit;
            dep[i] = arr[i] + dwell[i];
          }
          return { arr, dep };
        });
        let t = 0;
        tt._starts = tt.s.map((d) => (t += d) * unit);
      }
      const rows = [];
      for (let j = 0; j < tt._starts.length; j++) {
        const prof = tt._profiles[tt.i ? tt.i[j] : 0];
        const start = tt._starts[j];
        const end = start + prof.arr[n - 1];
        for (const day of days) {
          if (!day.active[tt.v[j]] || !day.keep(start, end)) continue;
          rows.push({ start: start + day.offset * DAY, prof, trip: tt.t[j], offset: day.offset });
        }
      }
      rows.sort((a, b) => a.start - b.start);
      const m = rows.length;
      const dep = new Int32Array(m * n), arr = new Int32Array(m * n);
      const ids = new Array(m), offsets = new Int8Array(m);
      rows.forEach((row, j) => {
        const base = j * n;
        for (let i = 0; i < n; i++) {
          dep[base + i] = row.start + row.prof.dep[i];
          arr[base + i] = row.start + row.prof.arr[i];
        }
        ids[j] = String(row.trip);
        offsets[j] = row.offset;
        tripIndex.set(`${row.trip}|${addDays(date, row.offset)}`, [p, j]);
      });
      pats[p] = { n, nTrips: m, dep, arr, ids, offsets, stops: pat.stops, flags: pat.flags, cancelled: null };
    }
    const compiled = { date, patterns: pats, tripIndex, realtime: false };
    this.compiled.set(date, compiled);
    if (this.compiled.size > 4) this.compiled.delete(this.compiled.keys().next().value);
    return compiled;
  }
}

/** Reverse a compiled timetable so the forward router can search backwards in time. */
export function reverseTimetable(ct) {
  if (ct._reversed) return ct._reversed;
  const patterns = ct.patterns.map((p) => {
    const { n, nTrips } = p;
    // order trips by final arrival descending == reversed departure ascending
    const order = Array.from({ length: nTrips }, (_, j) => j)
      .sort((a, b) => p.arr[b * n + n - 1] - p.arr[a * n + n - 1]);
    const dep = new Int32Array(nTrips * n), arr = new Int32Array(nTrips * n);
    order.forEach((j, r) => {
      for (let i = 0; i < n; i++) {
        dep[r * n + i] = -p.arr[j * n + (n - 1 - i)];
        arr[r * n + i] = -p.dep[j * n + (n - 1 - i)];
      }
    });
    const stops = Int32Array.from(p.stops).reverse();
    let flags = null;
    if (p.flags) {
      flags = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const f = p.flags[n - 1 - i];
        flags[i] = ((f & 1) << 1) | ((f & 2) >> 1); // no-pickup <-> no-drop-off
      }
    }
    let cancelled = null;
    if (p.cancelled) cancelled = Uint8Array.from(order, (j) => p.cancelled[j]);
    return { n, nTrips, dep, arr, stops, flags, cancelled, tripMap: Int32Array.from(order) };
  });
  ct._reversed = { date: ct.date, patterns, reversed: true };
  return ct._reversed;
}
