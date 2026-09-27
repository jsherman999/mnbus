# Gopher Bus Planner

A phone-friendly bus and light-rail trip planner for the **University of Minnesota – Twin Cities** campus, hosted for free on GitHub Pages.

**Open the app: https://jsherman999.github.io/mnbus/**

Tap where you are (A) and where you're going (B) on the map, or search for a dorm, building, stop number or address. The planner tells you exactly:

- when to leave and which way to walk (with turn-by-turn walking directions),
- which stop to wait at (name, stop number and which side of the street), and what time to be there,
- which bus or train to board, in which direction, and whether it's running late (live predictions),
- how many stops to ride, when to pull the cord, and where to get off,
- where to transfer and how long you'll wait,
- and when you'll arrive.

Choose **Leave now** (uses live Metro Transit predictions), **Depart at**, or **Arrive by** any future date and time.

## Features

- **All routes in and around campus**: the free U of M campus buses (120 East Bank Circulator, 121 Campus Connector, 122 University Ave Circulator, 123 4th St Circulator, 124 St. Paul Circulator, 125 Dinkytown Circulator), the METRO Green/Blue Lines and rapid bus lines, and every Metro Transit bus, so trips to downtown, the airport or Mall of America work too.
- **Tap-to-plan map**, with draggable A/B pins, an "Use my location" button and area labels (East Bank, West Bank, Dinkytown, Stadium Village, St. Paul campus…).
- **Several options**: the next few departures, marked *Fastest*, *Fewest transfers* or *Least walking*, plus a walk-the-whole-way option when that's quicker.
- **Live data**: real-time arrival predictions, live bus and train positions on the map, and service alerts (detours, stop closures, trains replaced by buses).
- **Stop departure boards**: zoom in and tap any stop to see its next departures.
- **Route explorer**: list, filter, show or hide routes and highlight one with its stops.
- **Saved places** (dorm, classes, job) and shareable trip links.
- Works on phones and desktops. Add it to your home screen (Share → *Add to Home Screen* on iPhone, ⋮ → *Add to Home screen* on Android) and it opens full-screen like an app.

## Does this need an LLM?

No. Route planning is a solved, exact problem: the app runs a proven transit routing algorithm
([RAPTOR](https://www.microsoft.com/en-us/research/publication/round-based-public-transit-routing/)) directly on Metro Transit's
official timetable, updated with live predictions. That gives exact times and stops in milliseconds, works for free, needs no API key,
and can't "hallucinate" a bus that doesn't exist. An LLM would be slower and cost money, and it could confidently give wrong times.

A possible future add-on is an optional "ask in plain English" box (e.g. *"get me to Target Field before the 7:10 game"*) where an LLM
only turns the sentence into a from/to/time query and the planner still does the routing. It isn't needed for anything the app does today.

## How it works

Everything runs in the browser, so there's no server to run or pay for.

| Piece | Source | Notes |
|---|---|---|
| Schedules | [Metro Transit GTFS](https://svc.metrotransit.org/mtgtfs/gtfs.zip) | Rebuilt into compact JSON every morning by GitHub Actions |
| Live predictions, vehicles, alerts | Metro Transit GTFS-realtime and NexTrip | Fetched directly by the browser |
| Trip planning | `js/raptor.js`, `js/planner.js` | RAPTOR forward and backward searches, several departures |
| Walking distances and directions | [FOSSGIS OSRM](https://routing.openstreetmap.de/) (OpenStreetMap) | Falls back to straight-line estimates if unavailable |
| Campus buildings | OpenStreetMap via Overpass | Built into `data/places.json` |
| Address search | OpenStreetMap Nominatim | |
| Map | Leaflet + CARTO / OpenStreetMap tiles | |

The workflow in `.github/workflows/deploy.yml`:

1. runs unit tests against a small synthetic feed (`tests/make_fixture.py`),
2. downloads the latest Metro Transit GTFS and builds `data/network.json`, `data/timetable.json` and `data/shapes.json`,
3. builds the campus places list,
4. smoke-tests the planner on real trips (e.g. Coffman Union → Target Field, Pioneer Hall → MSP Airport),
5. publishes the site to the `gh-pages` branch, which GitHub Pages serves.

It runs on every push, daily at 5:23 AM Central, and on demand from the **Actions** tab (*Build schedules & deploy site* → *Run workflow*).
If a new feed ever fails the tests, the old site stays up.

## Project layout

```
index.html, css/, img/, manifest.webmanifest   the web app shell
js/app.js        UI: map, bottom sheet, search, results, live refresh
js/network.js    loads the data; builds per-day timetables
js/raptor.js     the routing algorithm
js/planner.js    access/egress walking, multiple options, itineraries
js/realtime.js   GTFS-realtime (protobuf) decoder, NexTrip, alerts
js/render.js     HTML for cards, step-by-step directions, stop boards
js/walking.js    OSRM walking distances and turn-by-turn steps
js/search.js     places, stops, saved places and address search
tools/           data builders (Python standard library only)
tests/           planner and real-time tests (Node 22)
vendor/leaflet/  Leaflet 1.9.4
```

## Run it locally

```bash
# build schedule data (downloads ~20 MB from Metro Transit)
tools/assemble_site.sh _site
python3 tools/build_data.py --download --gtfs /tmp/gtfs.zip --out _site/data
python3 tools/build_places.py --out _site/data

# serve it
cd _site && python3 -m http.server 8000   # then open http://localhost:8000

# tests
python3 tests/make_fixture.py /tmp/fixture
python3 tools/build_data.py --gtfs /tmp/fixture --out /tmp/fixture-data
node tests/test_planner.mjs fixture /tmp/fixture-data
node tests/test_planner.mjs smoke _site/data
node tests/test_realtime.mjs            # add: live _site/data  to hit the real feeds
```

## GitHub Pages setup

The site is published from the **`gh-pages`** branch. If the link above ever shows a 404, open
**Settings → Pages** and set *Source* to **Deploy from a branch**, branch **`gh-pages`**, folder **`/ (root)`**.

## Credits and disclaimer

Schedule and real-time data from Metro Transit / Metropolitan Council. Map data © OpenStreetMap contributors; map tiles © CARTO.
Walking routes by FOSSGIS OSRM. [Leaflet](https://leafletjs.com/) is BSD-2-Clause licensed.

This is an independent project and isn't affiliated with Metro Transit or the University of Minnesota. Buses can run early or late,
so leave a little extra time, especially in winter.
