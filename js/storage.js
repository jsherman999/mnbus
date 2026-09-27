// Per-device preferences and saved places (localStorage, best effort).

const PREFIX = 'mnbus.';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function readList(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode or storage full: preferences just won't persist */
  }
}

export const DEFAULT_SETTINGS = {
  walkSpeed: 1.25,       // m/s
  maxWalk: 805,          // metres
  transferSlack: 120,    // seconds
  live: true,
  mapStyle: 'voyager',
  allRoutes: false,
  hiddenRoutes: [],
};

export const settings = read('settings', DEFAULT_SETTINGS);
export const saveSettings = () => write('settings', settings);

export const savedPlaces = readList('saved');
export const saveSavedPlaces = () => write('saved', savedPlaces);

export const recentPlaces = readList('recent');
export function addRecent(p) {
  const i = recentPlaces.findIndex((x) => x.name === p.name && Math.abs(x.lat - p.lat) < 1e-4);
  if (i >= 0) recentPlaces.splice(i, 1);
  recentPlaces.unshift({ name: p.name, lat: p.lat, lon: p.lon });
  recentPlaces.length = Math.min(recentPlaces.length, 8);
  write('recent', recentPlaces);
}
