// Place search: campus buildings, destinations, bus stops and saved places
// locally, with OpenStreetMap Nominatim for street addresses.

import { haversine } from './util.js';

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9#]+/g, ' ').trim();

// Nominatim search area: the Twin Cities metro
const VIEWBOX = '-93.55,45.15,-92.85,44.75';

export class PlaceSearch {
  constructor(net, places) {
    this.entries = [];
    for (const p of places) {
      this.entries.push({
        kind: 'place', name: p.n, sub: [p.c, p.addr].filter(Boolean).join(' · '), lat: p.lat, lon: p.lon,
        popular: !!p.p, keys: [p.n, ...(p.a || [])].map(norm), category: p.c,
      });
    }
    // group stops that share a name and sit within ~150 m of each other
    const groups = new Map();
    for (let i = 0; i < net.nStops; i++) {
      const name = net.stopName[i];
      let list = groups.get(name);
      if (!list) groups.set(name, (list = []));
      let g = list.find((x) => haversine(x.lat, x.lon, net.stopLat[i], net.stopLon[i]) < 150);
      if (!g) list.push((g = { lat: net.stopLat[i], lon: net.stopLon[i], ids: [], stops: [] }));
      g.ids.push(String(net.stopId[i]));
      g.stops.push(i);
    }
    for (const [name, list] of groups) {
      for (const g of list) {
        const lat = g.stops.reduce((a, s) => a + net.stopLat[s], 0) / g.stops.length;
        const lon = g.stops.reduce((a, s) => a + net.stopLon[s], 0) / g.stops.length;
        const routes = new Set();
        for (const s of g.stops) for (const r of net.stopRoutes[s]) routes.add(net.routes[r].label);
        this.entries.push({
          kind: 'stop', name, lat, lon, stops: g.stops,
          sub: `${g.ids.length > 1 ? 'Stops' : 'Stop'} #${g.ids.join(', #')} · ${[...routes].slice(0, 6).join(', ')}`,
          keys: [norm(name), ...g.ids.map((id) => id), ...g.ids.map((id) => `#${id}`)],
        });
      }
    }
  }

  popular() {
    return this.entries.filter((e) => e.popular);
  }

  search(query, limit = 12, extra = []) {
    const q = norm(query);
    if (!q) return [];
    const words = q.split(' ');
    const scored = [];
    for (const e of [...extra, ...this.entries]) {
      let best = 0;
      for (const k of e.keys || [norm(e.name)]) {
        let score = 0;
        if (k === q) score = 100;
        else if (k.startsWith(q)) score = 80;
        else if (words.every((w) => k.includes(w))) {
          score = 50 + (words.every((w) => k.split(' ').some((kw) => kw.startsWith(w))) ? 15 : 0);
        }
        best = Math.max(best, score);
      }
      if (best) {
        if (e.kind === 'saved') best += 25;
        if (e.popular) best += 10;
        if (e.kind === 'place') best += 5;
        scored.push([best, e]);
      }
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
    return scored.slice(0, limit).map((x) => x[1]);
  }

  async geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=us&bounded=1` +
      `&viewbox=${VIEWBOX}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    return data.map((d) => {
      const parts = d.display_name.split(', ');
      return {
        kind: 'geocode', name: d.name || parts[0], sub: parts.slice(d.name ? 1 : 1, 4).join(', '),
        lat: +d.lat, lon: +d.lon,
      };
    });
  }

  async reverse(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lon}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('reverse geocode failed');
    const d = await res.json();
    const a = d.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    return d.name || street || a.neighbourhood || d.display_name?.split(', ')[0] || null;
  }

  /** Nearest named place within `radius` metres, for labelling map taps. */
  nearestPlace(lat, lon, radius = 60) {
    let best = null, bestD = radius;
    for (const e of this.entries) {
      if (e.kind !== 'place') continue;
      const d = haversine(lat, lon, e.lat, e.lon);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }
}
