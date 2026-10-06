# "Check live site" failures — diagnosis (2026-09-27)

**Workflow:** `Check live site` (`.github/workflows/site-check.yml`)
**Failed runs:** [#36293819035](https://github.com/jsherman999/mnbus/actions/runs/36293819035) (Sat 2026-09-26 23:16 CDT), [#36313183791](https://github.com/jsherman999/mnbus/actions/runs/36313183791) (Sun 2026-09-27 05:38 CDT)
**Failing step:** `Check the published site` (`node tests/site_check.mjs`), exit code 1

## Finding

**The site is healthy. The check is flaky, not the app.**

Evidence:

- Verified live on 2026-09-27 ~17:00 CDT: `https://jsherman999.github.io/mnbus/js/app.js` returns 200, the Metro Transit realtime feed (`svc.metrotransit.org/mtgtfs/tripupdates.pb`) returns 200, OSM tiles return 200, and Nominatim search returns results. Nothing is down.
- The exact same commit (`608681e`) **passed** the check at 04:28 UTC and **failed** it at 10:38 UTC. Identical code, identical deployed site — one passed, one failed.
- The 04:16 UTC failure happened within minutes of passing runs of the same workflow.

## Root cause

Saturday night saw 8 deploys in ~30 minutes (rapid Claude-authored commits), and every deploy spawns its own `Check live site` run. Those checks ran concurrently, racing the deploys and each other, and each one hammers third-party endpoints (Metro Transit realtime feed, `tile.openstreetmap.org`, Nominatim) from shared GitHub Actions runner IPs — which those services are known to throttle intermittently.

The check treats any transient blip as a hard failure: one failed tile batch, one slow realtime-feed response, or one off-peak hour with no live departures (the 05:38 CDT failure landed when almost no buses run, so the "live times" assertion may have been unsatisfiable) fails the whole run.

## Recommended fixes

1. **Add a concurrency group** to `site-check.yml` so a new deploy cancels the stale check instead of stacking concurrent checks that race each other:
   ```yaml
   concurrency:
     group: site-check
     cancel-in-progress: true
   ```
2. **Retry the flaky external calls** (realtime feed, tile loads) once or twice before recording a problem. The script already carries a special diagnostic for Metro Transit CDN/cache quirks — that endpoint is known-flaky.
3. **Reconsider off-peak runs.** If the check must run at hours when Metro Transit has little/no service, either skip the live-data assertions in that window or accept occasional failures there.
4. **Split "site is up" from "third-party APIs are healthy."** A hard fail on `EXPECT_APP_JS`/page-load problems, but a warning-only (non-failing) result for tile/realtime/search checks, would stop paging on other people's outages.

## To see exactly which assertion tripped

The step logs and the `site-check` artifact (`summary.json`, screenshots) on the failed run show which `PROBLEM:` line fired. Re-run with `print_screenshots: true` if you want the visual state too.

## Subsequent instances (added 2026-10-05)

The same flakiness recurred on the same branch (`claude/umn-bus-route-planner-occack`), consistent with the diagnosis above:

- 2026-09-28 ~5:43 AM CDT — "Check live site" failed again
- 2026-10-02 — failure found in the morning pages sweep; live site fine
- 2026-10-03 — failure started ~40 min before the 11:18 CDT sweep; live site fine
- 2026-10-04 12:08 UTC ([run 37201100028](https://github.com/jsherman999/mnbus/actions/runs/37201100028)); live site fine
- 2026-10-05 10:41:13 UTC ([run 37298033763](https://github.com/jsherman999/mnbus/actions/runs/37298033763)); 3 annotations, 1m07s

No live-site outage accompanied any of these runs. The branch's check keeps failing while the deployed site keeps passing.
