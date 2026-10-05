// Logique de planification : pas de DOM ici (testable avec Node).
// Toutes les heures sont en minutes depuis minuit, heure d'Orlando.
// Jour de semaine : 0 = lundi ... 6 = dimanche (comme stats.json).

export const PARKS = [
  { id: "magic_kingdom", group: "disney", name: "Magic Kingdom", emoji: "🏰", open: 540, close: 1320, weight: 1.5 },
  { id: "epcot", group: "disney", name: "EPCOT", emoji: "🌐", open: 540, close: 1260, weight: 1.15 },
  { id: "hollywood_studios", group: "disney", name: "Hollywood Studios", emoji: "🎬", open: 540, close: 1260, weight: 1.15 },
  { id: "animal_kingdom", group: "disney", name: "Animal Kingdom", emoji: "🦁", open: 480, close: 1140, weight: 1 },
  { id: "universal_studios_florida", group: "universal", name: "Universal Studios Florida", emoji: "🎞️", open: 540, close: 1260, weight: 1.1 },
  { id: "islands_of_adventure", group: "universal", name: "Islands of Adventure", emoji: "🦖", open: 540, close: 1260, weight: 1.15 },
  { id: "epic_universe", group: "universal", name: "Epic Universe", emoji: "🪐", open: 540, close: 1260, weight: 1.4 },
];
export const PARK_BY_ID = Object.fromEntries(PARKS.map((p) => [p.id, p]));

export const PACES = {
  chill:  { maxRides: 6,  walk: 1.3,  breakEvery: 150, breakLen: 30, arriveAfter: 60,  leaveBefore: 150, lunchLen: 75 },
  normal: { maxRides: 10, walk: 1.0,  breakEvery: 210, breakLen: 20, arriveAfter: 15,  leaveBefore: 60,  lunchLen: 50 },
  fast:   { maxRides: 16, walk: 0.85, breakEvery: 0,   breakLen: 0,  arriveAfter: -15, leaveBefore: 0,   lunchLen: 30 },
};

// Notes personnelles à ignorer (événements exceptionnels)
export const IGNORED_NOTES = ["pluie", "memorial day", "ouverture epic universe"];

// ------------------------------------------------------------------ dates & heures

export function weekdayOf(isoDate) {
  const d = new Date(isoDate + "T12:00:00Z").getUTCDay(); // 0 = dimanche
  return (d + 6) % 7;
}

export function addDays(isoDate, n) {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dateRange(start, end, max = 45) {
  const out = [];
  for (let d = start; d <= end && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

export function fmtTime(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function slotKey(min) {
  const h = Math.floor(min / 60), m = min % 60 < 30 ? 0 : 30;
  return `${String(h).padStart(2, "0")}:${m ? "30" : "00"}`;
}

const slotToMin = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);

/** Heure actuelle à Orlando : { date: "AAAA-MM-JJ", min, wd } */
export function orlandoNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, min: +parts.hour * 60 + +parts.minute, wd: weekdayOf(date) };
}

// ------------------------------------------------------------------ hasard reproductible

export function rng(seed) {
  let s = 0;
  for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ modèle d'attente

// Forme typique d'une journée (multiplicateur de l'attente moyenne), par heure pleine
const PROFILE = { 7: 0.5, 8: 0.55, 9: 0.7, 10: 0.95, 11: 1.1, 12: 1.2, 13: 1.25, 14: 1.25, 15: 1.2,
  16: 1.1, 17: 1.0, 18: 0.95, 19: 0.85, 20: 0.7, 21: 0.55, 22: 0.45, 23: 0.4 };

export function profileAt(min) {
  const h = Math.min(23, Math.max(7, min / 60));
  const lo = Math.floor(h), hi = Math.min(23, lo + 1);
  return PROFILE[lo] + (PROFILE[hi] - PROFILE[lo]) * (h - lo);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * Estime l'attente d'une attraction à un créneau donné.
 * Mélange stats.json (notre collecte) et une estimation par défaut (base_wait x profil horaire),
 * pondérée par la quantité de données disponibles pour l'attraction.
 */
export function createWaitModel(stats, meta) {
  stats = stats || { rides: {}, parks: {} };
  const rides = stats.rides || {};
  const parks = stats.parks || {};
  const cache = new Map();

  function weekdayFactor(park, wd) {
    const bw = parks[park]?.by_weekday || {};
    const vals = Object.values(bw);
    if (vals.length < 3 || bw[wd] == null) return 1;
    return Math.min(1.4, Math.max(0.7, bw[wd] / mean(vals)));
  }

  function rideInfo(id) {
    if (cache.has(id)) return cache.get(id);
    const r = rides[id];
    let info = null;
    if (r) {
      let n = 0;
      const level = [];
      for (const [, slots] of Object.entries(r.slots)) {
        for (const [s, v] of Object.entries(slots)) {
          n++;
          level.push(v / profileAt(slotToMin(s) + 15));
        }
      }
      info = { n, level: mean(level), conf: Math.min(1, n / 40) };
    }
    cache.set(id, info);
    return info;
  }

  function fallback(id, wd, min) {
    const m = meta[id];
    const base = m?.base_wait ?? 20;
    return base * profileAt(min) * weekdayFactor(m?.park, wd);
  }

  function fromStats(id, wd, min) {
    const r = rides[id];
    const slot = slotKey(min);
    const exact = r.slots[wd]?.[slot];
    if (exact != null) return exact;
    const same = Object.values(r.slots).map((d) => d[slot]).filter((v) => v != null);
    if (same.length) return mean(same) * weekdayFactor(r.park, wd);
    return rideInfo(id).level * profileAt(min) * weekdayFactor(r.park, wd);
  }

  /** Attente moyenne attendue (minutes) */
  function expected(id, wd, min) {
    const fb = fallback(id, wd, min);
    const info = rideInfo(id);
    if (!info || !info.n) return Math.round(fb);
    return Math.round(info.conf * fromStats(id, wd, min) + (1 - info.conf) * fb);
  }

  /** Horaires du parc : déduits de stats.json si assez de jours collectés, sinon valeurs par défaut */
  function parkHours(park, wd) {
    const p = PARK_BY_ID[park];
    const def = { open: p?.open ?? 540, close: p?.close ?? 1260, source: "default" };
    if (Object.keys(parks[park]?.by_date || {}).length < 3) return def;
    let lo = Infinity, hi = -Infinity;
    for (const r of Object.values(rides)) {
      if (r.park !== park) continue;
      const days = r.slots[wd] ? [r.slots[wd]] : Object.values(r.slots);
      for (const d of days) for (const s of Object.keys(d)) {
        const m = slotToMin(s);
        lo = Math.min(lo, m); hi = Math.max(hi, m + 30);
      }
    }
    if (hi - lo < 360) return def;
    return { open: lo, close: hi, source: "stats" };
  }

  /** Courbe de la journée par créneau de 30 min */
  function curve(id, wd, from, to) {
    const out = [];
    for (let m = Math.floor(from / 30) * 30; m < to; m += 30) out.push({ min: m, wait: expected(id, wd, m + 15) });
    return out;
  }

  return { expected, parkHours, curve, weekdayFactor, hasData: (id) => !!rideInfo(id)?.n };
}

// ------------------------------------------------------------------ couleurs

export function waitLevel(w) {
  if (w == null) return "none";
  if (w < 20) return "green";
  if (w < 45) return "yellow";
  if (w < 75) return "orange";
  return "red";
}

// ------------------------------------------------------------------ notes personnelles

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const PARK_NUMERIC = { 334: "epic_universe", 64: "islands_of_adventure", 65: "universal_studios_florida",
  8: "animal_kingdom", 7: "hollywood_studios", 6: "magic_kingdom", 5: "epcot" };

/** Lit le CSV `date,park,weekday,crowd_pct,note`. Renvoie { notes, ignored, invalid } */
export function parseNotes(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { notes: [], ignored: 0, invalid: 0 };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = head.includes("date") && head.includes("park");
  const idx = (name, def) => (hasHeader && head.indexOf(name) >= 0 ? head.indexOf(name) : def);
  const iDate = idx("date", 0), iPark = idx("park", 1), iPct = idx("crowd_pct", 3), iNote = idx("note", 4);
  const notes = [];
  let ignored = 0, invalid = 0;
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const date = (r[iDate] || "").trim();
    let park = (r[iPark] || "").trim();
    if (PARK_NUMERIC[park]) park = PARK_NUMERIC[park];
    const pct = parseFloat((r[iPct] || "").replace("%", "").replace(",", "."));
    const note = (r[iNote] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !PARK_BY_ID[park] || !isFinite(pct)) { invalid++; continue; }
    const low = note.toLowerCase();
    if (IGNORED_NOTES.some((x) => low.includes(x))) { ignored++; continue; }
    notes.push({ date, park, crowd: pct });
  }
  return { notes, ignored, invalid };
}

// ------------------------------------------------------------------ affluence par jour

/**
 * Score d'affluence 0 (calme) ... 1 (chargé) pour un parc à une date.
 * Avec notes : classement du jour *au sein du même parc* (percentile parmi les notes de ce parc).
 * Sans notes : attente moyenne du parc ce jour de semaine (stats.json) relative à sa moyenne.
 */
export function crowdScorer(stats, notes) {
  const byPark = {};
  for (const n of notes || []) (byPark[n.park] ||= []).push(n);
  for (const list of Object.values(byPark)) list.sorted = list.map((n) => n.crowd).sort((a, b) => a - b);

  const doy = (iso) => {
    const d = new Date(iso + "T12:00:00Z");
    return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);
  };

  return function score(park, date) {
    const wd = weekdayOf(date);
    const list = byPark[park];
    if (list && list.length >= 5) {
      const target = doy(date);
      const sameWd = list.filter((n) => weekdayOf(n.date) === wd);
      const near = sameWd.filter((n) => {
        const d = Math.abs(doy(n.date) - target);
        return Math.min(d, 365 - d) <= 21;
      });
      const pool = near.length >= 2 ? near : sameWd.length ? sameWd : list;
      const v = mean(pool.map((n) => n.crowd));
      const below = list.sorted.filter((x) => x < v).length;
      const equal = list.sorted.filter((x) => x === v).length;
      return { score: (below + equal / 2) / list.sorted.length, value: Math.round(v), source: "notes" };
    }
    const bw = stats?.parks?.[park]?.by_weekday || {};
    const vals = Object.values(bw);
    if (bw[wd] != null && vals.length >= 3) {
      const rel = bw[wd] / mean(vals);
      return { score: Math.min(1, Math.max(0, (rel - 0.85) / 0.3)), value: bw[wd], source: "stats" };
    }
    return { score: 0.5, value: null, source: "none" };
  };
}

export const crowdLevel = (s) => (s < 0.34 ? "low" : s < 0.67 ? "mid" : "high");

// ------------------------------------------------------------------ calendrier du séjour

/**
 * Choisit un parc par jour.
 * settings : { start, end, parks:[], forced:[{date, park|'rest'}], mustDo:[] }
 * Renvoie [{ date, wd, park|null, forced, crowd }]
 */
export function planTrip(settings, stats, notes, meta) {
  const dates = dateRange(settings.start, settings.end);
  const scorer = crowdScorer(stats, notes);
  const forced = {};
  for (const f of settings.forced || []) if (dates.includes(f.date) && f.park) forced[f.date] = f.park;
  const selected = (settings.parks || []).filter((p) => PARK_BY_ID[p]);
  if (!selected.length) return dates.map((date) => ({ date, wd: weekdayOf(date), park: null, forced: false }));

  const assign = { ...forced };
  const free = dates.filter((d) => !forced[d]);
  const visits = Object.fromEntries(selected.map((p) => [p, 0]));
  for (const p of Object.values(forced)) if (p in visits) visits[p]++;

  // Combien de jours pour chaque parc : 1 minimum, le reste réparti selon l'intérêt
  const mustCount = {};
  for (const id of settings.mustDo || []) {
    const p = meta[id]?.park;
    if (p) mustCount[p] = (mustCount[p] || 0) + 1;
  }
  const weight = (p) => PARK_BY_ID[p].weight + 0.08 * (mustCount[p] || 0);
  const target = { ...visits };
  let left = free.length;
  for (const p of [...selected].sort((a, b) => weight(b) - weight(a))) {
    if (left > 0 && target[p] === 0) { target[p] = 1; left--; }
  }
  while (left > 0) {
    // le parc dont le ratio visites / poids est le plus faible reçoit un jour de plus
    const p = [...selected].sort((a, b) => target[a] / weight(a) - target[b] / weight(b) || weight(b) - weight(a))[0];
    target[p]++; left--;
  }
  const need = Object.fromEntries(selected.map((p) => [p, Math.max(0, target[p] - visits[p])]));

  // Affectation gloutonne : les couples (parc, jour) les plus calmes d'abord
  const pairs = [];
  for (const p of selected) for (const d of free) pairs.push({ p, d, s: scorer(p, d).score });
  pairs.sort((a, b) => a.s - b.s || a.d.localeCompare(b.d));
  for (const { p, d } of pairs) {
    if (need[p] > 0 && !assign[d]) { assign[d] = p; need[p]--; }
  }

  // Amélioration par échanges : moins d'affluence, pas deux jours de suite au même parc
  const cost = () => {
    let c = 0;
    dates.forEach((d, i) => {
      const p = assign[d];
      if (!p || p === "rest") return;
      c += scorer(p, d).score;
      if (i > 0 && assign[dates[i - 1]] === p) c += 0.6;
    });
    return c;
  };
  let best = cost(), improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
      const a = free[i], b = free[j];
      if (assign[a] === assign[b]) continue;
      [assign[a], assign[b]] = [assign[b], assign[a]];
      const c = cost();
      if (c < best - 1e-9) { best = c; improved = true; }
      else [assign[a], assign[b]] = [assign[b], assign[a]];
    }
  }

  return dates.map((date) => {
    const p = assign[date];
    const park = p && p !== "rest" ? p : null;
    return { date, wd: weekdayOf(date), park, rest: p === "rest", forced: !!forced[date],
      crowd: park ? scorer(park, date) : null };
  });
}

// ------------------------------------------------------------------ journée

const TYPE_PREF = {
  kids:   { kids: 3, family: 2.5, show: 1, thrill: -1 },
  normal: { thrill: 2, family: 1.5, show: 0, kids: -1.5 },
};

/** Attractions possibles dans un parc, compte tenu de la taille de l'enfant */
export function eligibleRides(park, settings, meta) {
  const kids = settings.kids?.enabled;
  const h = +settings.kids?.height || 0;
  return Object.entries(meta)
    .filter(([, m]) => m.park === park && !(kids && m.height > h))
    .map(([id]) => id);
}

function walkTime(catalog, meta, from, to, pace) {
  if (!to) return 0;
  const land = (id) => catalog?.[id]?.land || meta[id]?.land || id;
  let w = !from ? 8 : land(from) === land(to) ? 4 : 10;
  return Math.round(w * pace.walk);
}

/**
 * Programme d'une journée dans un parc.
 * opts : { park, date, wd, settings, model, meta, catalog,
 *          from?, to?, done?:Set, live?:{waits:{id:{open,wait}}, now}, seed? }
 */
export function planDay(opts) {
  const { park, wd, settings, model, meta, catalog = {} } = opts;
  const pace = PACES[settings.pace] || PACES.normal;
  const hours = model.parkHours(park, wd);
  const start = Math.max(opts.from ?? hours.open + pace.arriveAfter, hours.open - 30);
  const end = opts.to ?? hours.close - pace.leaveBefore;
  const done = opts.done || new Set();
  const isDisney = PARK_BY_ID[park]?.group === "disney";
  const kidsMode = !!settings.kids?.enabled;
  const pref = TYPE_PREF[kidsMode ? "kids" : "normal"];
  const random = rng(`${opts.seed ?? ""}|${opts.date}|${park}`);

  const eligible = eligibleRides(park, settings, meta).filter((id) => !done.has(id));
  const closedLive = new Set();
  if (opts.live) for (const id of eligible) if (opts.live.waits[id] && !opts.live.waits[id].open) closedLive.add(id);
  const must = new Set((settings.mustDo || []).filter((id) => eligible.includes(id)));

  // Sélection des candidates
  const score = (id) => {
    const m = meta[id];
    let s = (m.base_wait || 10) / 12 + (pref[m.type] || 0);
    if (settings.surprise) s += random() * 4;
    return s;
  };
  const extras = eligible.filter((id) => !must.has(id)).sort((a, b) => score(b) - score(a));
  const capacity = Math.max(0, pace.maxRides - (opts.alreadyDone || 0));
  const ranked = [...must, ...extras].filter((id) => !closedLive.has(id));
  const primary = ranked.slice(0, Math.max(capacity, must.size));
  const pool = ranked.slice(0, primary.length + 6); // les suivantes servent de réserve

  // Coupe-files
  const llAccess = new Set();
  if (isDisney) {
    if (settings.ll?.single) for (const id of pool) if (meta[id].ll === "single") llAccess.add(id);
    if (settings.ll?.multi) {
      pool.filter((id) => meta[id].ll === "multi")
        .sort((a, b) => (must.has(b) - must.has(a)) || meta[b].base_wait - meta[a].base_wait)
        .slice(0, 3).forEach((id) => llAccess.add(id));
    }
  }
  const express = !isDisney && settings.express;

  // Attente effective à l'instant t (avec ajustement en direct si fourni)
  const liveAdj = {};
  if (opts.live) {
    for (const id of pool) {
      const l = opts.live.waits[id];
      if (l?.open && typeof l.wait === "number" && l.wait > 0) {
        const exp = Math.max(5, model.expected(id, wd, opts.live.now));
        liveAdj[id] = { now: l.wait, ratio: Math.min(2, Math.max(0.5, l.wait / exp)) };
      }
    }
  }
  const rawWait = (id, t) => {
    const exp = model.expected(id, wd, t);
    const adj = liveAdj[id];
    if (!adj) return exp;
    const dt = t - opts.live.now;
    if (dt < 20) return adj.now;
    const k = Math.max(0, 1 - dt / 180);
    return Math.round(exp * (1 + (adj.ratio - 1) * k));
  };
  const effWait = (id, t) => {
    const w = rawWait(id, t);
    if (llAccess.has(id)) return Math.min(w, 10);
    if (express && meta[id].express) return Math.min(w, Math.max(5, Math.round(w * 0.3)));
    return w;
  };
  // Attente minimale et moyenne sur le reste de la journée probable
  const later = (id, from, dur, horizon) => {
    let min = effWait(id, from), sum = min, n = 1;
    for (let t = from + 30; t <= Math.min(end, horizon) - dur; t += 30) {
      const w = effWait(id, t);
      min = Math.min(min, w); sum += w; n++;
    }
    return { min, avg: sum / n };
  };

  const items = [];
  let t = start, last = opts.lastRide || null, count = 0, sinceBreak = 0;
  const lunch = settings.lunch?.enabled && opts.lunchDone !== true
    ? { at: +settings.lunch.at || 720, len: pace.lunchLen } : null;
  let lunchDone = !lunch || (opts.from != null && opts.from > (lunch?.at ?? 0) + 90);
  let remaining = new Set(primary);
  const backup = pool.filter((id) => !remaining.has(id));
  items.push({ kind: "start", at: t });

  while (count < capacity && t < end) {
    if (!remaining.size) {
      if (!backup.length) break;
      remaining = new Set(backup.splice(0));
    }
    if (!lunchDone && t >= lunch.at) {
      items.push({ kind: "lunch", at: t, end: t + lunch.len });
      t += lunch.len; lunchDone = true; sinceBreak = 0; continue;
    }
    if (pace.breakEvery && sinceBreak >= pace.breakEvery) {
      items.push({ kind: "break", at: t, end: t + pace.breakLen });
      t += pace.breakLen; sinceBreak = 0; continue;
    }
    let best = null;
    // jusqu'où la journée ira probablement, au rythme d'environ 40 min par attraction
    const horizon = t + Math.min(remaining.size, capacity - count) * 40 + 30;
    for (const id of remaining) {
      const m = meta[id];
      const walk = walkTime(catalog, meta, last, id, pace);
      const arrive = t + walk;
      const wait = effWait(id, arrive);
      const finish = arrive + wait + m.duration;
      if (finish > end) continue;
      // On choisit l'attraction pour laquelle c'est *maintenant* le meilleur moment :
      // attente actuelle comparée au reste de la journée (et non attente brute).
      const l = later(id, arrive, m.duration, horizon);
      const cost = (wait - l.avg) + 1.3 * (wait - l.min) + walk
        - (must.has(id) ? 15 : 0) - 2 * (pref[m.type] || 0);
      if (!best || cost < best.cost) best = { id, walk, arrive, wait, finish, cost };
    }
    if (!best) {
      if (!backup.length) break;
      remaining = new Set(backup.splice(0));
      continue;
    }
    // Si le déjeuner tombe pendant cette attraction, on la garde et on mange juste après
    remaining.delete(best.id);
    items.push({
      kind: "ride", id: best.id, at: best.arrive, walk: best.walk, wait: best.wait,
      end: best.finish, must: must.has(best.id),
      ll: llAccess.has(best.id) ? (meta[best.id].ll === "single" ? "single" : "multi") : null,
      express: express && meta[best.id].express,
      live: !!liveAdj[best.id] && best.arrive - (opts.live?.now ?? 0) < 20,
    });
    sinceBreak += best.finish - t;
    t = best.finish; last = best.id; count++;
  }
  if (!lunchDone && t < end) {
    items.push({ kind: "lunch", at: Math.max(t, lunch.at), end: Math.max(t, lunch.at) + lunch.len });
    t = Math.max(t, lunch.at) + lunch.len;
  }
  items.push({ kind: "end", at: Math.min(Math.max(t, start), end + 60) });

  const planned = new Set(items.filter((i) => i.kind === "ride").map((i) => i.id));
  return {
    items, start, end, hours,
    skippedMust: [...must].filter((id) => !planned.has(id)),
    closed: [...closedLive],
    totalWait: items.reduce((s, i) => s + (i.wait || 0), 0),
  };
}

/** « Que faire maintenant ? » : attractions dont l'attente en direct est la meilleure affaire */
export function suggestNow({ park, wd, settings, model, meta, catalog, waits, now, done, last }) {
  const pace = PACES[settings.pace] || PACES.normal;
  const hours = model.parkHours(park, wd);
  const kidsMode = !!settings.kids?.enabled;
  const pref = TYPE_PREF[kidsMode ? "kids" : "normal"];
  const must = new Set(settings.mustDo || []);
  const out = [];
  for (const id of eligibleRides(park, settings, meta)) {
    if (done?.has(id)) continue;
    const l = waits[id];
    if (!l || !l.open || typeof l.wait !== "number") continue;
    const m = meta[id];
    let later = Infinity;
    for (let t = now + 30; t <= hours.close - m.duration; t += 30) later = Math.min(later, model.expected(id, wd, t));
    if (!isFinite(later)) later = l.wait;
    const usual = model.expected(id, wd, now);
    const walk = walkTime(catalog, meta, last, id, pace);
    const gain = usual - l.wait;
    const score = (later - l.wait) + gain * 0.5 + (must.has(id) ? 20 : 0) + 3 * (pref[m.type] || 0) - walk - l.wait * 0.3;
    out.push({ id, wait: l.wait, usual, later, walk, score, must: must.has(id) });
  }
  return out.sort((a, b) => b.score - a.score);
}
