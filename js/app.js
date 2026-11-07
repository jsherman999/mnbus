// Gopher Bus Planner — UI controller.
/* global L */

import { Network } from './network.js';
import { Planner } from './planner.js';
import { getFeed, applyTripUpdates, getNexTrip, indexAlerts } from './realtime.js';
import { walkTable, walkRoute } from './walking.js';
import { PlaceSearch } from './search.js';
import { settings, saveSettings, savedPlaces, saveSavedPlaces, recentPlaces, addRecent } from './storage.js';
import * as R from './render.js';
import {
  nowChicago, formatClock, formatDay, toEpochMs, haversine, escapeHtml as esc, splitDate, dateStr, DAY,
  formatDuration, formatDistance,
} from './util.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const isDesktop = () => matchMedia('(min-width: 900px)').matches;

const CAMPUS_CENTER = [44.9752, -93.2340];
const AREA_LABELS = [
  ['East Bank', 44.9757, -93.2335], ['West Bank', 44.9718, -93.2447], ['Dinkytown', 44.9811, -93.2360],
  ['Stadium Village', 44.9730, -93.2228], ['Marcy-Holmes', 44.9890, -93.2420], ['Cedar-Riverside', 44.9680, -93.2503],
  ['Prospect Park', 44.9690, -93.2130], ['Como', 44.9960, -93.2180], ['Downtown', 44.9770, -93.2690],
  ['St. Paul Campus', 44.9860, -93.1845], ['Nicollet Island', 44.9870, -93.2640],
];
// Base maps that need no API key. Each entry is one or more stacked tile layers.
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, ' + OSM_ATTR;
const TILES = {
  osm: [['https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, attribution: OSM_ATTR }]],
  esri: [[`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 19, attribution: ESRI_ATTR }]],
  light: [
    [`${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, attribution: ESRI_ATTR }],
    [`${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16 }],
  ],
  dark: [
    [`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, attribution: ESRI_ATTR }],
    [`${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16 }],
  ],
  satellite: [
    [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }],
    [`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 19 }],
    [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 19 }],
  ],
};

const state = {
  net: null, planner: null, search: null, routeById: new Map(),
  from: null, to: null, mode: 'now',
  result: null, selected: null, seq: 0, rtCache: null, alerts: null,
  active: null, focusRoute: null, geocodeResults: null,
};

let map, tileLayer, routeLayer, stopLayer, itinLayer, vehLayer, labelLayer, focusLayer, placeLayer;
let routeRenderer, stopRenderer;
const routePolylines = new Map();
const markers = { from: null, to: null, me: null };

// ------------------------------------------------------------------- boot

async function boot() {
  fillIcons(document);
  initMap();
  initSheet();
  initForm();
  initDrawers();
  try {
    const [net, tt, shapes, places] = await Promise.all([
      getJson('data/network.json'), getJson('data/timetable.json'), getJson('data/shapes.json'),
      getJson('data/places.json').catch(() => ({ places: [] })),
    ]);
    state.net = new Network(net, tt, shapes);
    state.planner = new Planner(state.net);
    state.search = new PlaceSearch(state.net, places.places || []);
    state.net.routes.forEach((r) => state.routeById.set(String(r.id), r));
  } catch (err) {
    console.error(err);
    $('#boot').innerHTML = `<p><b>Couldn't load the bus schedules.</b></p><p>${esc(err.message)}</p>
      <button class="btn primary" type="button" onclick="location.reload()">Try again</button>`;
    return;
  }
  $('#boot').hidden = true;
  drawRoutes();
  buildPlaceLabels();
  buildRouteList();
  renderAbout();
  renderSavedList();
  map.on('moveend zoomend', refreshStops);
  refreshStops();
  loadAlerts();
  if (!readHash()) renderResults();
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function fillIcons(root) {
  for (const el of $$('[data-icon]', root)) if (!el.firstChild) el.innerHTML = R.ICONS[el.dataset.icon] || '';
}

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// -------------------------------------------------------------------- map

function initMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true, tapTolerance: 20, zoomSnap: 0.5, maxZoom: 20 })
    .setView(CAMPUS_CENTER, 15);
  settings.mapStyle = setTiles(settings.mapStyle);
  if (isDesktop()) L.control.zoom({ position: 'bottomright' }).addTo(map);
  routeRenderer = L.canvas({ padding: 0.5 });
  stopRenderer = L.canvas({ padding: 0.5, tolerance: 10 });
  routeLayer = L.layerGroup().addTo(map);
  focusLayer = L.layerGroup().addTo(map);
  itinLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  vehLayer = L.layerGroup().addTo(map);
  labelLayer = L.layerGroup();
  for (const [name, lat, lon] of AREA_LABELS) {
    labelLayer.addLayer(L.tooltip({ permanent: true, direction: 'center', className: 'area-label', interactive: false })
      .setLatLng([lat, lon]).setContent(esc(name)));
  }
  const updateLabels = () => {
    const z = map.getZoom();
    if (z >= 14 && z < 16) labelLayer.addTo(map); else labelLayer.remove();
  };
  map.on('zoomend', updateLabels);
  updateLabels();
  map.on('click', onMapClick);
  map.on('popupclose', () => { state.popupClosedAt = Date.now(); });
  map.on('movestart', hideMapMenu);
  // nudge the campus into the part of the screen the sheet doesn't cover
  if (!isDesktop()) map.panBy([0, Math.round(innerHeight * 0.18)], { animate: false });
}

function setTiles(style) {
  if (!TILES[style]) style = 'osm'; // also migrates the retired CARTO styles
  if (tileLayer) tileLayer.remove();
  tileLayer = L.layerGroup(TILES[style].map(([url, opts]) => L.tileLayer(url, { maxZoom: 20, ...opts }))).addTo(map);
  document.documentElement.dataset.mapStyle = style;
  return style;
}

function fitVisible(bounds, maxZoom = 17) {
  if (!bounds || !bounds.isValid()) return;
  // use the sheet's target height: it may still be animating
  const opts = isDesktop()
    ? { paddingTopLeft: [450, 80], paddingBottomRight: [40, 40] }
    : { paddingTopLeft: [24, 70], paddingBottomRight: [24, sheetPx(sheetState) + 16] };
  map.fitBounds(bounds, { ...opts, maxZoom });
}

// Dorms and main campus buildings, labelled on the map when zoomed in (any base map).
const CAMPUS_CATEGORIES = new Set(['Residence hall', 'Student life', 'Library', 'Classes', 'Recreation', 'Athletics', 'Arts', 'Health', 'Campus']);

function buildPlaceLabels() {
  placeLayer = L.layerGroup();
  for (const p of state.search.popular()) {
    if (!CAMPUS_CATEGORIES.has(p.category)) continue;
    const icon = L.divIcon({
      className: `place-label${p.category === 'Residence hall' ? ' dorm' : ''}`, iconSize: null, iconAnchor: [7, 7],
      html: `<span class="pd"></span><span class="pt">${esc(p.name)}</span>`,
    });
    L.marker([p.lat, p.lon], { icon, keyboard: false, zIndexOffset: -500, title: p.name })
      .on('click', (e) => { L.DomEvent.stop(e); onPlaceTap({ lat: p.lat, lon: p.lon, name: p.name }, e); })
      .addTo(placeLayer);
  }
  const update = () => {
    const z = map.getZoom();
    if (z < 16) { placeLayer.remove(); return; }
    placeLayer.addTo(map);
    // from z17 the base map labels buildings itself; keep only the dorm labels
    placeLayer.eachLayer((m) => m.getElement()?.classList.toggle('hidden-z', z >= 17 && !m.options.icon.options.className.includes('dorm')));
  };
  map.on('zoomend', update);
  update();
}

function onPlaceTap(pt, e) {
  hideMapMenu();
  if (!state.from) return setEndpoint('from', pt);
  if (!state.to) return setEndpoint('to', pt);
  showMapMenu(e.containerPoint || map.latLngToContainerPoint([pt.lat, pt.lon]), pt);
}

function routeVisible(r) {
  return (settings.allRoutes || r.umn) && !settings.hiddenRoutes.includes(r.id);
}

function drawRoutes() {
  routeLayer.clearLayers();
  routePolylines.clear();
  const net = state.net;
  // draw lighter local routes first, rail on top
  const order = [...net.routes].sort((a, b) => (a.type === 0) - (b.type === 0) || (b.umnRoute - a.umnRoute));
  for (const r of order) {
    if (!routeVisible(r)) continue;
    const shapes = [...new Set(r.patterns.map((p) => net.patterns[p].shape))].map((s) => net.shape(s));
    const pl = L.polyline(shapes, {
      color: r.color, weight: r.type === 0 ? 5 : 3, opacity: 0.72, renderer: routeRenderer, interactive: false,
      lineCap: 'round', lineJoin: 'round',
    });
    routePolylines.set(r.index, pl);
    routeLayer.addLayer(pl);
  }
  dimRoutes(!!state.selected || state.focusRoute !== null);
}

function dimRoutes(dim) {
  for (const [idx, pl] of routePolylines) {
    const focus = state.focusRoute === idx;
    pl.setStyle({ opacity: dim ? (focus ? 0.95 : 0.18) : 0.72 });
  }
}

function refreshStops() {
  stopLayer.clearLayers();
  const net = state.net;
  if (!net) return;
  const z = map.getZoom();
  if (z < 15.5) return;
  const b = map.getBounds().pad(0.1);
  let count = 0;
  for (let s = 0; s < net.nStops && count < 700; s++) {
    const lat = net.stopLat[s], lon = net.stopLon[s];
    if (!b.contains([lat, lon])) continue;
    const routes = net.stopRoutes[s];
    if (!settings.allRoutes && !routes.some((r) => routeVisible(net.routes[r]))) continue;
    count++;
    const mk = L.circleMarker([lat, lon], {
      renderer: stopRenderer, radius: z >= 17 ? 6 : 4.5, weight: 2, color: '#333', fillColor: '#fff', fillOpacity: 1,
    });
    mk.on('click', (e) => { L.DomEvent.stop(e); openStop(s); });
    stopLayer.addLayer(mk);
  }
}

// ----------------------------------------------------------- map clicking

function onMapClick(e) {
  // a tap that only dismisses a popup or the A/B menu shouldn't also drop a pin
  const menuWasOpen = !$('#map-menu').hidden;
  hideMapMenu();
  if (!state.net || menuWasOpen || Date.now() - (state.popupClosedAt || 0) < 400) return;
  const pt = { lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) };
  if (!state.from) return setEndpoint('from', namedPoint(pt));
  if (!state.to) return setEndpoint('to', namedPoint(pt));
  showMapMenu(e.containerPoint, pt);
}

function namedPoint(pt) {
  const near = state.search.nearestPlace(pt.lat, pt.lon, 45);
  return { ...pt, name: near ? near.name : 'Point on map', pending: !near };
}

function showMapMenu(cp, pt) {
  const menu = $('#map-menu');
  const rect = $('#map').getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(cp.x + rect.left, 110), innerWidth - 110)}px`;
  menu.style.top = `${Math.max(cp.y + rect.top, 150)}px`;
  menu.innerHTML = `<div class="mm-title">${pt.name ? esc(pt.name) : 'Use this spot as…'}</div>
    <button type="button" data-act="from"><span class="dot a">A</span>Start here</button>
    <button type="button" data-act="to"><span class="dot b">B</span>Go here</button>`;
  menu.hidden = false;
  menu.onclick = (ev) => {
    const act = ev.target.closest('button')?.dataset.act;
    if (!act) return;
    hideMapMenu();
    setEndpoint(act, pt.name ? { ...pt } : namedPoint(pt));
  };
}

function hideMapMenu() { $('#map-menu').hidden = true; }

// ------------------------------------------------------------- endpoints

function pinIcon(which) {
  const color = which === 'from' ? '#1a73e8' : '#7a0019';
  return L.divIcon({
    className: 'pin', iconSize: [34, 44], iconAnchor: [17, 42],
    html: `<svg viewBox="0 0 34 44"><path d="M17 1C8.2 1 1 8 1 16.7 1 28.5 17 43 17 43s16-14.5 16-26.3C33 8 25.8 1 17 1Z" fill="${color}" stroke="#fff" stroke-width="2"/></svg><span>${which === 'from' ? 'A' : 'B'}</span>`,
  });
}

function setEndpoint(which, pt, { plan: doPlan = true, pan = false } = {}) {
  state[which] = pt;
  const input = $(which === 'from' ? '#from-input' : '#to-input');
  if (!pt) {
    input.value = '';
    if (markers[which]) { markers[which].remove(); markers[which] = null; }
    updateSaveButtons();
    clearItinerary();
    renderResults();
    return;
  }
  input.value = pt.name;
  if (!markers[which]) {
    markers[which] = L.marker([pt.lat, pt.lon], { icon: pinIcon(which), draggable: true, keyboard: false, zIndexOffset: 1000 })
      .addTo(map)
      .on('dragend', (e) => {
        const ll = e.target.getLatLng();
        setEndpoint(which, namedPoint({ lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6) }));
      });
  } else {
    markers[which].setLatLng([pt.lat, pt.lon]);
  }
  prefetchWalks(pt);
  if (pt.pending) resolveName(which, pt);
  if (pan) map.panTo([pt.lat, pt.lon]);
  updateSaveButtons();
  if (doPlan) plan();
}

async function resolveName(which, pt) {
  try {
    const name = await state.search.reverse(pt.lat, pt.lon);
    if (name && state[which] === pt) {
      pt.name = name;
      pt.pending = false;
      $(which === 'from' ? '#from-input' : '#to-input').value = name;
      if (state.selected) renderResults();
    }
  } catch { /* keep "Point on map" */ }
}

function updateSaveButtons() {
  for (const which of ['from', 'to']) {
    const btn = $(`#${which}-save`);
    const pt = state[which];
    btn.hidden = !pt;
    btn.classList.toggle('saved', !!pt && savedPlaces.some((s) => near(s, pt)));
  }
}

const near = (a, b) => Math.abs(a.lat - b.lat) < 2e-4 && Math.abs(a.lon - b.lon) < 2e-4;

// ------------------------------------------------------------------ form

function initForm() {
  for (const which of ['from', 'to']) {
    const input = $(`#${which}-input`);
    input.addEventListener('focus', () => {
      state.active = which;
      input.select();
      showSuggestions(input.value === state[which]?.name ? '' : input.value);
      if (!isDesktop()) setSheet('full');
    });
    input.addEventListener('input', () => showSuggestions(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); pickFirstSuggestion(input.value); }
      if (e.key === 'Escape') input.blur();
    });
    input.addEventListener('search', () => { if (!input.value) { setEndpoint(which, null); showSuggestions(''); } });
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement?.closest?.('#suggest')) return;
      if (state.active === which && !$('#trip-form').contains(document.activeElement)) closeSuggestions();
    }, 200));
    $(`#${which}-save`).addEventListener('click', () => toggleSaved(which));
  }
  $('#swap').addEventListener('click', () => {
    const { from, to } = state;
    state.from = null; state.to = null;
    for (const w of ['from', 'to']) if (markers[w]) { markers[w].remove(); markers[w] = null; }
    if (to) setEndpoint('from', to, { plan: false });
    if (from) setEndpoint('to', from, { plan: false });
    plan();
  });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#when-date').addEventListener('change', () => plan());
  $('#when-time').addEventListener('change', () => plan());
  $('#suggest').addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus while tapping
  $('#suggest').addEventListener('click', onSuggestionClick);
  $('#results').addEventListener('click', onResultsClick);
  $('#btn-locate').addEventListener('click', () => locate(true));
}

function setMode(mode, { doPlan = true } = {}) {
  state.mode = mode;
  $$('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('#when-inputs').hidden = mode === 'now';
  if (mode !== 'now' && !$('#when-date').value) {
    const n = nowChicago();
    const [y, m, d] = splitDate(n.date);
    $('#when-date').value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const mins = Math.ceil((n.secs % DAY) / 300) * 5;
    $('#when-time').value = `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  if (doPlan) plan();
}

// ------------------------------------------------------------ suggestions

function savedEntries() {
  return savedPlaces.map((p) => ({ kind: 'saved', name: p.name, lat: p.lat, lon: p.lon, sub: 'Saved place', keys: [p.name.toLowerCase()] }));
}

function showSuggestions(query) {
  const box = $('#suggest');
  if (!state.search) return;
  const q = query.trim();
  let html = '';
  if (!q) {
    html += suggestionButton({ kind: 'action', act: 'locate', name: 'Use my current location', sub: 'Uses your phone’s GPS' }, R.ICONS.locate);
    if (savedPlaces.length) html += `<h3>Saved</h3>${savedEntries().map((e) => suggestionButton(e, R.ICONS.star)).join('')}`;
    if (recentPlaces.length) html += `<h3>Recent</h3>${recentPlaces.slice(0, 5).map((p) => suggestionButton({ kind: 'recent', ...p, sub: 'Recent' }, R.ICONS.clock)).join('')}`;
    const pop = state.search.popular();
    const cats = ['Residence hall', 'Student life', 'Classes', 'Library', 'Recreation', 'Athletics', 'Neighborhood', 'Downtown', 'Shopping', 'Travel'];
    pop.sort((a, b) => cats.indexOf(a.category) - cats.indexOf(b.category));
    html += `<h3>Popular places</h3>${pop.map((e) => suggestionButton(e, R.ICONS.pin)).join('')}`;
  } else {
    const hits = state.search.search(q, 10, savedEntries());
    html += hits.map((e) => suggestionButton(e, e.kind === 'stop' ? R.ICONS.bus : e.kind === 'saved' ? R.ICONS.star : R.ICONS.pin)).join('');
    if (state.geocodeResults?.query === q) {
      html += state.geocodeResults.items.length
        ? `<h3>Addresses & places</h3>${state.geocodeResults.items.map((e) => suggestionButton(e, R.ICONS.pin)).join('')}`
        : '<div class="muted" style="padding:8px">No addresses found.</div>';
    } else {
      html += suggestionButton({ kind: 'action', act: 'geocode', name: `Search addresses for “${q}”`, sub: 'OpenStreetMap search', q }, R.ICONS.pin);
    }
  }
  box.innerHTML = html;
  box.hidden = false;
  $('#results').hidden = true;
}

function suggestionButton(e, icon) {
  const data = encodeURIComponent(JSON.stringify({ kind: e.kind, act: e.act, name: e.name, lat: e.lat, lon: e.lon, q: e.q }));
  return `<button class="sug ${e.kind === 'action' ? 'action' : ''}" type="button" data-e="${data}">
    <span class="sico">${icon}</span><span class="stext"><div class="sname">${esc(e.name)}</div>${e.sub ? `<div class="ssub">${esc(e.sub)}</div>` : ''}</span></button>`;
}

async function onSuggestionClick(ev) {
  const btn = ev.target.closest('.sug');
  if (!btn) return;
  const e = JSON.parse(decodeURIComponent(btn.dataset.e));
  const which = state.active || (state.from ? 'to' : 'from');
  if (e.act === 'locate') { closeSuggestions(); return locate(false, which); }
  if (e.act === 'geocode') return geocode(e.q);
  choosePlace(which, { lat: e.lat, lon: e.lon, name: e.name });
}

function choosePlace(which, pt) {
  addRecent(pt);
  closeSuggestions();
  $(`#${which}-input`).blur();
  setEndpoint(which, pt, { pan: !(state.from && state.to) });
}

async function geocode(q) {
  const box = $('#suggest');
  const note = document.createElement('div');
  note.className = 'muted';
  note.style.padding = '8px';
  note.innerHTML = '<span class="inline-spin"></span> Searching…';
  box.appendChild(note);
  try {
    const items = await state.search.geocode(q);
    state.geocodeResults = { query: q, items };
  } catch {
    state.geocodeResults = { query: q, items: [] };
    toast('Address search is unavailable right now.');
  }
  const input = $(`#${state.active || 'from'}-input`);
  if (input.value.trim() === q) showSuggestions(q);
}

function pickFirstSuggestion(q) {
  const first = $('#suggest .sug');
  if (first) first.click();
  else if (q.trim()) geocode(q.trim());
}

function closeSuggestions() {
  $('#suggest').hidden = true;
  $('#results').hidden = false;
  state.active = null;
  // restore the endpoint names if the user typed but didn't pick anything
  for (const w of ['from', 'to']) if (state[w]) $(`#${w}-input`).value = state[w].name;
  if (!isDesktop() && sheetState === 'full') setSheet(state.result ? 'half' : 'peek');
}

function toggleSaved(which) {
  const pt = state[which];
  if (!pt) return;
  const i = savedPlaces.findIndex((s) => near(s, pt));
  if (i >= 0) {
    savedPlaces.splice(i, 1);
    toast('Removed from saved places');
  } else {
    const name = prompt('Save this place as (e.g. "My dorm", "Chem lab"):', pt.name === 'Point on map' ? '' : pt.name);
    if (!name) return;
    savedPlaces.push({ name: name.trim(), lat: pt.lat, lon: pt.lon });
    pt.name = name.trim();
    $(`#${which}-input`).value = pt.name;
    toast('Saved. It will show up first when you search.');
  }
  saveSavedPlaces();
  updateSaveButtons();
  renderSavedList();
}

// -------------------------------------------------------------- location

function locate(fromButton, which = null) {
  if (!navigator.geolocation) return toast('Location is not available on this device.');
  toast('Finding your location…', 8000);
  navigator.geolocation.getCurrentPosition((pos) => {
    const pt = { lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6), name: 'My location' };
    $('#toast').hidden = true;
    const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    if (markers.me) markers.me.setLatLng([pt.lat, pt.lon]); else markers.me = L.marker([pt.lat, pt.lon], { icon, interactive: false }).addTo(map);
    const target = which || (fromButton && state.from && state.to ? null : fromButton ? (state.from ? (state.to ? null : 'to') : 'from') : 'from');
    if (fromButton && !which) {
      map.setView([pt.lat, pt.lon], Math.max(map.getZoom(), 16));
      if (!state.from) setEndpoint('from', pt);
      return;
    }
    if (target) setEndpoint(target, pt, { pan: true });
  }, (err) => {
    toast(err.code === 1 ? 'Location permission was denied. You can tap the map instead.' : 'Couldn’t get your location.');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

// ------------------------------------------------------------------ plan

function queryTime() {
  if (state.mode === 'now') return nowChicago();
  const dv = $('#when-date').value, tv = $('#when-time').value;
  if (!dv || !tv) return nowChicago();
  const [y, m, d] = dv.split('-').map(Number);
  const [h, mi] = tv.split(':').map(Number);
  return { date: dateStr(y, m, d), secs: h * 3600 + mi * 60 };
}

async function liveTimetable(date) {
  const feed = await withTimeout(getFeed('tripUpdates', 30000), 6000);
  if (!feed.timestamp || Date.now() / 1000 - feed.timestamp > 900) throw new Error('stale real-time feed');
  const c = state.rtCache;
  if (c && c.ts === feed.timestamp && c.date === date) return c.ct;
  const ct = applyTripUpdates(state.net, state.net.compile(date), feed);
  state.rtCache = { ts: feed.timestamp, date, ct };
  return ct;
}

function walkCandidates(pt) {
  const net = state.net;
  let list = net.stopsNear(pt.lat, pt.lon, settings.maxWalk);
  if (list.length < 3) list = net.nearestStops(pt.lat, pt.lon, 3, 3000);
  return list.slice(0, 50).map(({ stop }) => ({ stop, lat: net.stopLat[stop], lon: net.stopLon[stop] }));
}

/** Start fetching real walking distances for a point before the trip is planned. */
function prefetchWalks(pt) {
  if (state.net && pt) walkTable(pt, walkCandidates(pt)).catch(() => {});
}

async function walkDistances(from, to) {
  const [a, b, direct] = await Promise.all([
    walkTable(from, walkCandidates(from)),
    walkTable(to, walkCandidates(to)),
    walkRoute(from, to).then((r) => r.distance).catch(() => undefined),
  ]);
  return { from: a, to: b, direct };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function plan({ quiet = false } = {}) {
  if (!state.net) return;
  if (!state.from || !state.to) {
    state.result = null;
    state.selected = null;
    clearItinerary();
    renderResults();
    updateHash();
    return;
  }
  const seq = ++state.seq;
  const { date, secs } = queryTime();
  const isNow = state.mode === 'now';
  if (!quiet) {
    $('#results').innerHTML = '<div class="status-line"><span class="inline-spin"></span> Finding the best buses…</div>';
    if (!isDesktop() && sheetState === 'peek') setSheet('half');
  }
  const from = { ...state.from }, to = { ...state.to };
  const [rt, walks] = await Promise.all([
    isNow && settings.live ? liveTimetable(date).catch((e) => { console.warn('live data', e); return null; }) : null,
    withTimeout(walkDistances(from, to), 5000).catch((e) => { console.warn('walking router', e); return null; }),
  ]);
  if (seq !== state.seq) return;
  let res;
  try {
    res = state.planner.plan({
      from, to, date, secs, mode: state.mode === 'arrive' ? 'arrive' : 'depart', timetable: rt || undefined,
      walkDistances: walks || undefined,
    }, { walkSpeed: settings.walkSpeed, maxWalk: settings.maxWalk, transferSlack: settings.transferSlack });
  } catch (err) {
    console.error(err);
    $('#results').innerHTML = `<div class="warn-box">Something went wrong while planning: ${esc(err.message)}</div>`;
    return;
  }
  const prevSig = state.selected?.it?.signature;
  state.result = { ...res, date, secs, mode: state.mode, isNow, live: !!rt, walks: !!walks, at: Date.now() };
  if (state.selected) {
    const i = res.itineraries.findIndex((it) => it.signature === prevSig);
    if (state.selected.walk) state.selected = { walk: true };
    else if (i >= 0) state.selected = { i, it: res.itineraries[i] };
    else { state.selected = null; if (quiet) toast('Trip options updated'); }
  }
  renderResults();
  if (state.selected) drawSelection(false);
  else drawPreview();
  updateHash();
}

function tick(force = false) {
  const r = state.result;
  if (!r || document.hidden) return;
  if (r.isNow && (force || Date.now() - r.at > 55000)) plan({ quiet: true });
  if (state.selected?.it && r.isNow) refreshVehicles();
}

// -------------------------------------------------------------- results

function ctxForRender() {
  const r = state.result;
  return {
    isNow: r?.isNow, toMs: (secs) => toEpochMs(r.date, secs), alerts: state.alerts,
    startSlack: 60,
  };
}

function renderResults() {
  const box = $('#results');
  const r = state.result;
  if (!state.net) return;
  $('#sheet').dataset.view = 'list';
  if (!state.from || !state.to) {
    box.innerHTML = `<div class="hint"><b>Plan a trip</b><ol>
      <li>Tap the map where you're starting (<b>A</b>), then where you're going (<b>B</b>).</li>
      <li>Or search a building, dorm, stop number or address above.</li>
      <li>Drag the pins to adjust. Pick "Depart at" or "Arrive by" to plan ahead.</li></ol></div>
      ${quickPicks()}`;
    return;
  }
  if (!r) return;
  $('#sheet').dataset.view = state.selected ? 'details' : 'list';
  if (state.selected) return renderDetails();

  const net = state.net;
  const ctx = ctxForRender();
  const feed = net.meta.feed;
  let html = '';
  const when = r.isNow ? 'Leaving now' : `${r.mode === 'arrive' ? 'Arrive by' : 'Depart at'} ${formatClock(r.date, r.secs)}, ${formatDay(r.date, r.secs)}`;
  const liveNote = r.isNow ? (r.live ? '<span class="live-dot"></span>live times' : settings.live ? 'live data unavailable — scheduled times' : 'scheduled times') : 'scheduled times';
  html += `<div class="status-line"><span>${esc(when)} · ${liveNote}</span><button class="btn small" data-act="refresh" type="button">${R.ICONS.refresh}</button></div>`;
  if (feed.end && r.date > feed.end) {
    html += `<div class="warn-box">Metro Transit has only published schedules through ${formatDay(feed.end)}. Results for later dates may be missing or wrong.</div>`;
  } else if (!net.hasService(r.date)) {
    html += '<div class="warn-box">No scheduled service was found on this date.</div>';
  }
  const its = r.itineraries;
  const walkMin = r.walkOnly.secs / 60;
  const fastest = its.length ? Math.min(...its.map((i) => i.arrive)) : Infinity;
  const walkArrive = r.secs + r.walkOnly.secs;
  const walkFirst = walkMin <= 12 || (r.mode !== 'arrive' && walkArrive <= fastest);
  const walkCard = walkMin <= 45 || !its.length
    ? R.walkOnlyCard(r.walkOnly, { arrival: r.mode === 'arrive' ? '' : formatClock(r.date, walkArrive) }) : '';
  if (walkFirst && walkCard) html += walkCard;
  if (its.length) {
    html += its.map((it, i) => R.itineraryCard(net, it, i, ctx)).join('');
  } else {
    html += `<div class="empty"><b>No bus or train trip found.</b>Try a different time, or allow a longer walk to the stop in Settings.</div>`;
  }
  if (!walkFirst && walkCard) html += walkCard;
  html += `<p class="fine">Tap an option for step-by-step directions. Times are Central Time.</p>`;
  box.innerHTML = html;
}

function quickPicks() {
  if (!state.search) return '';
  const pop = state.search.popular().filter((p) => ['Residence hall', 'Student life', 'Neighborhood', 'Downtown', 'Travel', 'Shopping'].includes(p.category)).slice(0, 14);
  return `<div class="suggest-title muted" style="font-size:13px;margin:10px 2px 4px">Popular places</div>
    <div class="chips-row">${pop.map((p) => `<button class="qchip" type="button" data-qp="${encodeURIComponent(JSON.stringify({ name: p.name, lat: p.lat, lon: p.lon }))}">${esc(p.name.replace(/ \(.*\)$/, ''))}</button>`).join('')}</div>`;
}

function onResultsClick(ev) {
  const qp = ev.target.closest('[data-qp]');
  if (qp) {
    const p = JSON.parse(decodeURIComponent(qp.dataset.qp));
    return choosePlace(state.from ? 'to' : 'from', p);
  }
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'refresh') return plan();
  const card = ev.target.closest('.card');
  if (card) {
    if (card.dataset.walk) state.selected = { walk: true };
    else {
      const i = +card.dataset.i;
      state.selected = { i, it: state.result.itineraries[i] };
    }
    renderResults();
    drawSelection(true);
    $('#sheet-scroll').scrollTop = 0;
    return;
  }
  if (ev.target.closest('.back')) {
    state.selected = null;
    renderResults();
    drawPreview();
    return;
  }
  if (ev.target.closest('.share')) return share();
  const wd = ev.target.closest('.walk-dir');
  if (wd) return toggleWalkSteps(+wd.dataset.leg);
}

function renderDetails() {
  const box = $('#results');
  const sel = state.selected;
  const r = state.result;
  if (sel.walk) {
    const w = r.walkOnly;
    box.innerHTML = `<div class="details"><div class="details-head">
      <button class="icon-btn back" type="button" aria-label="Back to options">${R.ICONS.back}</button>
      <div class="dh-main"><div class="times">Walk ${formatDuration(w.secs)}</div><div class="meta">${formatDistance(w.meters)} to ${esc(state.to.name)}</div></div>
      <button class="icon-btn share" type="button" aria-label="Share">${R.ICONS.share}</button></div>
      <div class="walk-steps" data-leg="-1"><div class="muted"><span class="inline-spin"></span> Loading walking directions…</div></div></div>`;
    walkRoute(state.from, state.to).then((wr) => {
      const el = $('.walk-steps[data-leg="-1"]');
      if (el) el.innerHTML = R.walkStepsHtml(wr.steps);
    }).catch(() => {
      const el = $('.walk-steps[data-leg="-1"]');
      if (el) el.innerHTML = '<div class="muted">Walking directions are unavailable right now. The dashed line on the map shows the general direction.</div>';
    });
    return;
  }
  box.innerHTML = R.itineraryDetails(state.net, sel.it, ctxForRender());
}

async function toggleWalkSteps(idx) {
  const el = $(`.walk-steps[data-leg="${idx}"]`);
  if (!el) return;
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<div class="muted"><span class="inline-spin"></span> Loading…</div>';
  const leg = state.selected.it.legs[idx];
  try {
    const wr = await walkRoute(leg.from, leg.to);
    el.innerHTML = R.walkStepsHtml(wr.steps);
  } catch {
    el.innerHTML = '<div class="muted">Walking directions are unavailable right now.</div>';
  }
}

async function share() {
  updateHash();
  const url = location.href;
  const title = `Bus trip to ${state.to?.name || 'destination'}`;
  try {
    if (navigator.share) await navigator.share({ title, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
}

// ------------------------------------------------------- itinerary on map

function clearItinerary() {
  itinLayer.clearLayers();
  vehLayer.clearLayers();
  dimRoutes(state.focusRoute !== null);
}

function drawPreview() {
  // show the first option faintly so the map explains the list
  clearItinerary();
  const it = state.result?.itineraries?.[0];
  if (it) drawItinerary(it, { faint: true });
  const b = L.latLngBounds([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]]);
  if (it) for (const l of it.legs) b.extend([l.from.lat, l.from.lon]);
  fitVisible(b, 16);
}

function drawSelection(fit) {
  clearItinerary();
  const sel = state.selected;
  if (sel.walk) {
    const line = L.polyline([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]], { color: '#555', weight: 5, dashArray: '2 10', lineCap: 'round' }).addTo(itinLayer);
    walkRoute(state.from, state.to).then((wr) => line.setLatLngs(wr.coords)).catch(() => {});
    if (fit) fitVisible(line.getBounds());
    dimRoutes(true);
    return;
  }
  const bounds = drawItinerary(sel.it, {});
  dimRoutes(true);
  if (fit) fitVisible(bounds);
  if (state.result.isNow) refreshVehicles();
}

function drawItinerary(it, { faint = false }) {
  const net = state.net;
  const bounds = L.latLngBounds([]);
  for (const l of it.legs) {
    if (l.type === 'walk') {
      if (l.meters < 15) continue;
      const line = L.polyline([[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]], {
        color: faint ? '#777' : '#444', weight: faint ? 3 : 5, opacity: faint ? 0.6 : 0.9, dashArray: '1 9', lineCap: 'round',
      }).addTo(itinLayer);
      bounds.extend(line.getBounds());
      if (!faint) walkRoute(l.from, l.to).then((wr) => line.setLatLngs(wr.coords)).catch(() => {});
    } else {
      const route = net.routes[l.route];
      const path = net.patternPath(l.pattern, l.board, l.alight);
      if (!faint) L.polyline(path, { color: '#fff', weight: 10, opacity: 0.9 }).addTo(itinLayer);
      const line = L.polyline(path, { color: route.color, weight: faint ? 5 : 7, opacity: faint ? 0.55 : 1 }).addTo(itinLayer);
      bounds.extend(line.getBounds());
      if (!faint) {
        for (const pt of [l.from, l.to]) {
          L.circleMarker([pt.lat, pt.lon], { radius: 7, color: route.color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(`${esc(pt.name)} (#${esc(net.stopId[pt.stop])})`, { direction: 'top', offset: [0, -6] })
            .on('click', (e) => { L.DomEvent.stop(e); openStop(pt.stop); })
            .addTo(itinLayer);
        }
      }
    }
  }
  return bounds;
}

// -------------------------------------------------------------- vehicles

async function refreshVehicles() {
  const showAll = $('#live-vehicles').checked;
  const mine = new Map();
  if (state.selected?.it && state.result?.isNow) {
    for (const l of state.selected.it.legs) if (l.type === 'ride') mine.set(String(l.tripId), l);
  }
  if (!showAll && !mine.size) { vehLayer.clearLayers(); return; }
  let feed;
  try { feed = await getFeed('vehicles', 15000); } catch { return; }
  vehLayer.clearLayers();
  const nowS = Date.now() / 1000;
  for (const v of feed.vehicles) {
    if (!v.lat || !v.trip || nowS - v.timestamp > 600) continue;
    const route = state.routeById.get(String(v.trip.routeId));
    const leg = mine.get(String(v.trip.tripId));
    if (!leg && !(showAll && route && routeVisible(route))) continue;
    const color = route ? route.color : '#555';
    const label = route ? route.label : v.trip.routeId;
    const icon = L.divIcon({
      className: '', iconSize: leg ? [32, 32] : [26, 26], iconAnchor: leg ? [16, 16] : [13, 13],
      html: `<div class="veh ${leg ? 'mine' : ''}" style="background:${color};color:${color}">${v.bearing != null ? `<i style="transform:rotate(${Math.round(v.bearing)}deg)"></i>` : ''}<span style="color:#fff">${esc(label)}</span></div>`,
    });
    const age = Math.max(0, Math.round((nowS - v.timestamp) / 60));
    const mk = L.marker([v.lat, v.lon], { icon, zIndexOffset: leg ? 2000 : 500, keyboard: false })
      .bindTooltip(`${leg ? 'Your ' : ''}${route && R.isRail(route) ? 'train' : 'bus'} ${esc(label)}${v.label ? ` · vehicle ${esc(v.label)}` : ''} · updated ${age ? `${age} min` : 'just now'}`);
    vehLayer.addLayer(mk);
  }
}

// ---------------------------------------------------------------- stops

function openStop(s) {
  const net = state.net;
  if (!isDesktop() && sheetState !== 'peek') setSheet('peek');
  const popup = L.popup({ maxWidth: 320, minWidth: 250, autoPanPaddingBottomRight: [20, (isDesktop() ? 0 : sheetPx('peek')) + 20], autoPanPaddingTopLeft: [isDesktop() ? 440 : 20, 70] })
    .setLatLng([net.stopLat[s], net.stopLon[s]]);
  // a DOM node (not a string) so popup.update() keeps the departures we add later
  const el = document.createElement('div');
  el.innerHTML = R.stopInfo(net, s, state.alerts);
  popup.setContent(el).openOn(map);
  el.querySelector('.si-actions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    map.closePopup();
    setEndpoint(act, { lat: net.stopLat[s], lon: net.stopLon[s], name: net.stopName[s] });
  });
  loadDepartures(s, el.querySelector('.deps'), popup);
}

async function loadDepartures(s, box, popup) {
  const net = state.net;
  try {
    const nt = await getNexTrip(net.stopId[s]);
    const deps = (nt.departures || []).map((d) => ({
      route: state.routeById.get(String(d.route_id)), label: d.route_short_name || d.route_id,
      headsign: d.description || d.terminal || '', text: d.departure_text, live: !!d.actual,
    }));
    const alerts = (nt.alerts || []).map((a) => `<div class="alert">${R.ICONS.alert}<span>${esc(a.alert_text)}</span></div>`).join('');
    box.innerHTML = alerts + R.departuresList(net, deps, 'live');
  } catch {
    box.innerHTML = R.departuresList(net, scheduledDepartures(s), 'schedule');
  }
  popup.update();
}

function scheduledDepartures(s) {
  const net = state.net;
  const now = nowChicago();
  const ct = net.compile(now.date);
  const out = [];
  const sp = net.stopPatterns[s];
  for (let x = 0; x < sp.length; x += 2) {
    const p = sp[x], pos = sp[x + 1];
    const cp = ct.patterns[p];
    if (pos === cp.n - 1) continue; // last stop: drop-off only
    for (let j = 0; j < cp.nTrips; j++) {
      const t = cp.dep[j * cp.n + pos];
      if (t >= now.secs - 60 && t < now.secs + 3 * 3600) {
        const pat = net.patterns[p];
        out.push({ t, route: net.routes[pat.route], headsign: pat.towards });
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(0, 8).map((d) => ({ ...d, text: d.t - now.secs < 3600 ? `${Math.max(0, Math.round((d.t - now.secs) / 60))} Min` : formatClock(now.date, d.t), live: false }));
}

// --------------------------------------------------------------- alerts

async function loadAlerts() {
  try {
    const feed = await getFeed('alerts', 300000);
    state.alerts = indexAlerts(feed);
    buildRouteList();
  } catch { /* alerts are optional */ }
}

// ---------------------------------------------------------------- drawers

function initDrawers() {
  $('#btn-routes').addEventListener('click', () => openDrawer('#routes-panel'));
  $('#btn-settings').addEventListener('click', () => openDrawer('#settings-panel'));
  $$('.drawer [data-close]').forEach((b) => b.addEventListener('click', () => closeDrawers()));
  $('#route-filter').addEventListener('input', buildRouteList);
  $('#all-routes').checked = settings.allRoutes;
  $('#all-routes').addEventListener('change', (e) => {
    settings.allRoutes = e.target.checked;
    saveSettings();
    drawRoutes(); buildRouteList(); refreshStops();
  });
  $('#live-vehicles').addEventListener('change', (e) => {
    refreshVehicles();
    clearInterval(state.vehTimer);
    if (e.target.checked) state.vehTimer = setInterval(refreshVehicles, 20000);
  });
  $('#routes-show-all').addEventListener('click', () => { settings.hiddenRoutes = []; saveSettings(); drawRoutes(); buildRouteList(); refreshStops(); });
  $('#routes-hide-all').addEventListener('click', () => {
    settings.hiddenRoutes = state.net.routes.map((r) => r.id);
    saveSettings(); drawRoutes(); buildRouteList(); refreshStops();
  });
  $('#route-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-route]');
    if (!cb) return;
    const id = cb.dataset.route;
    settings.hiddenRoutes = settings.hiddenRoutes.filter((x) => x !== id);
    if (!cb.checked) settings.hiddenRoutes.push(id);
    saveSettings(); drawRoutes(); refreshStops();
  });
  $('#route-list').addEventListener('click', (e) => {
    const b = e.target.closest('.rinfo');
    if (b) focusRoute(+b.dataset.index);
  });

  const bindSelect = (sel, key, parse = Number) => {
    const el = $(sel);
    el.value = String(settings[key]);
    el.addEventListener('change', () => { settings[key] = parse(el.value); saveSettings(); if (key === 'mapStyle') setTiles(settings.mapStyle); else plan(); });
  };
  bindSelect('#set-speed', 'walkSpeed');
  bindSelect('#set-walk', 'maxWalk');
  bindSelect('#set-transfer', 'transferSlack');
  bindSelect('#set-map', 'mapStyle', String);
  $('#set-live').checked = settings.live;
  $('#set-live').addEventListener('change', (e) => { settings.live = e.target.checked; saveSettings(); plan(); });
  $('#saved-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    savedPlaces.splice(+b.dataset.del, 1);
    saveSavedPlaces(); renderSavedList(); updateSaveButtons();
  });
}

function openDrawer(sel) {
  closeDrawers();
  $(sel).hidden = false;
}

function closeDrawers() {
  $$('.drawer').forEach((d) => { d.hidden = true; });
}

function routeGroup(r) {
  if (r.umnRoute) return 0;
  if (r.type === 0 || /^9\d\d$/.test(r.id)) return 1;
  if (r.umn) return 2;
  return 3;
}
const GROUP_NAMES = ['U of M campus buses (free)', 'METRO light rail & rapid bus lines', 'Buses serving the U of M area', 'Other Metro Transit routes'];

function buildRouteList() {
  const net = state.net;
  if (!net) return;
  const q = $('#route-filter').value.trim().toLowerCase();
  const groups = [[], [], [], []];
  for (const r of net.routes) {
    if (!settings.allRoutes && !r.umn) continue;
    const text = `${r.label} ${r.name} ${r.desc}`.toLowerCase();
    if (q && !text.includes(q)) continue;
    groups[routeGroup(r)].push(r);
  }
  $('#route-list').innerHTML = groups.map((list, g) => (list.length ? `<div class="route-group"><h3>${GROUP_NAMES[g]}</h3>${list.map((r) => {
    const alerts = state.alerts?.byRoute.get(r.id)?.length;
    return `<div class="route-row">
      <input type="checkbox" data-route="${esc(r.id)}" ${settings.hiddenRoutes.includes(r.id) ? '' : 'checked'} aria-label="Show ${esc(R.routeTitle(r))} on map">
      <span class="swatch" style="background:${r.color}"></span>
      <button class="rinfo" type="button" data-index="${r.index}">
        <div class="rname">${R.routeBadge(r)} ${esc(R.routeTitle(r))}${alerts ? `<span class="ralert" title="Service alert">${R.ICONS.alert}</span>` : ''}</div>
        <div class="rdesc">${esc(R.routeSubtitle(r))}</div>
      </button></div>`;
  }).join('')}</div>` : '')).join('') || '<p class="muted" style="padding:16px">No routes match.</p>';
}

function focusRoute(index) {
  const net = state.net;
  const r = net.routes[index];
  closeDrawers();
  map.closePopup();
  state.focusRoute = index;
  if (settings.hiddenRoutes.includes(r.id) || !routeVisible(r)) {
    settings.hiddenRoutes = settings.hiddenRoutes.filter((x) => x !== r.id);
    if (!r.umn && !settings.allRoutes) { settings.allRoutes = true; $('#all-routes').checked = true; }
    saveSettings();
  }
  drawRoutes();
  focusLayer.clearLayers();
  const stops = new Set();
  for (const p of r.patterns) for (const s of net.patterns[p].stops) stops.add(s);
  const bounds = L.latLngBounds([]);
  for (const s of stops) {
    bounds.extend([net.stopLat[s], net.stopLon[s]]);
    L.circleMarker([net.stopLat[s], net.stopLon[s]], { renderer: stopRenderer, radius: 5, color: r.color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .on('click', (e) => { L.DomEvent.stop(e); openStop(s); })
      .addTo(focusLayer);
  }
  if (!isDesktop()) setSheet('peek');
  fitVisible(bounds, 15);
  const alerts = (state.alerts?.byRoute.get(r.id) || []).map((a) => `<div class="alert">${R.ICONS.alert}<span>${esc(a.header)}</span></div>`).join('');
  const heads = [...new Set(r.patterns.map((p) => net.patterns[p].headsign).filter(Boolean))].slice(0, 6);
  const box = document.createElement('div');
  box.className = 'hint route-focus';
  box.innerHTML = `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
      <div>${R.routeBadge(r)} <b>${esc(R.routeTitle(r))}</b></div>
      <button class="btn small" type="button" data-unfocus>Done</button></div>
    <div class="muted" style="margin-top:4px">${esc(R.routeSubtitle(r))}</div>
    ${heads.length ? `<div style="margin-top:6px;font-size:13px">Toward: ${heads.map(esc).join(' · ')}</div>` : ''}
    ${alerts}
    <div class="fine">Tap a stop on the map to see its next departures.</div>`;
  $$('.route-focus').forEach((el) => el.remove());
  $('#results').prepend(box);
  box.querySelector('[data-unfocus]').addEventListener('click', () => {
    state.focusRoute = null;
    focusLayer.clearLayers();
    box.remove();
    drawRoutes();
  });
}

function renderSavedList() {
  const el = $('#saved-list');
  el.innerHTML = savedPlaces.length
    ? `<div class="field">Saved places</div>${savedPlaces.map((p, i) => `<div class="saved-row"><span>${esc(p.name)}</span><button class="btn small" type="button" data-del="${i}">Remove</button></div>`).join('')}`
    : '<div class="muted" style="font-size:14px">Tip: tap the star next to a place to save it (your dorm, classes, work).</div>';
}

function renderAbout() {
  const net = state.net;
  const f = net.meta.feed;
  const gen = new Date(net.meta.generated);
  $('#about').innerHTML = `
    <h3>About</h3>
    <p>Plans trips on every Metro Transit bus and train, including the free U of M campus buses (120–125), using Metro Transit's official schedule plus live arrival predictions.</p>
    <p><b>Schedules:</b> ${f.start ? formatDay(f.start) : '?'} – ${f.end ? formatDay(f.end) : '?'} · updated ${gen.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}<br>
    ${net.routes.length} routes · ${net.nStops.toLocaleString()} stops</p>
    <h3>Tips</h3>
    <p>Students ride Metro Transit with a U-Pass (or pay the fare). Campus Connector and circulators are free. Stop numbers are printed on each bus stop sign — search "#13209" to find one.</p>
    <p>Real-time predictions can change; leave a couple of minutes early, especially in winter.</p>
    <h3>Data</h3>
    <p>Schedules and live data: <a href="https://svc.metrotransit.org/" target="_blank" rel="noopener">Metro Transit</a>. Map: © OpenStreetMap contributors, © CARTO. Walking routes: FOSSGIS OSRM. Search: OpenStreetMap Nominatim.</p>
    <p>Not affiliated with Metro Transit or the University of Minnesota. <a href="https://github.com/jsherman999/mnbus" target="_blank" rel="noopener">Source on GitHub</a></p>`;
}

// ------------------------------------------------------------- the sheet

let sheetState = 'half';

function sheetPx(s) {
  const formH = $('#trip-form').getBoundingClientRect().height;
  const top = 56 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0);
  if (s === 'peek') return Math.round(formH + 22 + 64);
  if (s === 'full') return Math.round(innerHeight - top);
  return Math.round(Math.max(innerHeight * 0.5, formH + 140));
}

function setSheet(s) {
  sheetState = s;
  const el = $('#sheet');
  el.dataset.state = s;
  if (isDesktop()) {
    document.documentElement.style.setProperty('--sheet-h', '0px');
    return;
  }
  const h = sheetPx(s);
  el.style.height = `${h}px`;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}

function initSheet() {
  const el = $('#sheet');
  const handle = $('#sheet-handle');
  let startY = 0, startH = 0, dragging = false, moved = false, lastY = 0, lastT = 0, vel = 0;
  const onDown = (e) => {
    if (isDesktop()) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now();
    startH = el.getBoundingClientRect().height;
    el.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const now = performance.now();
    vel = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY; lastT = now;
    const h = Math.min(sheetPx('full'), Math.max(sheetPx('peek') - 40, startH - dy));
    el.style.height = `${h}px`;
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    if (!moved) { setSheet(sheetState === 'peek' ? 'half' : sheetState === 'half' ? 'full' : 'half'); return; }
    const h = el.getBoundingClientRect().height;
    const opts = ['peek', 'half', 'full'].map((s) => [s, sheetPx(s)]);
    let target;
    if (vel > 0.6) target = h > sheetPx('half') ? 'half' : 'peek';
    else if (vel < -0.6) target = h < sheetPx('half') ? 'half' : 'full';
    else target = opts.reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
    setSheet(target);
  };
  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheetState === 'full' ? 'half' : 'full'); }
  });
  addEventListener('resize', () => setSheet(sheetState));
  setSheet('peek');
  requestAnimationFrame(() => setSheet('peek'));
}

// ---------------------------------------------------------------- URL hash

function fmtPt(p) {
  return `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${encodeURIComponent(p.name || '')}`;
}

function parsePt(s) {
  if (!s) return null;
  const [lat, lon, ...rest] = s.split(',');
  if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) return null;
  return { lat: +lat, lon: +lon, name: decodeURIComponent(rest.join(',')) || 'Point on map' };
}

function updateHash() {
  const parts = [];
  if (state.from) parts.push(`from=${fmtPt(state.from)}`);
  if (state.to) parts.push(`to=${fmtPt(state.to)}`);
  if (state.mode !== 'now') {
    const { date, secs } = queryTime();
    parts.push(`${state.mode}=${date}T${String(Math.floor(secs / 3600)).padStart(2, '0')}${String(Math.floor(secs / 60) % 60).padStart(2, '0')}`);
  }
  const h = parts.length ? `#${parts.join('&')}` : ' ';
  history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const from = parsePt(params.get('from')), to = parsePt(params.get('to'));
  for (const mode of ['depart', 'arrive']) {
    const v = params.get(mode);
    if (v && /^\d{8}T\d{4}$/.test(v)) {
      $('#when-date').value = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
      $('#when-time').value = `${v.slice(9, 11)}:${v.slice(11, 13)}`;
      setMode(mode, { doPlan: false });
    }
  }
  if (from) setEndpoint('from', from, { plan: false });
  if (to) setEndpoint('to', to, { plan: false });
  if (from && to) { plan(); return true; }
  if (from || to) map.setView([(from || to).lat, (from || to).lon], 16);
  return false;
}

boot();

// expose for debugging in the console
window.gopher = { state, plan, haversine, openStop, get map() { return map; } };
