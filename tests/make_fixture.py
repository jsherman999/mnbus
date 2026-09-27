#!/usr/bin/env python3
"""Write a tiny synthetic GTFS feed (real UMN-area coordinates, invented times)
used by tests/test_planner.mjs to check the data build and the router."""

import csv
import math
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "fixture")

STOPS = {
    # Green Line, eastbound platforms (and westbound twins 1xx+10)
    "101": ("Nicollet Mall Station", 44.97850, -93.27300),
    "102": ("Government Plaza Station", 44.97670, -93.26590),
    "103": ("West Bank Station", 44.971941, -93.246128),
    "104": ("East Bank Station", 44.973645, -93.231064),
    "105": ("Stadium Village Station", 44.974753, -93.222757),
    "111": ("Nicollet Mall Station", 44.97855, -93.27310),
    "112": ("Government Plaza Station", 44.97675, -93.26600),
    "113": ("West Bank Station", 44.971988, -93.246139),
    "114": ("East Bank Station", 44.973713, -93.231063),
    "115": ("Stadium Village Station", 44.974799, -93.222881),
    # Campus Connector-like bus
    "201": ("Washington Ave & Coffman Union", 44.973532, -93.235085),
    "202": ("University Ave SE & 15th Ave SE", 44.98040, -93.23550),
    "203": ("Como Ave & Eustis St", 44.98500, -93.20000),
    "204": ("St Paul Student Center", 44.98480, -93.18560),
    "205": ("Washington Ave & Oak St", 44.97380, -93.22800),
    "206": ("4th St SE & 10th Ave SE", 44.98400, -93.24400),
    "207": ("Hennepin Ave & 5th St", 44.98100, -93.27000),
    "208": ("Marquette Ave & 7th St", 44.97600, -93.27000),
    "209": ("West Bank Bus Stop", 44.97250, -93.24450),
}

ROUTES = [
    # id, short, long, type, color, agency
    ("902", "", "METRO Green Line", 0, "008144", "0"),
    ("121", "121", "U of M - Campus Connector", 3, "7A0019", "11"),
    ("3", "3", "U of M - Como Av - Downtown", 3, "771473", "0"),
]


def dist(a, b):
    la1, lo1 = STOPS[a][1], STOPS[a][2]
    la2, lo2 = STOPS[b][1], STOPS[b][2]
    x = math.radians(lo2 - lo1) * math.cos(math.radians((la1 + la2) / 2))
    y = math.radians(la2 - la1)
    return 6371000 * math.hypot(x, y)


def hms(sec):
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def main():
    os.makedirs(OUT, exist_ok=True)
    w = lambda name, header, rows: _write(os.path.join(OUT, name), header, rows)

    w("agency.txt", ["agency_id", "agency_name", "agency_url", "agency_timezone"],
      [["0", "Metro Transit", "https://www.metrotransit.org", "America/Chicago"],
       ["11", "University of Minnesota", "https://www.pts.umn.edu/bus", "America/Chicago"]])
    w("feed_info.txt", ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date",
                        "feed_end_date", "feed_version"],
      [["Fixture", "https://example.org", "en", "20260101", "20271231", "test"]])
    w("stops.txt", ["stop_id", "stop_name", "stop_desc", "stop_lat", "stop_lon", "location_type"],
      [[k, v[0], "", f"{v[1]:.6f}", f"{v[2]:.6f}", "0"] for k, v in STOPS.items()])
    w("routes.txt", ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type",
                     "route_color", "route_text_color", "route_sort_order"],
      [[r[0], r[5], r[1], r[2], str(r[3]), r[4], "FFFFFF", str(i)] for i, r in enumerate(ROUTES)])
    w("calendar.txt", ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
                       "sunday", "start_date", "end_date"],
      [["WK", "1", "1", "1", "1", "1", "0", "0", "20260101", "20271231"],
       ["SA", "0", "0", "0", "0", "0", "1", "0", "20260101", "20271231"]])
    w("calendar_dates.txt", ["service_id", "date", "exception_type"],
      [["WK", "20261126", "2"], ["SA", "20261126", "1"]])

    lines = {
        # route, direction, headsign, stops, travel minutes between stops, first, last, headway (min), services
        "902E": ("902", 0, "Downtown St Paul", ["101", "102", "103", "104", "105"], [3, 4, 3, 2], 5 * 60, 23 * 60, 10, ["WK", "SA"]),
        "902W": ("902", 1, "Target Field", ["115", "114", "113", "112", "111"], [2, 3, 4, 3], 5 * 60, 23 * 60, 10, ["WK", "SA"]),
        "121E": ("121", 0, "St Paul Campus", ["209", "201", "205", "203", "204"], [3, 3, 6, 3], 7 * 60, 22 * 60, 10, ["WK"]),
        "121W": ("121", 1, "West Bank", ["204", "203", "205", "201", "209"], [3, 6, 3, 3], 7 * 60 + 5, 22 * 60, 10, ["WK"]),
        "3W": ("3", 1, "Downtown Minneapolis", ["202", "206", "207", "208"], [4, 7, 3], 6 * 60, 24 * 60 + 30, 20, ["WK"]),
    }
    trips, stop_times, shapes = [], [], []
    for key, (rid, d, head, sts, travel, first, last, hw, svcs) in lines.items():
        shape_id = f"sh{key}"
        cum = 0.0
        seq = 1
        stop_dist = [0.0]
        for i, s in enumerate(sts):
            if i:
                a, b = sts[i - 1], sts[i]
                mid = ((STOPS[a][1] + STOPS[b][1]) / 2 + 0.0004, (STOPS[a][2] + STOPS[b][2]) / 2)
                d1 = math.dist((STOPS[a][1], STOPS[a][2]), mid) * 111000
                shapes.append([shape_id, f"{mid[0]:.6f}", f"{mid[1]:.6f}", str(seq), f"{cum + d1:.1f}"])
                seq += 1
                cum += dist(a, b) * 1.05
                stop_dist.append(cum)
            shapes.append([shape_id, f"{STOPS[s][1]:.6f}", f"{STOPS[s][2]:.6f}", str(seq), f"{cum:.1f}"])
            seq += 1
        for svc in svcs:
            t = first
            while t <= last:
                tid = f"{key}-{svc}-{t}"
                trips.append([rid, svc, tid, head, str(d), shape_id])
                clock = t * 60
                for i, s in enumerate(sts):
                    if i:
                        clock += travel[i - 1] * 60
                    stop_times.append([tid, hms(clock), hms(clock), s, str(i + 1), f"{stop_dist[i]:.1f}"])
                t += hw
    w("trips.txt", ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"], trips)
    w("stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence",
                         "shape_dist_traveled"], stop_times)
    w("shapes.txt", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"], shapes)
    print(f"fixture written to {OUT}: {len(trips)} trips, {len(stop_times)} stop times")


def _write(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(header)
        wr.writerows(rows)


if __name__ == "__main__":
    main()
