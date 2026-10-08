import * as P from "./planner.js";

// ------------------------------------------------------------------ stockage local (try/catch partout)

const store = {
  get(key, def) {
    try {
      const v = localStorage.getItem("op." + key);
      return v == null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem("op." + key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
  del(key) {
    try { localStorage.removeItem("op." + key); } catch { /* idem */ }
  },
};

// ------------------------------------------------------------------ état

const DEFAULT_SETTINGS = {
  start: "2027-05-01",
  end: "2027-05-15",
  parks: P.PARKS.map((p) => p.id),
  ll: { multi: true, single: false },
  express: false,
  kids: { enabled: false, height: 110 },
  pace: "normal",
  lunch: { enabled: true, at: 720 },
  forced: [],
  mustDo: [],
  surprise: false,
};

const state = {
  lang: store.get("lang", (navigator.language || "fr").startsWith("fr") ? "fr" : "en"),
  tab: "setup",
  step: store.get("step", 0),
  settings: { ...structuredClone(DEFAULT_SETTINGS), ...store.get("settings", {}) },
  configured: store.get("configured", false),
  // Fichiers personnels importés (jamais envoyés) :
  notes: store.get("notes", null),           // may_crowds      { notes:[], ignored, invalid, rows, file, at }
  priorities: store.get("priorities", null), // ride_priorities { byId:{id:{avg,max,tier}}, rows, matched, unmatched, file, at }
  patterns: store.get("patterns", null),     // park_patterns   { byPark, rows, invalid, file, at }
  importMsgs: [],
  seeds: store.get("seeds", {}),
  dayDate: null,
  livePark: null,
  search: "",
  i18n: {},
  meta: {},
  catalog: {},
  stats: null,
  latest: null,
  latestAt: 0,
};

const saveSettings = () => store.set("settings", state.settings);

// ------------------------------------------------------------------ utilitaires

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function t(key, vars = {}) {
  const s = state.i18n[state.lang]?.[key] ?? state.i18n.fr?.[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

const rideName = (id) => (state.catalog[id]?.name || state.meta[id]?.name || id).replace(/[™®]/g, "");
const parkOf = (id) => P.PARK_BY_ID[id];

function fmtDate(iso, opts = { weekday: "short", day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat(state.lang === "fr" ? "fr-FR" : "en-US", { ...opts, timeZone: "UTC" })
    .format(new Date(iso + "T12:00:00Z"));
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return t("ago_min", { n: mins });
  if (mins < 48 * 60) return t("ago_h", { n: Math.round(mins / 60) });
  return t("ago_d", { n: Math.round(mins / 1440) });
}

function waitChip(w, extra = "") {
  const lvl = P.waitLevel(w);
  return `<span class="wait ${lvl} ${extra}">${w == null ? "–" : Math.round(w)}<small>${t("min")}</small></span>`;
}

function typeBadge(id) {
  const m = state.meta[id];
  return m ? `<span class="badge ${m.type}">${t("type_" + m.type)}</span>` : "";
}

function tierBadge(id) {
  const tier = prioById()[id]?.tier;
  return tier ? `<span class="badge tier tier-${tier}" title="${esc(t("tier_" + tier))}">${tier}</span>` : "";
}

function crowdTag(c) {
  if (!c || c.source === "none") return `<span class="crowd none"><i></i>${t("crowd_none")}</span>`;
  const lvl = P.crowdLevel(c.score);
  const src = t({ notes: "src_notes", patterns: "src_patterns" }[c.source] || "src_stats");
  return `<span class="crowd ${lvl}" title="${esc(src)}"><i></i>${t("crowd_" + lvl)}</span>`;
}

// ------------------------------------------------------------------ données

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function dataBases() {
  const cfg = window.OP_CONFIG || {};
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  return [...(local && cfg.localDataBase ? [cfg.localDataBase] : []), cfg.dataBase].filter(Boolean);
}

async function loadData() {
  let lastErr;
  for (const base of dataBases()) {
    try {
      const [catalog, stats] = await Promise.all([fetchJson(base + "rides.json"), fetchJson(base + "stats.json")]);
      state.base = base;
      state.catalog = catalog;
      state.stats = stats;
      refreshLatest();
      return;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("no data base");
}

async function refreshLatest() {
  if (!state.base) return;
  try {
    state.latest = await fetchJson(state.base + "latest.json", { cache: "no-cache" });
    state.latestAt = Date.now();
    updateFooter();
    if (state.tab === "live") render();
  } catch { /* hors connexion : on garde la précédente */ }
}

let model = null, modelKey = "";
function getModel() {
  const key = `${state.stats?.generated}|${state.priorities?.at}`;
  if (!model || key !== modelKey) {
    model = P.createWaitModel(state.stats, state.meta, state.priorities?.byId);
    modelKey = key;
  }
  return model;
}
const prioById = () => state.priorities?.byId || {};

// ------------------------------------------------------------------ calcul du séjour (mémorisé)

let tripCache = { key: "", trip: [] };
function trip() {
  const key = JSON.stringify([state.settings, state.notes?.at, state.patterns?.at, state.stats?.generated]);
  if (tripCache.key !== key) {
    tripCache = { key, trip: P.planTrip(state.settings, state.stats, state.notes?.notes || [], state.meta,
      state.patterns?.byPark) };
  }
  return tripCache.trip;
}

function dayPlan(date, park) {
  return P.planDay({
    park, date, wd: P.weekdayOf(date), settings: state.settings, model: getModel(),
    meta: state.meta, catalog: state.catalog, seed: state.seeds[date] || 0, priorities: prioById(),
  });
}

// ------------------------------------------------------------------ rendu général

function render() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  $("#btn-lang").textContent = t("lang_switch");
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === state.tab);
  const main = $("#main");
  const view = { setup: viewSetup, calendar: viewCalendar, day: viewDay, live: viewLive }[state.tab] || viewSetup;
  main.innerHTML = view();
  updateFooter();
  updateClock();
}

function updateClock() {
  const now = P.orlandoNow();
  $("#clock").textContent = `${P.fmtTime(now.min)} · ${t("orlando_time")}`;
}

function updateFooter() {
  const parts = [];
  if (state.latest?.updated) parts.push(t("data_updated", { ago: ago(state.latest.updated) }));
  if (state.stats?.generated) parts.push(t("stats_updated", { date: state.stats.generated.slice(0, 10) }));
  $("#data-info").textContent = parts.join(" · ");
}

function go(tab) {
  if (location.hash !== "#" + tab) history.pushState(null, "", "#" + tab);
  state.tab = tab;
  render();
  window.scrollTo({ top: 0 });
  if (tab === "live") refreshLatest();
}

// ------------------------------------------------------------------ assistant de configuration

const STEPS = ["dates", "parks", "passes", "kids", "pace", "forced", "must"];

function viewSetup() {
  const s = state.settings;
  const step = Math.min(state.step, STEPS.length - 1);
  const valid = stepValid(STEPS[step]);
  const dots = STEPS.map((_, i) => `<span class="${i <= step ? "on" : ""}" data-action="step" data-step="${i}"></span>`).join("");
  return `
  <section class="card">
    <div class="steps">${dots}</div>
    <p class="step-label">${t("step", { n: step + 1, total: STEPS.length })}</p>
    ${{ dates: stepDates, parks: stepParks, passes: stepPasses, kids: stepKids, pace: stepPace, forced: stepForced, must: stepMust }[STEPS[step]](s)}
    <div class="wizard-nav">
      <button class="pill ghost" data-action="prev" ${step === 0 ? "disabled" : ""}>← ${t("prev")}</button>
      ${step < STEPS.length - 1
        ? `<button class="pill" data-action="next" ${valid ? "" : "disabled"}>${t("next")} →</button>`
        : `<button class="pill" data-action="finish" ${valid ? "" : "disabled"}>${t("finish")} →</button>`}
    </div>
  </section>
  ${importsCard()}`;
}

function stepValid(name) {
  const s = state.settings;
  if (name === "dates") {
    return !!(s.start && s.end && s.end >= s.start && P.dateRange(s.start, s.end, 46).length <= 45);
  }
  if (name === "parks") return s.parks.length > 0;
  return true;
}

function stepDates(s) {
  const n = stepValid("dates") ? P.dateRange(s.start, s.end).length : 0;
  return `
    <h2>${t("s_dates")}</h2><p class="muted small">${t("s_dates_help")}</p>
    <div class="two">
      <label class="field"><span>${t("date_start")}</span><input type="date" data-set="start" value="${esc(s.start)}"></label>
      <label class="field"><span>${t("date_end")}</span><input type="date" data-set="end" value="${esc(s.end)}" min="${esc(s.start)}"></label>
    </div>
    <p class="small ${n ? "muted" : ""}" style="${n ? "" : "color:var(--red)"}">${n ? t("days_count", { n }) : t("dates_invalid")}</p>`;
}

function stepParks(s) {
  const group = (g) => `
    <div class="group-title"><span class="dot ${g}"></span>${t(g)}</div>
    ${P.PARKS.filter((p) => p.group === g).map((p) => `
      <label class="choice"><input type="checkbox" data-park="${p.id}" ${s.parks.includes(p.id) ? "checked" : ""}>
        <span>${p.emoji} <b style="display:inline">${p.name}</b></span></label>`).join("")}`;
  return `<h2>${t("s_parks")}</h2><p class="muted small">${t("s_parks_help")}</p>
    ${group("disney")}${group("universal")}
    ${s.parks.length ? "" : `<p class="small" style="color:var(--red)">${t("parks_none")}</p>`}`;
}

function stepPasses(s) {
  const hasDisney = s.parks.some((p) => parkOf(p).group === "disney");
  const hasUni = s.parks.some((p) => parkOf(p).group === "universal");
  return `<h2>${t("s_passes")}</h2><p class="muted small">${t("s_passes_help")}</p>
    ${hasDisney ? `<div class="group-title"><span class="dot disney"></span>${t("disney")}</div>
      <label class="choice"><input type="checkbox" data-set="ll.multi" ${s.ll.multi ? "checked" : ""}>
        <span><b>${t("ll_multi")}</b><small>${t("ll_multi_help")}</small></span></label>
      <label class="choice"><input type="checkbox" data-set="ll.single" ${s.ll.single ? "checked" : ""}>
        <span><b>${t("ll_single")}</b><small>${t("ll_single_help")}</small></span></label>` : ""}
    ${hasUni ? `<div class="group-title"><span class="dot universal"></span>${t("universal")}</div>
      <label class="choice"><input type="checkbox" data-set="express" ${s.express ? "checked" : ""}>
        <span><b>${t("express")}</b><small>${t("express_help")}</small></span></label>` : ""}`;
}

function stepKids(s) {
  const hidden = s.kids.enabled
    ? Object.values(state.meta).filter((m) => s.parks.includes(m.park) && m.height > (+s.kids.height || 0)).length : 0;
  return `<h2>${t("s_kids")}</h2><p class="muted small">${t("s_kids_help")}</p>
    <label class="choice"><input type="checkbox" data-set="kids.enabled" ${s.kids.enabled ? "checked" : ""}>
      <span><b>${t("kids_on")}</b></span></label>
    ${s.kids.enabled ? `
      <label class="field"><span>${t("kids_height")}</span>
        <input type="number" inputmode="numeric" min="60" max="200" step="1" data-set="kids.height" value="${esc(s.kids.height)}"></label>
      <p class="small muted" id="kids-hidden">${t("kids_hidden", { n: hidden })}</p>` : ""}`;
}

function stepPace(s) {
  const opt = (id) => `
    <label class="choice"><input type="radio" name="pace" data-set="pace" value="${id}" ${s.pace === id ? "checked" : ""}>
      <span><b>${t("pace_" + id)}</b><small>${t("pace_" + id + "_d")}</small></span></label>`;
  const times = [];
  for (let m = 660; m <= 840; m += 30) times.push(m);
  return `<h2>${t("s_pace")}</h2><p class="muted small">${t("s_pace_help")}</p>
    ${opt("chill")}${opt("normal")}${opt("fast")}
    <label class="choice"><input type="checkbox" data-set="lunch.enabled" ${s.lunch.enabled ? "checked" : ""}>
      <span><b>${t("lunch_on")}</b></span></label>
    ${s.lunch.enabled ? `<label class="field"><span>${t("lunch_at")}</span>
      <select data-set="lunch.at">${times.map((m) => `<option value="${m}" ${+s.lunch.at === m ? "selected" : ""}>${P.fmtTime(m)}</option>`).join("")}</select></label>` : ""}`;
}

function stepForced(s) {
  const dates = stepValid("dates") ? P.dateRange(s.start, s.end) : [];
  const rows = s.forced.map((f, i) => `
    <div class="forced-row">
      <select data-forced="${i}" data-key="date">${dates.map((d) => `<option value="${d}" ${d === f.date ? "selected" : ""}>${esc(fmtDate(d))}</option>`).join("")}</select>
      <select data-forced="${i}" data-key="park">
        ${s.parks.map((p) => `<option value="${p}" ${p === f.park ? "selected" : ""}>${parkOf(p).emoji} ${parkOf(p).name}</option>`).join("")}
        <option value="rest" ${f.park === "rest" ? "selected" : ""}>😴 ${t("rest_day")}</option>
      </select>
      <button class="pill ghost danger" data-action="forced-del" data-i="${i}" aria-label="${t("remove")}">✕</button>
    </div>`).join("");
  return `<h2>${t("s_forced")}</h2><p class="muted small">${t("s_forced_help")}</p>
    ${rows || `<p class="muted small">${t("forced_none")}</p>`}
    <button class="pill ghost" data-action="forced-add" ${dates.length ? "" : "disabled"}>+ ${t("forced_add")}</button>`;
}

function stepMust(s) {
  return `<h2>${t("s_must")}</h2><p class="muted small">${t("s_must_help")}</p>
    <label class="choice"><input type="checkbox" data-set="surprise" ${s.surprise ? "checked" : ""}>
      <span><b>🎲 ${t("surprise")}</b><small>${t("surprise_help")}</small></span></label>
    ${s.surprise ? "" : `
      <div class="row gap" style="margin-top:8px">
        <input type="search" id="must-search" class="grow" placeholder="${t("search")}" value="${esc(state.search)}">
        <span class="badge must" id="must-count">${t("must_count", { n: s.mustDo.length })}</span>
      </div>
      <div class="must-list" id="must-list">${mustList()}</div>`}`;
}

function mustList() {
  const s = state.settings;
  const q = state.search.trim().toLowerCase();
  const kids = s.kids.enabled;
  return P.PARKS.filter((p) => s.parks.includes(p.id)).map((p) => {
    const ids = P.eligibleRides(p.id, s, state.meta)
      .filter((id) => !q || rideName(id).toLowerCase().includes(q))
      .sort((a, b) => {
        if (kids) {
          const fa = ["kids", "family"].includes(state.meta[a].type), fb = ["kids", "family"].includes(state.meta[b].type);
          if (fa !== fb) return fb - fa;
        }
        return state.meta[b].base_wait - state.meta[a].base_wait;
      });
    if (!ids.length) return "";
    return `<div class="group-title"><span class="dot ${p.group}"></span>${p.emoji} ${p.name}</div>` + ids.map((id) => {
      const m = state.meta[id];
      const fam = kids && ["kids", "family"].includes(m.type);
      return `<label class="must-item ${fam ? "fam" : ""}">
        <input type="checkbox" data-must="${id}" ${s.mustDo.includes(id) ? "checked" : ""}>
        <span class="grow"><span class="name">${esc(rideName(id))}</span>
          <span class="badges">${tierBadge(id)}${typeBadge(id)}<span class="badge">${m.height ? t("height_min", { cm: m.height }) : t("no_height")}</span></span></span>
      </label>`;
    }).join("");
  }).join("");
}

// ------------------------------------------------------------------ calendrier

function needSetup() {
  return `<div class="card center"><p>${t("setup_first")}</p><button class="pill big" data-action="tab" data-tab="setup">${t("go_setup")}</button></div>`;
}

function viewCalendar() {
  if (!state.configured) return needSetup();
  const days = trip();
  const parkDays = days.filter((d) => d.park).length;
  const notesInfo = importsSummary();
  return `
    <section class="card soft">
      <h2>${t("cal_title")}</h2>
      <p class="muted small">${esc(fmtDate(state.settings.start, { day: "numeric", month: "long" }))} → ${esc(fmtDate(state.settings.end, { day: "numeric", month: "long", year: "numeric" }))} · ${t("summary_parks", { n: parkDays })}</p>
      <p class="muted small">${t("cal_help")}</p>
      <p class="small">${esc(notesInfo)}</p>
    </section>
    ${days.map((d) => {
      const p = d.park && parkOf(d.park);
      return `<button class="cal-day ${p ? p.group : ""}" data-action="open-day" data-date="${d.date}">
        <span class="cal-date"><small>${esc(fmtDate(d.date, { weekday: "short" }))}</small><b>${+d.date.slice(8)}</b><small>${esc(fmtDate(d.date, { month: "short" }))}</small></span>
        <span class="cal-emoji">${p ? p.emoji : "😴"}</span>
        <span class="grow">
          <span class="cal-park">${p ? p.name : t("rest_day")}</span>
          ${d.forced ? `<span class="badge">📌 ${t("forced")}</span>` : ""}<br>
          ${p ? crowdTag(d.crowd) : ""}
        </span>
        <span class="muted">›</span>
      </button>`;
    }).join("")}`;
}

// ------------------------------------------------------------------ journée

function sparkline(id, wd, from, to, highlight) {
  const pts = getModel().curve(id, wd, from, to);
  if (!pts.length) return "";
  const max = Math.max(30, ...pts.map((p) => p.wait));
  const bw = 6, h = 34;
  const bars = pts.map((p, i) => {
    const bh = Math.max(2, (p.wait / max) * (h - 2));
    const on = highlight != null && highlight >= p.min && highlight < p.min + 30;
    return `<rect x="${i * bw + 0.5}" y="${h - bh}" width="${bw - 1.5}" height="${bh}" rx="1.5"
      fill="var(--${P.waitLevel(p.wait)})" opacity="${on ? 1 : 0.35}"><title>${P.fmtTime(p.min)} · ${p.wait} min</title></rect>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${pts.length * bw} ${h}" preserveAspectRatio="none" role="img" aria-label="${t("curve")}">${bars}</svg>
    <div class="spark-axis"><span>${P.fmtTime(pts[0].min)}</span><span>${P.fmtTime(pts[pts.length - 1].min + 30)}</span></div>`;
}

function timelineHtml(plan, wd, opts = {}) {
  const items = plan.items.map((it) => {
    const time = `<div class="tl-time">${P.fmtTime(it.at)}</div>`;
    if (it.kind === "start") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">🚪 ${t("arrive")}</div></div></li>`;
    if (it.kind === "end") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">👋 ${t("leave")}</div></div></li>`;
    if (it.kind === "lunch") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">🍽️ ${t("lunch")} · ${P.fmtTime(it.at)}–${P.fmtTime(it.end)}</div></div></li>`;
    if (it.kind === "break") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">☕ ${t("break")} · ${it.end - it.at} ${t("min")}</div></div></li>`;
    const m = state.meta[it.id];
    const badges = [
      tierBadge(it.id),
      typeBadge(it.id),
      it.must ? `<span class="badge must">★ ${t("must")}</span>` : "",
      it.ll ? `<span class="badge ll">⚡ ${it.ll === "single" ? "LL Single" : "LL Multi"}</span>` : "",
      it.express ? `<span class="badge express">⚡ Express</span>` : "",
    ].join("");
    const doneBtn = opts.live
      ? `<button class="pill ghost" data-action="done" data-id="${it.id}">✓ ${t("done")}</button>` : "";
    return `<li class="tl">${time}<div class="tl-body">
      ${it.walk ? `<div class="tl-walk">🚶 ${t("walk", { n: it.walk })}</div>` : ""}
      <div class="tl-card ${it.must ? "must" : ""}">
        <div class="grow">
          <div class="title">${esc(rideName(it.id))}</div>
          <div class="meta">${esc(state.catalog[it.id]?.land || "")} · ${t("ride_dur", { n: m.duration })}</div>
          <div class="badges">${badges}</div>
          ${opts.spark !== false ? sparkline(it.id, wd, plan.hours.open, plan.hours.close, it.at) : ""}
        </div>
        <div class="col" style="display:grid;gap:6px;justify-items:end">${waitChip(it.wait)}${doneBtn}</div>
      </div></div></li>`;
  }).join("");
  return `<ol class="timeline">${items}</ol>`;
}

function viewDay() {
  if (!state.configured) return needSetup();
  const days = trip();
  if (!days.length) return needSetup();
  const today = P.orlandoNow().date;
  if (!state.dayDate || !days.some((d) => d.date === state.dayDate)) {
    state.dayDate = days.some((d) => d.date === today) ? today : days[0].date;
  }
  const day = days.find((d) => d.date === state.dayDate);
  const chips = days.map((d) => `
    <button class="chip ${d.date === day.date ? "active" : ""}" data-action="pick-day" data-date="${d.date}">
      <small>${esc(fmtDate(d.date, { weekday: "short" }))}</small><b>${+d.date.slice(8)}</b><small>${d.park ? parkOf(d.park).emoji : "😴"}</small>
    </button>`).join("");

  if (!day.park) {
    return `<div class="chips">${chips}</div><section class="card center"><p style="font-size:2rem;margin:0">😴</p><p>${t("rest_msg")}</p></section>`;
  }
  const p = parkOf(day.park);
  const plan = dayPlan(day.date, day.park);
  const sparse = plan.items.some((i) => i.kind === "ride" && !getModel().hasData(i.id));
  return `
    <div class="chips">${chips}</div>
    <section class="card">
      <div class="day-head">
        <span class="emoji">${p.emoji}</span>
        <div class="grow">
          <p class="muted small" style="margin:0">${esc(fmtDate(day.date, { weekday: "long", day: "numeric", month: "long" }))}</p>
          <h2>${p.name}</h2>
          <div class="row gap small">${crowdTag(day.crowd)}
            <span class="muted">${t("day_hours", { open: P.fmtTime(plan.hours.open), close: P.fmtTime(plan.hours.close) })}${plan.hours.source === "default" ? ` (${t("hours_default")})` : ""}</span></div>
        </div>
      </div>
      <p class="small" style="margin:10px 0 0">${t("total_wait", { n: plan.totalWait })}</p>
      ${plan.skippedMust.length ? `<p class="small" style="color:var(--red)">${esc(t("skipped_must", { list: plan.skippedMust.map(rideName).join(", ") }))}</p>` : ""}
      ${sparse ? `<p class="small muted">ℹ️ ${t("estimate_note")}</p>` : ""}
      ${state.settings.surprise ? `<button class="pill ghost" data-action="reshuffle" data-date="${day.date}">🎲 ${t("reshuffle")}</button>` : ""}
    </section>
    ${timelineHtml(plan, day.wd)}`;
}

// ------------------------------------------------------------------ direct

const doneKey = (date, park) => `done.${date}.${park}`;

function viewLive() {
  const now = P.orlandoNow();
  const days = state.configured ? trip() : [];
  const todayPlan = days.find((d) => d.date === now.date);
  const inTrip = !!todayPlan;
  const selected = state.settings.parks.length ? state.settings.parks : P.PARKS.map((p) => p.id);
  if (!state.livePark || !P.PARK_BY_ID[state.livePark]) state.livePark = todayPlan?.park || selected[0];
  const park = state.livePark;
  const waits = state.latest?.parks?.[park] || {};
  const done = new Set(store.get(doneKey(now.date, park), []));
  const model = getModel();
  const hours = model.parkHours(park, now.wd);
  const stale = state.latest?.updated && Date.now() - new Date(state.latest.updated) > 40 * 60000;

  const parkSelect = `<select id="live-park">${P.PARKS.map((p) => `<option value="${p.id}" ${p.id === park ? "selected" : ""}>${p.emoji} ${p.name}</option>`).join("")}</select>`;

  const head = `
    <section class="card">
      <div class="row gap between"><h2>📡 ${t("live_title")}</h2>
        <button class="pill ghost" data-action="refresh">↻ ${t("live_refresh")}</button></div>
      <label class="field"><span>${t("live_park")}</span>${parkSelect}</label>
      <p class="small muted" style="margin:0">${state.latest?.updated ? esc(t("data_updated", { ago: ago(state.latest.updated) })) : ""}</p>
      ${stale ? `<p class="small" style="color:var(--orange)">⚠️ ${esc(t("live_stale", { ago: ago(state.latest.updated) }))}</p>` : ""}
      ${!inTrip ? `<p class="small muted">${t("live_not_trip")}</p>` : ""}
    </section>`;

  const open = now.min >= hours.open - 60 && now.min < hours.close;
  const anyOpen = Object.values(waits).some((w) => w.open);
  let body = "";
  if (!open && !anyOpen) {
    body = `<section class="card center muted">🌙 ${t("live_closed_park")}</section>`;
  } else {
    const sugg = P.suggestNow({ park, wd: now.wd, settings: state.settings, model, meta: state.meta,
      catalog: state.catalog, waits, now: now.min, done }).slice(0, 3);
    body += `<section class="card"><h3>✨ ${t("now_title")}</h3>
      ${sugg.length ? sugg.map((s) => `
        <div class="now-card">
          ${waitChip(s.wait)}
          <div class="grow"><div style="font-weight:700">${esc(rideName(s.id))}</div>
            <div class="small muted">${t("now_usual", { n: s.usual })} · ${t("now_later", { n: s.later })}</div>
            <div class="badges">${tierBadge(s.id)}${typeBadge(s.id)}${s.must ? `<span class="badge must">★ ${t("must")}</span>` : ""}</div></div>
          <button class="pill ghost" data-action="done" data-id="${s.id}">✓</button>
        </div>`).join("") : `<p class="muted small">${t("now_none")}</p>`}
    </section>`;

    const plan = P.planDay({
      park, date: now.date, wd: now.wd, settings: state.settings, model, meta: state.meta, catalog: state.catalog,
      from: Math.max(now.min, hours.open), done, alreadyDone: done.size, seed: state.seeds[now.date] || 0,
      live: { waits, now: now.min }, priorities: prioById(),
    });
    body += `<h3 class="section-title">${t("rest_of_day")}</h3>`;
    if (plan.closed.length) body += `<p class="small muted">${esc(t("closed_planned", { list: plan.closed.map(rideName).join(", ") }))}</p>`;
    body += timelineHtml(plan, now.wd, { live: true, spark: false });
  }

  // toutes les attractions du parc, triées par attente
  const ids = Object.keys(waits).filter((id) => state.meta[id] || state.catalog[id]);
  ids.sort((a, b) => (waits[b].open - waits[a].open) || (waits[a].wait - waits[b].wait));
  const list = ids.map((id) => {
    const w = waits[id];
    const isDone = done.has(id);
    return `<div class="live-row ${w.open ? "" : "closed"}">
      ${w.open ? waitChip(w.wait) : `<span class="wait none">${t("closed")}</span>`}
      <span class="name">${esc(rideName(id))}${isDone ? " ✓" : ""}</span>${tierBadge(id)}
      ${isDone ? `<button class="link small" data-action="undo" data-id="${id}">${t("undo")}</button>` : ""}
    </div>`;
  }).join("");
  const doneList = [...done].filter((id) => !waits[id]);

  return head + body + `<h3 class="section-title">${t("all_rides")}</h3><div class="live-list">${list}</div>`
    + (doneList.length ? `<p class="small muted">✓ ${esc(doneList.map(rideName).join(", "))}</p>` : "");
}

function markDone(id, value) {
  const now = P.orlandoNow();
  const key = doneKey(now.date, state.livePark);
  const set = new Set(store.get(key, []));
  if (value) set.add(id); else set.delete(id);
  store.set(key, [...set]);
  render();
}

// ------------------------------------------------------------------ fichiers personnels (CSV)

const IMPORT_KINDS = ["notes", "priorities", "patterns"]; // clés de state / localStorage
const KIND_OF = { crowds: "notes", priorities: "priorities", patterns: "patterns" };

function importRows(kind, d) {
  if (kind === "notes") return d.rows ?? d.notes.length + (d.ignored || 0) + (d.invalid || 0);
  return d.rows;
}

function importsSummary() {
  const parts = IMPORT_KINDS.filter((k) => state[k]).map((k) => `${t("kind_" + k)} (${importRows(k, state[k])})`);
  return parts.length ? t("imports_active", { list: parts.join(", ") }) : t("notes_none");
}

function importsList() {
  const rows = IMPORT_KINDS.filter((k) => state[k]).map((k) => {
    const d = state[k];
    const when = d.at ? new Date(d.at).toLocaleString(state.lang === "fr" ? "fr-FR" : "en-US",
      { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    let extra = "";
    if (k === "priorities") {
      extra = `<div class="small muted">${esc(t("prio_matched", { n: d.matched, total: d.rows }))}</div>`;
      if (d.unmatched?.length) {
        extra += `<details class="small"><summary>${esc(t("prio_unmatched", { n: d.unmatched.length }))}</summary>
          <ul class="unmatched">${d.unmatched.map((u) => `<li>${esc(u.ride)} <span class="muted">(${esc(u.park)})</span></li>`).join("")}</ul></details>`;
      }
    }
    if (k === "notes") extra = `<div class="small muted">${esc(t("notes_loaded", { n: d.notes.length, ignored: d.ignored, invalid: d.invalid }))}</div>`;
    return `<div class="import-row">
      <div class="grow"><b>${t("kind_" + k)}</b>
        <div class="small muted">${esc(d.file || "")}${d.file ? " · " : ""}${t("import_rows", { n: importRows(k, d) })} · ${esc(when)}</div>
        ${extra}</div>
      <button type="button" class="pill ghost danger" data-action="imp-del" data-kind="${k}" aria-label="${t("remove")}">✕</button>
    </div>`;
  }).join("");
  return rows || `<p class="muted small">${t("notes_none")}</p>`;
}

function importMsgsHtml() {
  return state.importMsgs.map((m) => `<p class="small ${m.ok ? "" : "err"}">${m.ok ? "✓" : "⚠️"} ${esc(m.text)}</p>`).join("");
}

function importsCard() {
  return `<section class="card">
    <div class="row gap between"><h3>📥 ${t("imports_title")}</h3>
      <label class="pill ghost">${t("notes_import")}<input type="file" class="csv-input" accept=".csv,text/csv" multiple hidden></label></div>
    <p class="muted small">${t("notes_help")}</p>
    ${importMsgsHtml()}
    <div class="imports-list">${importsList()}</div>
  </section>`;
}

function notesStatus() {
  $("#notes-status").innerHTML = importMsgsHtml();
  $("#imports-list").innerHTML = importsList();
}

async function importFiles(files) {
  const msgs = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const kind = P.detectCsvKind(text);
      const base = { file: file.name, at: Date.now() };
      if (kind === "crowds") {
        const parsed = P.parseNotes(text);
        if (!parsed.notes.length) throw new Error("empty");
        state.notes = { ...parsed, rows: parsed.notes.length + parsed.ignored + parsed.invalid, ...base };
        msgs.push({ ok: true, text: `${file.name} → ${t("kind_notes")} : ${t("notes_loaded", { n: parsed.notes.length, ignored: parsed.ignored, invalid: parsed.invalid })}` });
      } else if (kind === "priorities") {
        const parsed = P.parsePriorities(text, state.catalog, state.meta);
        if (!parsed.rows) throw new Error("empty");
        state.priorities = { ...parsed, ...base };
        let msg = `${file.name} → ${t("kind_priorities")} : ${t("prio_matched", { n: parsed.matched, total: parsed.rows })}`;
        if (parsed.unmatched.length) msg += ` ${t("prio_unmatched_list", { list: parsed.unmatched.map((u) => u.ride).join(", ") })}`;
        msgs.push({ ok: true, text: msg });
      } else if (kind === "patterns") {
        const parsed = P.parsePatterns(text);
        if (!parsed.rows) throw new Error("empty");
        state.patterns = { ...parsed, ...base };
        msgs.push({ ok: true, text: `${file.name} → ${t("kind_patterns")} : ${t("patterns_loaded", { n: parsed.rows, invalid: parsed.invalid })}` });
      } else {
        msgs.push({ ok: false, text: t("import_unknown", { file: file.name }) });
        continue;
      }
      store.set(KIND_OF[kind], state[KIND_OF[kind]]);
    } catch {
      msgs.push({ ok: false, text: `${file.name} : ${t("notes_error")}` });
    }
  }
  state.importMsgs = msgs;
  notesStatus();
  render();
}

function deleteImport(kind) {
  if (!IMPORT_KINDS.includes(kind)) return;
  state[kind] = null;
  store.del(kind);
  state.importMsgs = [{ ok: true, text: t("import_deleted", { kind: t("kind_" + kind) }) }];
  notesStatus();
  render();
}

// ------------------------------------------------------------------ évènements

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action], [data-tab]");
  if (!el) return;
  const a = el.dataset.action || "tab";
  const s = state.settings;
  switch (a) {
    case "tab": go(el.dataset.tab); break;
    case "step": state.step = +el.dataset.step; store.set("step", state.step); render(); break;
    case "prev": state.step = Math.max(0, state.step - 1); store.set("step", state.step); render(); break;
    case "next": state.step = Math.min(STEPS.length - 1, state.step + 1); store.set("step", state.step); render(); break;
    case "finish": state.configured = true; store.set("configured", true); go("calendar"); break;
    case "forced-add": {
      const dates = P.dateRange(s.start, s.end);
      const used = new Set(s.forced.map((f) => f.date));
      s.forced.push({ date: dates.find((d) => !used.has(d)) || dates[0], park: s.parks[0] || "rest" });
      saveSettings(); render(); break;
    }
    case "forced-del": s.forced.splice(+el.dataset.i, 1); saveSettings(); render(); break;
    case "open-day": state.dayDate = el.dataset.date; go("day"); break;
    case "pick-day": state.dayDate = el.dataset.date; render(); break;
    case "reshuffle":
      state.seeds[el.dataset.date] = (state.seeds[el.dataset.date] || 0) + 1;
      store.set("seeds", state.seeds); render(); break;
    case "refresh": refreshLatest(); break;
    case "done": markDone(el.dataset.id, true); break;
    case "undo": markDone(el.dataset.id, false); break;
    case "imp-del": deleteImport(el.dataset.kind); break;
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  const s = state.settings;
  if (el.classList.contains("csv-input")) { if (el.files.length) importFiles([...el.files]); el.value = ""; return; }
  if (el.id === "live-park") { state.livePark = el.value; render(); return; }
  if (el.dataset.set) {
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.dataset.set === "kids.height" || el.dataset.set === "lunch.at") v = +v;
    setPath(s, el.dataset.set, v);
    if (el.dataset.set === "start" && s.end < s.start) s.end = s.start;
    // les contraintes hors des dates du séjour sont retirées
    if (el.dataset.set === "start" || el.dataset.set === "end") s.forced = s.forced.filter((f) => f.date >= s.start && f.date <= s.end);
    saveSettings(); render(); return;
  }
  if (el.dataset.park) {
    s.parks = el.checked ? [...new Set([...s.parks, el.dataset.park])] : s.parks.filter((p) => p !== el.dataset.park);
    s.parks = P.PARKS.map((p) => p.id).filter((p) => s.parks.includes(p));
    s.mustDo = s.mustDo.filter((id) => s.parks.includes(state.meta[id]?.park));
    s.forced = s.forced.filter((f) => f.park === "rest" || s.parks.includes(f.park));
    saveSettings(); render(); return;
  }
  if (el.dataset.forced != null) {
    s.forced[+el.dataset.forced][el.dataset.key] = el.value;
    saveSettings(); return;
  }
  if (el.dataset.must) {
    s.mustDo = el.checked ? [...new Set([...s.mustDo, el.dataset.must])] : s.mustDo.filter((id) => id !== el.dataset.must);
    saveSettings();
    $("#must-count").textContent = t("must_count", { n: s.mustDo.length });
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "must-search") {
    state.search = e.target.value;
    $("#must-list").innerHTML = mustList();
  }
});

$("#btn-lang").addEventListener("click", () => {
  state.lang = state.lang === "fr" ? "en" : "fr";
  store.set("lang", state.lang);
  render();
  notesStatus();
});

$("#btn-notes").addEventListener("click", () => { notesStatus(); $("#notes-dialog").showModal(); });

window.addEventListener("popstate", () => {
  const tab = location.hash.slice(1);
  if (["setup", "calendar", "day", "live"].includes(tab)) { state.tab = tab; render(); }
});

// Installation sur téléphone
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#btn-install").hidden = false;
});
$("#btn-install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#btn-install").hidden = true;
});

function updateOnline() {
  const b = $("#banner");
  if (!navigator.onLine) { b.hidden = false; b.textContent = t("offline"); }
  else if (b.textContent === t("offline")) b.hidden = true;
}
window.addEventListener("online", () => { updateOnline(); refreshLatest(); });
window.addEventListener("offline", updateOnline);

// ------------------------------------------------------------------ démarrage

async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  try {
    const [i18n, meta] = await Promise.all([fetchJson("i18n.json"), fetchJson("rides_meta.json")]);
    state.i18n = i18n;
    state.meta = meta.rides;
  } catch {
    $("#main").innerHTML = `<div class="card center">Erreur de chargement / Loading error.</div>`;
    return;
  }
  try {
    await loadData();
  } catch {
    // sans stats : le planificateur fonctionne quand même avec les attentes typiques
    state.stats = { rides: {}, parks: {} };
    $("#banner").hidden = false;
    $("#banner").textContent = t("data_error");
  }
  const hashTab = location.hash.slice(1);
  state.tab = ["setup", "calendar", "day", "live"].includes(hashTab) ? hashTab : state.configured ? "calendar" : "setup";
  render();
  updateOnline();
  setInterval(updateClock, 30000);
  setInterval(() => { if (state.tab === "live" && document.visibilityState === "visible") refreshLatest(); }, 5 * 60000);
}

init();
