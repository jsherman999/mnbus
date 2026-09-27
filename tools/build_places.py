#!/usr/bin/env python3
"""Build data/places.json: searchable University of Minnesota places.

Named buildings come from OpenStreetMap (Overpass API) so coordinates are exact.
A curated list adds friendly aliases ("RecWell", "Coffman") and marks popular
places for the quick-pick list. Off-campus destinations have fixed coordinates.

If Overpass is unreachable the curated entries with known coordinates are still
written, so the build never fails because of this step.

Usage: python3 tools/build_places.py --out site/data
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "mnbus-places-builder/1.0 (https://github.com/jsherman999/mnbus)"

# (south, west, north, east)
CAMPUS_BOXES = {
    "Minneapolis campus": (44.9655, -93.2525, 44.9870, -93.2130),
    "St. Paul campus": (44.9780, -93.1960, 44.9930, -93.1690),
}

# name in OSM (or display name), category, aliases, popular
CAMPUS = [
    ("Coffman Memorial Union", "Student life", ["Coffman", "CMU", "student union"], True),
    ("Northrop", "Campus", ["Northrop Auditorium", "Northrop Mall"], True),
    ("Walter Library", "Library", ["Walter"], True),
    ("Wilson Library", "Library", ["Wilson"], True),
    ("Keller Hall", "Classes", ["Keller"], True),
    ("Science Teaching and Student Services", "Classes", ["STSS"], True),
    ("Bruininks Hall", "Classes", ["Bruininks", "Robert H. Bruininks Hall"], True),
    ("Tate Hall", "Classes", ["Tate", "physics"], False),
    ("Smith Hall", "Classes", ["chemistry"], False),
    ("Anderson Hall", "Classes", [], False),
    ("Blegen Hall", "Classes", [], False),
    ("Hanson Hall", "Classes", [], False),
    ("Willey Hall", "Classes", [], False),
    ("Carlson School of Management", "Classes", ["Carlson", "CSOM"], True),
    ("Humphrey School of Public Affairs", "Classes", ["Humphrey"], False),
    ("Rapson Hall", "Classes", [], False),
    ("Amundson Hall", "Classes", [], False),
    ("Lind Hall", "Classes", [], False),
    ("Mechanical Engineering", "Classes", ["ME building"], False),
    ("Physics and Nanotechnology Building", "Classes", ["PAN"], False),
    ("Molecular and Cellular Biology", "Classes", ["MCB"], False),
    ("Jackson Hall", "Classes", [], False),
    ("Moos Tower", "Classes", ["Moos"], False),
    ("Mayo Memorial Building", "Classes", ["Mayo"], False),
    ("Weisman Art Museum", "Arts", ["WAM", "Weisman"], True),
    ("Rarig Center", "Arts", [], False),
    ("Ted Mann Concert Hall", "Arts", [], False),
    ("University Recreation and Wellness Center", "Recreation", ["RecWell", "Rec Center", "gym"], True),
    ("Huntington Bank Stadium", "Athletics", ["football stadium", "TCF Bank Stadium"], True),
    ("Williams Arena", "Athletics", ["The Barn", "basketball"], True),
    ("3M Arena at Mariucci", "Athletics", ["Mariucci", "hockey"], False),
    ("McNamara Alumni Center", "Campus", ["McNamara", "Gateway"], False),
    ("Boynton Health", "Health", ["Boynton", "health service"], True),
    ("M Health Fairview University of Minnesota Medical Center", "Health", ["UMMC", "hospital"], False),
    # Residence halls
    ("Comstock Hall", "Residence hall", ["Comstock"], True),
    ("Pioneer Hall", "Residence hall", ["Pioneer"], True),
    ("Centennial Hall", "Residence hall", ["Centennial"], True),
    ("Frontier Hall", "Residence hall", ["Frontier"], True),
    ("Territorial Hall", "Residence hall", ["Territorial"], True),
    ("Sanford Hall", "Residence hall", ["Sanford"], True),
    ("Middlebrook Hall", "Residence hall", ["Middlebrook"], True),
    ("17th Avenue Hall", "Residence hall", ["17th Ave"], True),
    ("Bailey Hall", "Residence hall", ["Bailey"], True),
    ("Yudof Hall", "Residence hall", ["Yudof"], True),
    ("Wilkins Hall", "Residence hall", ["Wilkins"], False),
    # St. Paul campus
    ("St. Paul Student Center", "Student life", ["St Paul Student Center", "SPSC"], True),
    ("Magrath Library", "Library", ["Magrath"], False),
    ("Coffey Hall", "Campus", [], False),
    ("Borlaug Hall", "Classes", [], False),
    ("McNeal Hall", "Classes", [], False),
]

# Off-campus destinations with fixed coordinates.
DESTINATIONS = [
    ("Dinkytown (4th St SE & 14th Ave SE)", 44.98040, -93.23560, "Neighborhood", ["Dinkytown"], True),
    ("Stadium Village (Washington Ave & Oak St)", 44.97410, -93.22410, "Neighborhood", ["Stadium Village"], True),
    ("Target Field", 44.98170, -93.27760, "Downtown", ["Twins", "baseball"], True),
    ("Target Center", 44.97950, -93.27610, "Downtown", ["Timberwolves", "Lynx"], False),
    ("U.S. Bank Stadium", 44.97370, -93.25750, "Downtown", ["Vikings", "US Bank Stadium"], True),
    ("Nicollet Mall (7th St)", 44.97680, -93.27110, "Downtown", ["Nicollet", "downtown Minneapolis"], True),
    ("Minneapolis Central Library", 44.97980, -93.27000, "Downtown", ["Hennepin County Library"], False),
    ("Stone Arch Bridge", 44.98060, -93.25360, "Downtown", ["Mill Ruins", "St. Anthony Main"], False),
    ("Walker Art Center", 44.96810, -93.28870, "Arts", ["Sculpture Garden", "Spoonbridge"], False),
    ("Minneapolis Institute of Art", 44.95850, -93.27380, "Arts", ["Mia"], False),
    ("Uptown (Hennepin Ave & Lake St)", 44.94860, -93.29820, "Neighborhood", ["Uptown"], False),
    ("Bde Maka Ska", 44.94800, -93.31100, "Outdoors", ["Lake Calhoun"], False),
    ("Minnehaha Falls", 44.91530, -93.21100, "Outdoors", ["Minnehaha Park"], False),
    ("Mall of America", 44.85490, -93.24220, "Shopping", ["MOA"], True),
    ("Rosedale Center", 45.01290, -93.17160, "Shopping", ["Rosedale"], False),
    ("MSP Airport - Terminal 1", 44.88080, -93.20500, "Travel", ["airport", "MSP", "Lindbergh"], True),
    ("MSP Airport - Terminal 2", 44.87440, -93.22440, "Travel", ["airport", "Humphrey terminal"], False),
    ("Union Depot (St. Paul)", 44.94800, -93.08600, "Travel", ["Amtrak", "downtown St Paul"], True),
    ("Minnesota State Capitol", 44.95510, -93.10220, "St. Paul", ["Capitol"], False),
    ("Allianz Field", 44.95300, -93.16500, "St. Paul", ["Minnesota United", "soccer"], False),
    ("Xcel Energy Center", 44.94480, -93.10110, "St. Paul", ["Wild", "hockey"], False),
    ("Minnesota State Fairgrounds", 44.98180, -93.17150, "St. Paul", ["State Fair"], False),
]


def overpass_query():
    parts = []
    for s, w, n, e in CAMPUS_BOXES.values():
        bb = f"({s},{w},{n},{e})"
        parts.append(f'nwr["building"]["name"]{bb};')
        parts.append(f'nwr["amenity"~"^(university|library|theatre|arts_centre|hospital|clinic|cafe|restaurant|fast_food|pharmacy|place_of_worship|townhall)$"]["name"]{bb};')
        parts.append(f'nwr["leisure"~"^(stadium|sports_centre|park)$"]["name"]{bb};')
        parts.append(f'nwr["shop"]["name"]{bb};')
    return "[out:json][timeout:90];(" + "".join(parts) + ");out center tags;"


def fetch_overpass(log):
    body = urllib.parse.urlencode({"data": overpass_query()}).encode()
    for url in OVERPASS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA,
                                                                      "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    raw = resp.read()
                data = json.loads(raw)
                log(f"overpass {url}: {len(data.get('elements', []))} elements")
                return data["elements"]
            except Exception as exc:  # noqa: BLE001 - any failure falls through to the next mirror
                log(f"overpass {url} attempt {attempt + 1} failed: {exc}")
                time.sleep(5)
    return None


def norm(s):
    return " ".join("".join(c.lower() if c.isalnum() else " " for c in s).split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    log = print

    elements = fetch_overpass(log) or []
    osm = []
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        if not name or not c:
            continue
        kind = ("Residence hall" if tags.get("building") in ("dormitory", "residential") and "Hall" in name
                else "Campus" if tags.get("building") in ("university", "college", "school") or tags.get("amenity") == "university"
                else "Place")
        alt = [tags[k] for k in ("alt_name", "short_name", "official_name", "old_name") if tags.get(k)]
        osm.append({"n": name, "lat": round(c["lat"], 6), "lon": round(c["lon"], 6), "c": kind, "a": alt,
                    "addr": " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x)})

    by_name = {}
    for p in osm:
        by_name.setdefault(norm(p["n"]), p)
        for a in p["a"]:
            by_name.setdefault(norm(a), p)

    places, used, missing = [], set(), []
    for name, cat, aliases, popular in CAMPUS:
        hit = by_name.get(norm(name)) or next((by_name[norm(a)] for a in aliases if norm(a) in by_name), None)
        if not hit:
            # loose match: OSM name contains our name
            key = norm(name)
            hit = next((p for p in osm if key in norm(p["n"])), None)
        if not hit:
            missing.append(name)
            continue
        used.add(id(hit))
        entry = {"n": name, "lat": hit["lat"], "lon": hit["lon"], "c": cat,
                 "a": sorted(set(aliases + hit["a"] + ([hit["n"]] if hit["n"] != name else [])))}
        if hit.get("addr"):
            entry["addr"] = hit["addr"]
        if popular:
            entry["p"] = 1
        places.append(entry)

    for name, lat, lon, cat, aliases, popular in DESTINATIONS:
        entry = {"n": name, "lat": lat, "lon": lon, "c": cat, "a": aliases}
        if popular:
            entry["p"] = 1
        places.append(entry)

    seen = {norm(p["n"]) for p in places}
    for p in osm:
        if id(p) in used or norm(p["n"]) in seen:
            continue
        seen.add(norm(p["n"]))
        entry = {"n": p["n"], "lat": p["lat"], "lon": p["lon"], "c": p["c"]}
        if p["a"]:
            entry["a"] = p["a"]
        if p.get("addr"):
            entry["addr"] = p["addr"]
        places.append(entry)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "places.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "source": "OpenStreetMap contributors" if osm else "curated",
                   "places": places}, f, separators=(",", ":"), ensure_ascii=False)
    log(f"places: {len(places)} written ({len(osm)} from OpenStreetMap); curated not found in OSM: {missing or 'none'}")
    for p in places[: len(CAMPUS)]:
        log(f"  {p['n']}: {p['lat']}, {p['lon']}  ({p.get('addr', '')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
