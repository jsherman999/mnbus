// Walking distances and turn-by-turn directions from the FOSSGIS OSRM foot
// router (OpenStreetMap data). Used to replace straight-line estimates so the
// planner knows about the river, freeways and campus paths. Falls back
// silently to estimates if the service is slow or unavailable.

const OSRM = 'https://routing.openstreetmap.de/routed-foot';
const cache = new Map();

async function getJson(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`OSRM ${data.code}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const c = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;

/**
 * Walking metres from `point` to each stop (Infinity when the router finds no path).
 * Results are cached, so calling this as soon as a point is chosen warms it up.
 * @returns {Promise<Map<number, number>>}
 */
export function walkTable(point, stops, timeoutMs = 6000) {
  const list = stops.slice(0, 90);
  const key = `t:${c(point)}:${list.map((s) => s.stop).join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const coords = [c(point), ...list.map(c)];
  const url = `${OSRM}/table/v1/foot/${coords.join(';')}?sources=0&annotations=distance`;
  const promise = getJson(url, timeoutMs).then((data) => {
    const row = data.distances[0];
    const out = new Map();
    // the router snaps each point to the nearest path; add those snap distances
    const src = data.sources?.[0]?.distance || 0;
    list.forEach((s, i) => {
      const d = row[i + 1];
      out.set(s.stop, d == null ? Infinity : d + (data.destinations?.[i + 1]?.distance || 0) + src);
    });
    return out;
  });
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

const MOD = { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right',
  'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'around' };
const HEAD = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

function instruction(s) {
  const m = s.maneuver || {};
  const name = s.name ? s.name : 'the path';
  const mod = MOD[m.modifier] || m.modifier || '';
  switch (m.type) {
    case 'depart': return `Head ${HEAD[Math.round((m.bearing_after || 0) / 45) % 8]}${s.name ? ` on ${s.name}` : ''}`;
    case 'arrive': return 'Arrive';
    case 'turn': case 'end of road': return `Turn ${mod} onto ${name}`;
    case 'continue': return mod && mod !== 'straight' ? `Keep ${mod} on ${name}` : `Continue on ${name}`;
    case 'new name': return `Continue onto ${name}`;
    case 'fork': return `Keep ${mod} at the fork onto ${name}`;
    case 'merge': case 'on ramp': case 'off ramp': return `Continue onto ${name}`;
    case 'roundabout': case 'rotary': return `At the roundabout, take the exit onto ${name}`;
    default: return mod ? `Go ${mod} onto ${name}` : `Continue on ${name}`;
  }
}

/** Walking route geometry and steps between two points. */
export async function walkRoute(a, b, timeoutMs = 6000) {
  const key = `r:${c(a)};${c(b)}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${OSRM}/route/v1/foot/${c(a)};${c(b)}?overview=full&geometries=geojson&steps=true`;
  const promise = getJson(url, timeoutMs).then((data) => {
    const route = data.routes[0];
    const steps = [];
    for (const leg of route.legs) {
      for (const s of leg.steps) {
        if (s.maneuver?.type === 'arrive') continue;
        const text = instruction(s);
        const last = steps[steps.length - 1];
        // merge consecutive steps on the same unnamed path
        if (last && last.text === text) { last.distance += s.distance; continue; }
        steps.push({ text, distance: s.distance });
      }
    }
    return {
      coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distance: route.distance,
      steps,
    };
  });
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}
