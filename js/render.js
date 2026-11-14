// HTML builders for the planner UI. Pure functions returning strings.

import {
  escapeHtml as esc, formatClock, formatDuration, formatDistance, compass, bearing, formatDay, DAY,
} from './util.js';

export const ICONS = {
  walk: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5.1 5.1 0 0 1-4.4-2.4l-1-1.6A2 2 0 0 0 12 6a2 2 0 0 0-.8.2L6 8.3V13h2V9.6l1.8-.7"/></svg>',
  bus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 11H6V6h12v5Z"/></svg>',
  train: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-3.6-4-8-4ZM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM11 10H6V6h5v4Zm2 0V6h5v4h-5Zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7Z"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2Zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3ZM9 3 5 6.99h3V14h2V6.99h3L9 3Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17.3 6.2 3.7-1.7-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.1c-.8 0-1.5.3-2 .8l-7.1-4.2c.1-.2.1-.5.1-.7s0-.5-.1-.7L16 7.2A3 3 0 1 0 15 5c0 .2 0 .5.1.7L8 9.8A3 3 0 1 0 8 14.2l7.1 4.2-.1.6a2.9 2.9 0 1 0 3-2.9Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  routes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 15.2V5a3 3 0 0 0-3-3 3 3 0 0 0-3 3v14a1 1 0 0 1-2 0V8.8a3 3 0 1 0-2 0V19a3 3 0 0 0 6 0V5a1 1 0 0 1 2 0v10.2a3 3 0 1 0 2 0Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.3-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" transform="translate(-1 0)"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.6 6.4A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4l-2.4 2.4Z"/></svg>',
};

const DIRS = { NB: 'northbound', SB: 'southbound', EB: 'eastbound', WB: 'westbound' };

export function routeBadge(route, extra = '') {
  return `<span class="badge ${extra}" style="--rb:${route.badge.bg};--rf:${route.badge.fg}">${esc(route.label)}</span>`;
}

const UMN_PREFIX = /^U of M\s*-\s*/i;

export function routeTitle(route) {
  if (route.umnRoute) return (route.name || route.desc || `Route ${route.label}`).replace(UMN_PREFIX, '');
  if (route.type === 0 || !/^\d+$/.test(route.label)) return route.name || `Route ${route.label}`;
  return `Route ${route.label}`;
}

export function routeSubtitle(route) {
  if (route.umnRoute) return 'Free U of M campus bus';
  if (route.type === 0 || !/^\d+$/.test(route.label)) return route.desc && route.desc !== route.name ? route.desc : '';
  return route.name || route.desc || '';
}

/** "bus", "Campus Connector", "Green Line train"... as used in "Board the [3] bus". */
function boardName(route) {
  if (route.umnRoute) return routeTitle(route);
  if (route.type === 0) return `${(route.name || route.label).replace(/^METRO /, '')} train`;
  if (/^9\d\d$/.test(route.id)) return `${(route.name || route.label).replace(/^METRO /, '')} bus`;
  return 'bus';
}

export function isRail(route) {
  return route.type === 0 || route.type === 1 || route.type === 2;
}

function relative(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m <= 0) return m < -1 ? `${-m} min ago` : 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h} hr${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function dayLabel(it) {
  const offset = Math.floor(it.depart / DAY);
  if (offset <= 0) return '';
  return offset === 1 ? 'Tomorrow' : formatDay(it.date, it.depart);
}

/** Summary card in the results list. */
export function itineraryCard(net, it, i, ctx) {
  const chips = [];
  for (const l of it.legs) {
    if (l.type === 'walk') {
      const min = Math.round((l.end - l.start) / 60);
      if (min >= 1 || it.legs.length === 3) chips.push(`<span class="chip walk">${ICONS.walk}${min}</span>`);
    } else {
      chips.push(routeBadge(net.routes[l.route]));
    }
  }
  const day = dayLabel(it);
  const leave = ctx.isNow ? `<span class="leave-in">Leave ${relative(ctx.toMs(it.depart))}</span>` : '';
  const live = it.realtime ? '<span class="live-dot" title="Uses live predictions"></span>' : '';
  const tags = (it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `<button class="card itin" data-i="${i}" type="button">
    <div class="row1">
      <span class="times">${day ? `<span class="day">${esc(day)}</span> ` : ''}${formatClock(it.date, it.depart)} – ${formatClock(it.date, it.arrive)}</span>
      <span class="dur">${formatDuration(it.duration)}</span>
    </div>
    <div class="chips">${chips.join(`<span class="sep">${ICONS.chevron}</span>`)}</div>
    <div class="row3">${live}${leave}<span class="meta">${it.transfers ? `${it.transfers} transfer${it.transfers > 1 ? 's' : ''} · ` : ''}walk ${formatDistance(it.walkMeters)}</span>${tags}</div>
  </button>`;
}

export function walkOnlyCard(walk, ctx) {
  const min = Math.round(walk.secs / 60);
  return `<button class="card walk-only" data-walk="1" type="button">
    <div class="row1"><span class="times">${ICONS.walk} Walk the whole way</span><span class="dur">${formatDuration(walk.secs)}</span></div>
    <div class="row3"><span class="meta">${formatDistance(walk.meters)}${ctx.arrival ? ` · arrive ${ctx.arrival}` : ''}</span>${min <= 20 ? '<span class="tag">Short walk</span>' : ''}</div>
  </button>`;
}

function liveLine(date, l) {
  if (!l.realtime) return '<span class="sched">Scheduled time</span>';
  const diff = Math.round((l.start - l.schedStart) / 60);
  const status = diff >= 2 ? `<span class="late">${diff} min late</span>` : diff <= -2 ? `<span class="early">${-diff} min early</span>` : '<span class="ontime">on time</span>';
  return `<span class="live"><span class="live-dot"></span>Live: departs ${formatClock(date, l.start)}</span> · ${status}`;
}

function stopLabel(net, pt) {
  if (pt.kind !== 'stop') return esc(pt.name);
  const desc = net.stopDesc[pt.stop];
  return `${esc(pt.name)}<span class="stopno">Stop #${esc(net.stopId[pt.stop])}${desc ? ` · ${esc(desc)}` : ''}</span>`;
}

/** Step-by-step instructions for one itinerary. */
export function itineraryDetails(net, it, ctx) {
  const d = it.date;
  const steps = [];
  const legs = it.legs;
  const origin = legs[0].from, dest = legs[legs.length - 1].to;
  const day = dayLabel(it);

  steps.push(step('start', `<b>${formatClock(d, it.depart)}</b>`, `Leave ${esc(origin.name)}${day ? ` <span class="day">${esc(day)}</span>` : ''}`));

  legs.forEach((l, idx) => {
    if (l.type === 'walk') {
      const mins = Math.round((l.end - l.start) / 60);
      const dir = compass(bearing(l.from.lat, l.from.lon, l.to.lat, l.to.lon));
      const toDest = l.to.kind === 'destination';
      const tiny = l.meters < 40;
      let text;
      const samePlace = l.from.kind === 'stop' && l.from.name === l.to.name;
      if (tiny || (samePlace && l.meters < 120)) {
        text = toDest ? 'Your destination is right by the stop.'
          : samePlace ? `Stay at ${esc(l.to.name)} and go to the stop or platform for your next ride${l.to.kind === 'stop' ? ` (Stop #${esc(net.stopId[l.to.stop])})` : ''}.`
            : `Your stop is right here: ${stopLabel(net, l.to)}`;
      }
      else text = `Walk ${mins < 1 ? 'about 1 min' : `${mins} min`} (${formatDistance(l.meters)}) ${dir} to ${toDest ? 'your destination' : stopLabel(net, l.to)}`;
      const dirBtn = tiny || samePlace ? '' : `<button class="link walk-dir" data-leg="${idx}" type="button">Walking directions</button><div class="walk-steps" data-leg="${idx}" hidden></div>`;
      steps.push(step('walk', `${ICONS.walk}`, `${text}${dirBtn}`, 'walk'));
      const next = legs[idx + 1];
      if (next && next.type === 'ride') {
        const wait = Math.round((next.start - l.end) / 60);
        if (idx === 0) {
          steps.push(step('info', ICONS.clock, `Be at the stop by <b>${formatClock(d, next.start - ctx.startSlack)}</b>${wait > 1 ? ` (about ${wait} min before it leaves)` : ''}`, 'minor'));
        } else if (wait >= 1) {
          steps.push(step('info', ICONS.clock, `Wait about ${wait} min`, 'minor'));
        }
      }
      return;
    }
    const route = net.routes[l.route];
    const rail = isRail(route);
    const prev = legs[idx - 1];
    if (prev && prev.type === 'ride') {
      const wait = Math.round((l.start - prev.end) / 60);
      steps.push(step('info', ICONS.clock, `Transfer at this stop${wait >= 1 ? ` — wait about ${wait} min` : ''}`, 'minor'));
    }
    const dir = DIRS[l.dirText] ? ` (${DIRS[l.dirText]})` : '';
    const nStops = l.alight - l.board;
    const rideMin = Math.round((l.end - l.start) / 60);
    const alerts = (ctx.alerts?.byRoute.get(route.id) || []).slice(0, 2)
      .map((a) => `<div class="alert">${ICONS.alert}<span>${esc(a.header)}</span></div>`).join('');
    const stopsList = l.stops.map((s, k) => `<li class="${k === 0 || k === l.stops.length - 1 ? 'end' : ''}"><span>${formatClock(d, s.time)}</span> ${esc(net.stopName[s.stop])}</li>`).join('');
    const prevStop = l.alight - 1 > l.board ? net.stopName[net.patterns[l.pattern].stops[l.alight - 1]] : '';
    const tip = !rail && prevStop ? `<div class="tip">Pull the cord (or press the stop button) after <b>${esc(prevStop)}</b> — your stop is next.</div>` : '';
    const railTip = rail ? `<div class="tip">Board on the platform for trains toward <b>${esc(l.headsign)}</b>.</div>` : '';
    steps.push(step('board', `<b>${formatClock(d, l.start)}</b>`,
      `<div class="board-line">Board the ${routeBadge(route)} <b>${esc(boardName(route))}</b> toward <b>${esc(l.headsign)}</b>${dir}</div>
       <div class="at">at ${stopLabel(net, l.from)}</div>
       <div class="rt" data-trip="${esc(l.tripId)}">${liveLine(d, l)}</div>
       ${railTip}${alerts}
       <details><summary>Ride ${nStops} stop${nStops === 1 ? '' : 's'} · ${formatDuration(rideMin * 60)}</summary><ol class="stoplist">${stopsList}</ol></details>
       ${tip}`, rail ? 'ride rail' : 'ride', route.color));
    steps.push(step('alight', `<b>${formatClock(d, l.end)}</b>`, `Get off at ${stopLabel(net, l.to)}`, 'ride-end', route.color));
  });

  steps.push(step('end', `<b>${formatClock(d, it.arrive)}</b>`, `Arrive at ${esc(dest.name)}`));

  return `<div class="details">
    <div class="details-head">
      <button class="icon-btn back" type="button" aria-label="Back to options">${ICONS.back}</button>
      <div class="dh-main">
        <div class="times">${formatClock(d, it.depart)} – ${formatClock(d, it.arrive)} <span class="dur">${formatDuration(it.duration)}</span></div>
        <div class="meta">${it.transfers ? `${it.transfers} transfer${it.transfers > 1 ? 's' : ''} · ` : 'No transfers · '}walk ${formatDistance(it.walkMeters)}${ctx.isNow ? ` · leave ${relative(ctx.toMs(it.depart))}` : ''}</div>
      </div>
      <button class="icon-btn share" type="button" aria-label="Share this trip">${ICONS.share}</button>
    </div>
    <ol class="steps">${steps.join('')}</ol>
    <p class="fine">Times are Central Time. ${it.realtime ? 'Live predictions come from Metro Transit and can change.' : 'Scheduled times; buses can run early or late.'}</p>
  </div>`;
}

function step(kind, time, body, cls = '', color = '') {
  return `<li class="step ${kind} ${cls}"${color ? ` style="--route:${color}"` : ''}><div class="t">${time}</div><div class="b">${body}</div></li>`;
}

/** Popup / sheet content for a stop. */
export function stopInfo(net, s, alerts) {
  const routes = net.stopRoutes[s].map((r) => routeBadge(net.routes[r])).join(' ');
  const al = (alerts?.byStop.get(String(net.stopId[s])) || []).slice(0, 3)
    .map((a) => `<div class="alert">${ICONS.alert}<span>${esc(a.header)}</span></div>`).join('');
  return `<div class="stop-info" data-stop="${s}">
    <div class="si-name">${esc(net.stopName[s])}</div>
    <div class="stopno">Stop #${esc(net.stopId[s])}${net.stopDesc[s] ? ` · ${esc(net.stopDesc[s])}` : ''}</div>
    <div class="si-routes">${routes}</div>
    ${al}
    <div class="si-actions">
      <button class="btn small" data-act="from" type="button">Start here</button>
      <button class="btn small primary" data-act="to" type="button">Go here</button>
    </div>
    <div class="deps"><div class="muted">Loading departures…</div></div>
  </div>`;
}

export function departuresList(net, deps, source) {
  if (!deps.length) return '<div class="muted">No more departures today.</div>';
  const rows = deps.slice(0, 8).map((d) => {
    const route = d.route;
    const badge = route ? routeBadge(route) : `<span class="badge">${esc(d.label)}</span>`;
    return `<li>${badge}<span class="dest">${esc(d.headsign)}</span><span class="when ${d.live ? 'is-live' : ''}">${d.live ? '<span class="live-dot"></span>' : ''}${esc(d.text)}</span></li>`;
  }).join('');
  return `<ul class="deplist">${rows}</ul><div class="fine">${source === 'live' ? 'Live from Metro Transit NexTrip' : 'Scheduled times (live data unavailable)'}</div>`;
}

export function walkStepsHtml(steps) {
  return `<ol class="wsteps">${steps.map((s) => `<li>${esc(s.text)}${s.distance > 5 ? ` <span class="muted">${formatDistance(s.distance)}</span>` : ''}</li>`).join('')}</ol>`;
}
