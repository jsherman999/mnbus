// RAPTOR (Round-bAsed Public Transit Optimized Router), Delling et al. 2012.
// Each round k finds the earliest arrival at every stop using at most k vehicles.
// The same code searches backwards in time when given a reversed timetable
// (times negated, stop order reversed), which is how "arrive by" works.

export const INF = 0x3fffffff;
const INHERIT = 0, ACCESS = 1, RIDE = 2, WALK = 3;

/**
 * @param net        Network (stopPatterns, nStops)
 * @param view       compiled timetable (or reverseTimetable(...))
 * @param sources    [{stop, time}]  time = when you can be at that stop
 * @param targets    Map(stop -> seconds from stop to the destination)
 * @param opts       {maxRounds, transferSlack, startSlack, endSlack, footpaths}
 * @returns {journeys: [{rides, arrival, legs}]}  one per improving round
 */
export function raptor(net, view, sources, targets, opts) {
  const S = net.nStops;
  const P = view.patterns.length;
  const reversed = !!view.reversed;
  const maxRounds = opts.maxRounds ?? 5;
  const transferSlack = opts.transferSlack ?? 120;
  const startSlack = opts.startSlack ?? 60;
  const endSlack = opts.endSlack ?? 0;
  const footpaths = opts.footpaths;
  const excluded = opts.excludeRoutes; // Set of route indexes, optional

  const best = new Int32Array(S).fill(INF);
  const rounds = [];

  const r0 = newRound(S);
  let marked = [];
  for (const { stop, time } of sources) {
    if (time < r0.arr[stop]) {
      if (r0.arr[stop] === INF) marked.push(stop);
      r0.arr[stop] = time;
      r0.kind[stop] = ACCESS;
      r0.start[stop] = 1;
      best[stop] = time;
    }
  }
  rounds.push(r0);

  let targetBest = INF;
  const journeys = [];
  const queue = new Int32Array(P).fill(-1);
  const isMarked = new Uint8Array(S);

  for (let k = 1; k <= maxRounds && marked.length; k++) {
    const prev = rounds[k - 1];
    const cur = copyRound(prev);

    // patterns serving marked stops, from the earliest marked position
    const touched = [];
    for (const s of marked) {
      const sp = net.stopPatterns[s];
      for (let x = 0; x < sp.length; x += 2) {
        const p = sp[x];
        const pos = reversed ? view.patterns[p].n - 1 - sp[x + 1] : sp[x + 1];
        if (queue[p] < 0) { touched.push(p); queue[p] = pos; } else if (pos < queue[p]) queue[p] = pos;
      }
    }
    marked = [];
    isMarked.fill(0);

    for (const p of touched) {
      const startPos = queue[p];
      queue[p] = -1;
      if (excluded && excluded.has(net.patterns[p].route)) continue;
      const pat = view.patterns[p];
      if (!pat.nTrips) continue;
      const { n, dep, arr, stops, flags, cancelled } = pat;
      let trip = -1, boardPos = -1;
      for (let i = startPos; i < n; i++) {
        const s = stops[i];
        if (trip >= 0 && !(flags && flags[i] & 2)) {
          const a = arr[trip * n + i];
          if (a < best[s] && a < targetBest) {
            cur.arr[s] = a;
            best[s] = a;
            cur.kind[s] = RIDE;
            cur.start[s] = 0;
            cur.pat[s] = p;
            cur.trip[s] = trip;
            cur.board[s] = boardPos;
            cur.alight[s] = i;
            if (!isMarked[s]) { isMarked[s] = 1; marked.push(s); }
          }
        }
        const ready = prev.arr[s];
        if (ready < INF && !(flags && flags[i] & 1)) {
          const t = ready + (prev.start[s] ? startSlack : transferSlack);
          if (trip < 0 || t <= dep[trip * n + i]) {
            const nt = earliestTrip(pat, i, t, cancelled);
            if (nt >= 0 && (trip < 0 || dep[nt * n + i] < dep[trip * n + i])) {
              trip = nt;
              boardPos = i;
            }
          }
        }
      }
    }

    // walking transfers from stops reached by a vehicle this round
    if (footpaths) {
      const rideStops = marked.slice();
      for (const s of rideStops) {
        const fp = footpaths[s];
        const base = cur.arr[s];
        for (let x = 0; x < fp.length; x += 2) {
          const s2 = fp[x];
          const t = base + opts.walkSecs(fp[x + 1]);
          if (t < best[s2] && t < targetBest) {
            cur.arr[s2] = t;
            best[s2] = t;
            cur.kind[s2] = WALK;
            cur.start[s2] = 0;
            cur.from[s2] = s;
            if (!isMarked[s2]) { isMarked[s2] = 1; marked.push(s2); }
          }
        }
      }
    }

    rounds.push(cur);

    // destination
    let improvedStop = -1;
    for (const s of marked) {
      const egress = targets.get(s);
      if (egress === undefined) continue;
      const t = cur.arr[s] + egress + endSlack;
      if (t < targetBest) { targetBest = t; improvedStop = s; }
    }
    if (improvedStop >= 0) {
      journeys.push({ rides: k, arrival: targetBest, legs: reconstruct(net, view, rounds, k, improvedStop, reversed) });
    }
  }
  return { journeys };
}

function newRound(S) {
  return {
    arr: new Int32Array(S).fill(INF),
    kind: new Uint8Array(S),
    start: new Uint8Array(S),
    pat: new Int32Array(S),
    trip: new Int32Array(S),
    board: new Int32Array(S),
    alight: new Int32Array(S),
    from: new Int32Array(S),
  };
}

function copyRound(prev) {
  const S = prev.arr.length;
  const r = newRound(S);
  r.arr.set(prev.arr);
  r.start.set(prev.start);
  return r; // kind stays INHERIT (0)
}

/** Earliest non-cancelled trip departing position i at or after t. */
function earliestTrip(pat, i, t, cancelled) {
  const { n, nTrips, dep } = pat;
  let lo = 0, hi = nTrips;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dep[mid * n + i] < t) lo = mid + 1; else hi = mid;
  }
  // real-time data can reorder trips slightly; look around the binary-search hit
  let bestTrip = -1, bestDep = INF;
  for (let j = Math.max(0, lo - 4); j < Math.min(nTrips, lo + 6); j++) {
    if (cancelled && cancelled[j]) continue;
    const d = dep[j * n + i];
    if (d >= t && d < bestDep) { bestDep = d; bestTrip = j; }
  }
  if (bestTrip < 0) {
    for (let j = lo + 6; j < nTrips; j++) {
      if (cancelled && cancelled[j]) continue;
      if (dep[j * n + i] >= t) return j;
    }
  }
  return bestTrip;
}

/**
 * Walk the labels back to the source. Returns legs in travel order (origin
 * first) using forward pattern positions and forward trip indexes:
 *   {type:'ride', pattern, trip, board, alight}  {type:'walk', from, to}
 * plus accessStop / egressStop on the result array.
 */
function reconstruct(net, view, rounds, k, stop, reversed) {
  const legs = [];
  let s = stop;
  let guard = 0;
  while (guard++ < 64) {
    while (k > 0 && rounds[k].kind[s] === INHERIT) k--;
    const r = rounds[k];
    const kind = r.kind[s];
    if (kind === ACCESS || k === 0) break;
    if (kind === WALK) {
      legs.push({ type: 'walk', from: r.from[s], to: s });
      s = r.from[s];
      continue;
    }
    // RIDE
    const p = r.pat[s];
    const pat = view.patterns[p];
    const boardStop = pat.stops[r.board[s]];
    legs.push({ type: 'ride', pattern: p, trip: r.trip[s], board: r.board[s], alight: r.alight[s] });
    s = boardStop;
    k -= 1;
  }
  const sourceStop = s;
  let out;
  if (!reversed) {
    out = legs.reverse();
    out.accessStop = sourceStop;
    out.egressStop = stop;
  } else {
    // reversed search: labels ran destination -> origin, so this list is already
    // in travel order, but positions/trips/walk directions must be flipped back.
    out = legs.map((l) => {
      if (l.type === 'walk') return { type: 'walk', from: l.to, to: l.from };
      const pat = view.patterns[l.pattern];
      const n = pat.n;
      return { type: 'ride', pattern: l.pattern, trip: pat.tripMap[l.trip], board: n - 1 - l.alight, alight: n - 1 - l.board };
    });
    out.accessStop = stop;
    out.egressStop = sourceStop;
  }
  return out;
}
