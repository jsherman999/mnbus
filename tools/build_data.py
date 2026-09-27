#!/usr/bin/env python3
"""Turn a GTFS feed into the compact JSON files the web app loads.

Usage:
    python3 tools/build_data.py --gtfs gtfs.zip --out site/data
    python3 tools/build_data.py --download --out site/data

Outputs (all in --out):
    network.json    stops, routes, trip patterns, service calendar, feed info
    timetable.json  departure times for every pattern (compressed as time profiles)
    shapes.json     simplified route geometry (encoded polylines)

Only the Python standard library is used so this runs anywhere, including
GitHub Actions without a pip install step.
"""

import argparse
import collections
import csv
import datetime
import io
import json
import math
import os
import sys
import urllib.request
import zipfile

GTFS_URL = "https://svc.metrotransit.org/mtgtfs/gtfs.zip"

# Areas used to flag routes that serve the University of Minnesota.
# (south, west, north, east)
UMN_AREAS = [
    (44.965, -93.252, 44.987, -93.214),  # Minneapolis campus, Dinkytown, Stadium Village, West Bank
    (44.977, -93.196, 44.993, -93.170),  # St. Paul campus
]

SIMPLIFY_METERS = 6.0


# --------------------------------------------------------------------------- IO


class Feed:
    """Reads GTFS text files from a zip archive or a directory."""

    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None
        if self.zip:
            # Some feeds nest files inside a folder; map basename -> member name.
            self.members = {os.path.basename(n): n for n in self.zip.namelist() if n.endswith(".txt")}

    def has(self, name):
        if self.zip:
            return name in self.members
        return os.path.exists(os.path.join(self.path, name))

    def rows(self, name):
        if not self.has(name):
            return
        if self.zip:
            with self.zip.open(self.members[name]) as raw:
                yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"))
        else:
            with open(os.path.join(self.path, name), encoding="utf-8-sig", newline="") as f:
                yield from csv.DictReader(f)


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "mnbus-data-builder (github.com/jsherman999/mnbus)"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)


# ------------------------------------------------------------------------ helpers


def parse_time(value):
    """GTFS HH:MM:SS (hours may exceed 24) -> seconds after service-day midnight."""
    h, m, s = value.strip().split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def in_box(lat, lon, box):
    s, w, n, e = box
    return s <= lat <= n and w <= lon <= e


def encode_polyline(points, precision=5):
    """Google encoded polyline algorithm."""
    factor = 10 ** precision
    out = []
    prev_lat = prev_lon = 0
    for lat, lon in points:
        ilat, ilon = int(round(lat * factor)), int(round(lon * factor))
        for delta in (ilat - prev_lat, ilon - prev_lon):
            v = ~(delta << 1) if delta < 0 else (delta << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def simplify(points, keep, tolerance_m):
    """Douglas-Peucker that never drops indices in `keep`. Returns kept indices."""
    n = len(points)
    if n <= 2:
        return list(range(n))
    lat0 = math.radians(points[0][0])
    kx = 111320.0 * math.cos(lat0)
    ky = 110540.0
    xy = [(p[1] * kx, p[0] * ky) for p in points]
    anchors = sorted(set([0, n - 1]) | {k for k in keep if 0 <= k < n})
    kept = set(anchors)
    tol2 = tolerance_m * tolerance_m
    for a, b in zip(anchors, anchors[1:]):
        stack = [(a, b)]
        while stack:
            i, j = stack.pop()
            if j <= i + 1:
                continue
            ax, ay = xy[i]
            bx, by = xy[j]
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            best, best_d = -1, -1.0
            for k in range(i + 1, j):
                px, py = xy[k]
                if seg2 == 0:
                    d = (px - ax) ** 2 + (py - ay) ** 2
                else:
                    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                    d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
                if d > best_d:
                    best, best_d = k, d
            if best_d > tol2:
                kept.add(best)
                stack.append((i, best))
                stack.append((best, j))
    return sorted(kept)


def route_label(route):
    short = (route.get("route_short_name") or "").strip()
    if short:
        return short
    long_name = (route.get("route_long_name") or "").strip()
    if long_name.startswith("METRO ") and long_name.endswith(" Line"):
        return long_name[len("METRO "):-len(" Line")]
    return long_name or route["route_id"]


# ---------------------------------------------------------------------- building


def build(feed, out_dir, bbox=None, log=print):
    # ---- feed info / agencies
    feed_info = next(feed.rows("feed_info.txt"), None) or {}
    agencies = {r.get("agency_id", ""): r for r in feed.rows("agency.txt")}

    # ---- stops
    stops = {}
    for r in feed.rows("stops.txt"):
        if r.get("location_type") not in (None, "", "0"):
            continue
        try:
            lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except (KeyError, ValueError):
            continue
        if bbox and not in_box(lat, lon, bbox):
            continue
        stops[r["stop_id"]] = r
    log(f"stops: {len(stops)}")

    # ---- routes & trips
    routes = {r["route_id"]: r for r in feed.rows("routes.txt")}
    trips = {}
    for r in feed.rows("trips.txt"):
        trips[r["trip_id"]] = r
    log(f"routes: {len(routes)}, trips: {len(trips)}")

    # ---- stop times grouped by trip
    by_trip = collections.defaultdict(list)
    count = 0
    for r in feed.rows("stop_times.txt"):
        sid = r["stop_id"]
        if sid not in stops or r["trip_id"] not in trips:
            continue
        arr_s = r.get("arrival_time") or r.get("departure_time")
        dep_s = r.get("departure_time") or r.get("arrival_time")
        if not arr_s or not dep_s:
            continue  # untimed stop; GTFS allows interpolation but Metro Transit times every stop
        dist = r.get("shape_dist_traveled")
        flags = 0
        if r.get("pickup_type") == "1":
            flags |= 1
        if r.get("drop_off_type") == "1":
            flags |= 2
        by_trip[r["trip_id"]].append((
            int(r["stop_sequence"]), sid, parse_time(arr_s), parse_time(dep_s), flags,
            float(dist) if dist not in (None, "") else None,
        ))
        count += 1
    log(f"stop_times kept: {count} across {len(by_trip)} trips")

    # ---- whole-minute detection keeps the timetable small
    unit = 60
    for rows in by_trip.values():
        for row in rows:
            if row[2] % 60 or row[3] % 60:
                unit = 1
                break
        if unit == 1:
            break

    # ---- patterns: identical (route, direction, headsign, shape, stops, pickup flags)
    patterns = {}
    for tid, rows in by_trip.items():
        rows.sort()
        if len(rows) < 2:
            continue
        t = trips[tid]
        key = (
            t["route_id"], t.get("direction_id") or "0", (t.get("trip_headsign") or "").strip(),
            t.get("shape_id") or "", tuple(r[1] for r in rows), tuple(r[4] for r in rows),
        )
        pat = patterns.get(key)
        if pat is None:
            pat = patterns[key] = {"key": key, "trips": [], "dists": [r[5] for r in rows],
                                   "dir_text": (t.get("direction") or "").strip()}
        pat["trips"].append((rows[0][3], tid, rows))
    log(f"patterns: {len(patterns)}")

    # ---- services
    used_services = sorted({trips[tid]["service_id"] for p in patterns.values() for _, tid, _ in p["trips"]})
    service_index = {sid: i for i, sid in enumerate(used_services)}
    calendar = {r["service_id"]: r for r in feed.rows("calendar.txt")}
    exceptions = collections.defaultdict(lambda: {"add": [], "rem": []})
    for r in feed.rows("calendar_dates.txt"):
        exceptions[r["service_id"]]["add" if r["exception_type"] == "1" else "rem"].append(r["date"])
    services_out = []
    min_date, max_date = "99999999", "00000000"
    for sid in used_services:
        c = calendar.get(sid)
        ex = exceptions.get(sid, {"add": [], "rem": []})
        entry = {"id": sid}
        if c:
            entry["days"] = "".join(c[d] for d in ("monday", "tuesday", "wednesday", "thursday",
                                                  "friday", "saturday", "sunday"))
            entry["start"], entry["end"] = c["start_date"], c["end_date"]
            min_date, max_date = min(min_date, c["start_date"]), max(max_date, c["end_date"])
        if ex["add"]:
            entry["add"] = sorted(ex["add"])
            min_date, max_date = min(min_date, *ex["add"]), max(max_date, *ex["add"])
        if ex["rem"]:
            entry["rem"] = sorted(ex["rem"])
        services_out.append(entry)

    # ---- shapes
    used_shapes = {p["key"][3] for p in patterns.values() if p["key"][3]}
    shape_pts = collections.defaultdict(list)
    for r in feed.rows("shapes.txt"):
        sid = r["shape_id"]
        if sid in used_shapes:
            d = r.get("shape_dist_traveled")
            shape_pts[sid].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]),
                                   float(r["shape_pt_lon"]), float(d) if d not in (None, "") else None))
    for pts in shape_pts.values():
        pts.sort()
    log(f"shapes used: {len(shape_pts)}")

    # ---- ordering: routes by sort order, stops by id
    def route_sort_key(rid):
        r = routes.get(rid, {})
        so = r.get("route_sort_order")
        return (int(so) if so and so.lstrip("-").isdigit() else 10**6, rid)

    used_route_ids = sorted({p["key"][0] for p in patterns.values()}, key=route_sort_key)
    route_index = {rid: i for i, rid in enumerate(used_route_ids)}
    used_stop_ids = sorted({s for p in patterns.values() for s in p["key"][4]},
                           key=lambda s: (0, int(s), s) if s.isdigit() else (1, 0, s))
    stop_index = {sid: i for i, sid in enumerate(used_stop_ids)}

    pattern_list = sorted(patterns.values(), key=lambda p: (route_index[p["key"][0]], p["key"][1],
                                                              -len(p["trips"]), p["key"][2]))

    # ---- shape geometry + stop positions along it
    shape_out = []
    shape_ref = {}
    # group patterns by shape so every stop position gets inserted before simplifying
    by_shape = collections.defaultdict(list)
    for pi, p in enumerate(pattern_list):
        by_shape[p["key"][3]].append(pi)

    pattern_vertices = {}
    for shape_id, pis in by_shape.items():
        pts = shape_pts.get(shape_id)
        if not pts or len(pts) < 2:
            # No usable shape: draw straight lines between stops.
            for pi in pis:
                p = pattern_list[pi]
                coords = [(float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"])) for s in p["key"][4]]
                shape_ref[(shape_id, pi)] = len(shape_out)
                shape_out.append(encode_polyline(coords))
                pattern_vertices[pi] = list(range(len(coords)))
            continue
        cum = [0.0]
        for a, b in zip(pts, pts[1:]):
            cum.append(cum[-1] + haversine(a[1], a[2], b[1], b[2]))
        gtfs_dist = all(p[3] is not None for p in pts)
        # position of each pattern stop along the shape, in our own metres
        positions = {}
        for pi in pis:
            p = pattern_list[pi]
            positions[pi] = stop_positions(pts, cum, [stops[s] for s in p["key"][4]],
                                           p["dists"] if gtfs_dist else None)
        # insert every stop position as a vertex
        cuts = sorted({round(x, 2) for pos in positions.values() for x in pos})
        verts, vcum = insert_points(pts, cum, cuts)
        cut_index = {}
        j = 0
        for c in cuts:
            while j < len(vcum) - 1 and vcum[j] < c - 1e-6:
                j += 1
            cut_index[c] = j
        keep = set(cut_index.values())
        kept = simplify(verts, keep, SIMPLIFY_METERS)
        remap = {old: new for new, old in enumerate(kept)}
        sidx = len(shape_out)
        shape_out.append(encode_polyline([verts[k] for k in kept]))
        for pi in pis:
            shape_ref[(shape_id, pi)] = sidx
            pattern_vertices[pi] = [remap[cut_index[round(x, 2)]] for x in positions[pi]]

    # ---- output structures
    stops_out = {"id": [], "name": [], "desc": [], "lat": [], "lon": []}
    for sid in used_stop_ids:
        s = stops[sid]
        stops_out["id"].append(sid)
        stops_out["name"].append(s["stop_name"].strip())
        stops_out["desc"].append((s.get("stop_desc") or "").strip())
        stops_out["lat"].append(round(float(s["stop_lat"]) * 1e5))
        stops_out["lon"].append(round(float(s["stop_lon"]) * 1e5))

    route_stops = collections.defaultdict(set)
    for p in pattern_list:
        route_stops[p["key"][0]].update(p["key"][4])
    routes_out = []
    for rid in used_route_ids:
        r = routes[rid]
        umn = any(in_box(float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"]), box)
                  for s in route_stops[rid] for box in UMN_AREAS)
        agency = agencies.get(r.get("agency_id", ""), {})
        routes_out.append({
            "id": rid,
            "label": route_label(r),
            "name": (r.get("route_long_name") or "").strip(),
            "desc": (r.get("route_desc") or "").strip(),
            "type": int(r.get("route_type") or 3),
            "color": (r.get("route_color") or "").strip().upper(),
            "text": (r.get("route_text_color") or "").strip().upper(),
            "agency": (agency.get("agency_name") or "").strip(),
            "url": (r.get("route_url") or "").strip(),
            "umn": 1 if umn else 0,
        })

    patterns_out = []
    timetable_out = []
    for pi, p in enumerate(pattern_list):
        rid, direction, headsign, shape_id, stop_ids, flags = p["key"]
        entry = {
            "r": route_index[rid],
            "d": int(direction) if direction.isdigit() else 0,
            "h": headsign,
            "s": [stop_index[s] for s in stop_ids],
            "g": shape_ref[(shape_id, pi)],
            "v": pattern_vertices[pi],
        }
        if p["dir_text"]:
            entry["dt"] = p["dir_text"]
        if any(flags):
            entry["f"] = list(flags)
        patterns_out.append(entry)

        # timetable: profiles of (travel, dwell) relative to first departure
        p["trips"].sort(key=lambda x: (x[0], x[1]))
        profiles, profile_index = [], {}
        starts, prof_ids, svc_ids, trip_ids = [], [], [], []
        prev_start = 0
        for start, tid, rows in p["trips"]:
            travel = tuple((rows[i][2] - rows[i - 1][3]) // unit for i in range(1, len(rows)))
            dwell = tuple((i, (rows[i][3] - rows[i][2]) // unit) for i in range(len(rows)) if rows[i][3] != rows[i][2])
            prof_key = (travel, dwell)
            if prof_key not in profile_index:
                profile_index[prof_key] = len(profiles)
                profiles.append(list(travel) if not dwell else {"t": list(travel), "w": [list(x) for x in dwell]})
            s = start // unit
            starts.append(s - prev_start)
            prev_start = s
            prof_ids.append(profile_index[prof_key])
            svc_ids.append(service_index[trips[tid]["service_id"]])
            trip_ids.append(int(tid) if tid.isdigit() and not tid.startswith("0") else tid)
        tt = {"p": profiles, "s": starts, "v": svc_ids, "t": trip_ids}
        if len(profiles) > 1:
            tt["i"] = prof_ids
        timetable_out.append(tt)

    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    network = {
        "version": 1,
        "generated": generated,
        "unit": unit,
        "feed": {
            "publisher": feed_info.get("feed_publisher_name", ""),
            "version": feed_info.get("feed_version", ""),
            "start": feed_info.get("feed_start_date") or (min_date if min_date != "99999999" else ""),
            "end": feed_info.get("feed_end_date") or (max_date if max_date != "00000000" else ""),
        },
        "services": services_out,
        "routes": routes_out,
        "stops": stops_out,
        "patterns": patterns_out,
    }
    os.makedirs(out_dir, exist_ok=True)
    sizes = {}
    for name, obj in (("network.json", network), ("timetable.json", {"version": 1, "generated": generated,
                                                                     "patterns": timetable_out}),
                      ("shapes.json", {"version": 1, "shapes": shape_out})):
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
        sizes[name] = os.path.getsize(path)
    total_trips = sum(len(t["s"]) for t in timetable_out)
    total_profiles = sum(len(t["p"]) for t in timetable_out)
    log(f"wrote {out_dir}: " + ", ".join(f"{k} {v / 1024:.0f} KB" for k, v in sizes.items()))
    log(f"routes {len(routes_out)} (UMN-area {sum(r['umn'] for r in routes_out)}), stops {len(used_stop_ids)}, "
        f"patterns {len(patterns_out)}, trips {total_trips}, time profiles {total_profiles}, "
        f"shapes {len(shape_out)}, unit {unit}s, feed {network['feed']['start']}-{network['feed']['end']}")
    return network


def stop_positions(pts, cum, stop_rows, dists):
    """Distance (metres, along our cumulative measure) of each stop on the shape."""
    n = len(pts)
    if dists and all(d is not None for d in dists):
        # Convert GTFS shape_dist_traveled into our metres by interpolating on the shape's own values.
        out = []
        j = 0
        for d in dists:
            while j < n - 2 and pts[j + 1][3] < d:
                j += 1
            a, b = pts[j][3], pts[j + 1][3]
            t = 0.0 if b == a else max(0.0, min(1.0, (d - a) / (b - a)))
            out.append(cum[j] + t * (cum[j + 1] - cum[j]))
        return monotonic(out)

    # Geometric fallback: sequential projection onto the polyline.
    lat0 = math.radians(pts[0][1])
    kx, ky = 111320.0 * math.cos(lat0), 110540.0
    xy = [(p[2] * kx, p[1] * ky) for p in pts]
    out = []
    seg = 0
    prev_stop = None
    for s in stop_rows:
        lat, lon = float(s["stop_lat"]), float(s["stop_lon"])
        px, py = lon * kx, lat * ky
        limit = cum[seg] + (3 * haversine(prev_stop[0], prev_stop[1], lat, lon) + 1000 if prev_stop else 1e12)
        best, best_d, best_pos = seg, float("inf"), cum[seg]
        k = seg
        while k < n - 1 and cum[k] <= limit:
            ax, ay = xy[k]
            bx, by = xy[k + 1]
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d < best_d:
                best, best_d, best_pos = k, d, cum[k] + t * (cum[k + 1] - cum[k])
            k += 1
        seg = best
        out.append(best_pos)
        prev_stop = (lat, lon)
    return monotonic(out)


def monotonic(values):
    out, last = [], -1.0
    for v in values:
        v = max(v, last)
        out.append(v)
        last = v
    return out


def insert_points(pts, cum, cuts):
    """Return shape vertices with interpolated points added at each cut distance."""
    verts, vcum = [], []
    ci = 0
    n = len(pts)
    for i in range(n):
        # cuts that fall before this vertex (strictly inside the previous segment)
        while ci < len(cuts) and i > 0 and cuts[ci] < cum[i] - 0.5:
            c = cuts[ci]
            a, b = pts[i - 1], pts[i]
            span = cum[i] - cum[i - 1]
            t = 0.0 if span == 0 else (c - cum[i - 1]) / span
            if c > vcum[-1] + 0.5:
                verts.append((a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])))
                vcum.append(c)
            ci += 1
        verts.append((pts[i][1], pts[i][2]))
        vcum.append(cum[i])
        while ci < len(cuts) and abs(cuts[ci] - cum[i]) <= 0.5:
            ci += 1
    return verts, vcum


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", help="GTFS zip file or directory")
    ap.add_argument("--download", action="store_true", help=f"download the feed from {GTFS_URL}")
    ap.add_argument("--out", default="data", help="output directory")
    ap.add_argument("--bbox", help="optional south,west,north,east filter")
    args = ap.parse_args()
    path = args.gtfs
    if args.download:
        path = path or "gtfs.zip"
        print(f"downloading {GTFS_URL} -> {path}")
        download(GTFS_URL, path)
    if not path:
        ap.error("pass --gtfs PATH or --download")
    bbox = tuple(float(x) for x in args.bbox.split(",")) if args.bbox else None
    build(Feed(path), args.out, bbox)


if __name__ == "__main__":
    sys.exit(main())
