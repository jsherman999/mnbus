// Shared helpers: geography, Central-time clock math and formatting.
// No DOM access here so the planner can also run under Node for tests.

export const TZ = 'America/Chicago';
export const DAY = 86400;

// ------------------------------------------------------------------ geography

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dp = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compass(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let lat = 0, lon = 0, i = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

// ------------------------------------------------------------ Central time

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Wall-clock parts in Minneapolis for an epoch (ms). */
export function chicagoParts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Epoch (ms) for a Minneapolis wall-clock time. */
export function chicagoToEpoch(y, m, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let ms = guess;
  for (let i = 0; i < 3; i++) {
    const p = chicagoParts(ms);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    ms += guess - asUtc;
  }
  return ms;
}

export const dateStr = (y, m, d) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
export const splitDate = (s) => [+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8)];

export function addDays(s, n) {
  const [y, m, d] = splitDate(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 0 = Monday ... 6 = Sunday */
export function weekday(s) {
  const [y, m, d] = splitDate(s);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** GTFS service day origin: noon minus 12 hours, local time (handles DST days). */
export function serviceDayStart(s) {
  const [y, m, d] = splitDate(s);
  return chicagoToEpoch(y, m, d, 12, 0, 0) - 12 * 3600 * 1000;
}

/** Current service date and seconds since its start, Minneapolis time. */
export function nowChicago(ms = Date.now()) {
  const p = chicagoParts(ms);
  const date = dateStr(p.y, p.m, p.d);
  return { date, secs: Math.round((ms - serviceDayStart(date)) / 1000), ms };
}

export function toEpochMs(date, secs) {
  return serviceDayStart(date) + secs * 1000;
}

const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });

/** "8:05 AM" for seconds relative to a service date. */
export function formatClock(date, secs) {
  return clockFmt.format(new Date(toEpochMs(date, secs)));
}

export function formatDay(date, secs = 12 * 3600) {
  return dayFmt.format(new Date(toEpochMs(date, secs)));
}

export function formatDuration(secs) {
  const m = Math.max(0, Math.round(secs / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

export function formatDistance(meters) {
  const feet = meters * 3.28084;
  if (feet < 700) return `${Math.max(50, Math.round(feet / 50) * 50)} ft`;
  const miles = meters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
