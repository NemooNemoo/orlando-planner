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
  visits: null, // { parc: nombre de visites } — calculé au démarrage si absent
  pace: "normal",
  lunch: { enabled: true, at: 720 },
  hotelPerks: false, // accès hôtel : early entry et soirées prolongées
  hoursOverride: {}, // corrections manuelles { "AAAA-MM-JJ|parc": { open, close } } en minutes
  forced: [],
  mustDo: [],
  surprise: false,
};

// Anciennes valeurs ignorées sans erreur (ex. mode enfants supprimé)
function loadSettings() {
  const saved = store.get("settings", {});
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(saved && typeof saved === "object" ? saved : {}) };
  delete s.kids;
  return s;
}

const storedList = (key) => {
  const v = store.get(key, []);
  return Array.isArray(v) ? v.filter((c) => P.CATEGORIES.includes(c)) : [];
};

const state = {
  lang: store.get("lang", (navigator.language || "fr").startsWith("fr") ? "fr" : "en"),
  tab: "setup",
  step: store.get("step", 0),
  settings: loadSettings(),
  theme: ["auto", "light", "dark"].includes(store.get("theme", "auto")) ? store.get("theme", "auto") : "auto",
  mustCats: storedList("mustCats"), // filtres par catégorie ([] = toutes)
  liveCats: storedList("liveCats"),
  visitMsg: "",
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
  schedule: null, // data/schedule.json (ThemeParks.wiki)
  shows: null,    // data/shows.json
  editHours: null, // jour en cours de correction dans les réglages
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

const TYPE_ICON = { thrill: "🎢", family: "🎠", show: "🎭", meet: "🤝" };
function rideType(id) {
  const type = P.rideType(id, state.meta, state.catalog);
  if (type) return type;
  const name = state.catalog[id]?.name || "";
  if (!/ single rider$/i.test(name)) return null;
  const main = P.normName(name.replace(/ single rider$/i, ""));
  const mainId = Object.keys(state.meta).find((k) => P.normName(rideName(k)) === main);
  return mainId ? state.meta[mainId].type : null;
}

function typeBadge(id) {
  const type = rideType(id);
  return type ? `<span class="badge type">${TYPE_ICON[type]} ${t("type_" + type)}</span>` : "";
}

/** Puces de filtre par catégorie (sélection multiple, [] = toutes) */
function catChips(scope) {
  const sel = state[scope + "Cats"];
  const chip = (cat, label, on) =>
    `<button type="button" class="fchip ${on ? "on" : ""}" aria-pressed="${on}" data-action="cat" data-scope="${scope}" data-cat="${cat}">${label}</button>`;
  return `<div class="fchips" role="group" aria-label="${t("filter_label")}">
    ${chip("all", t("cat_all"), !sel.length)}
    ${P.CATEGORIES.map((c) => chip(c, `${TYPE_ICON[c]} ${t("cat_" + c)}`, sel.includes(c))).join("")}
  </div>`;
}

function catMatch(scope, id) {
  const sel = state[scope + "Cats"];
  const type = rideType(id);
  if (sel.length) return sel.includes(type);
  // Direct, « Toutes » : sans spectacles ni rencontres
  return scope === "live" ? type !== "show" && type !== "meet" : true;
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
      // horaires et spectacles (ThemeParks.wiki) : facultatifs, le site marche sans
      state.schedule = await fetchJson(base + "schedule.json").catch(() => null);
      refreshLatest();
      return;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error("no data base");
}

async function refreshLatest() {
  if (!state.base) return;
  try {
    const [latest, shows] = await Promise.all([
      fetchJson(state.base + "latest.json", { cache: "no-cache" }),
      fetchJson(state.base + "shows.json", { cache: "no-cache" }).catch(() => state.shows),
    ]);
    state.latest = latest;
    state.shows = shows;
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

function hoursFor(date, park) {
  const s = state.settings;
  return P.dayHours(park, date, { schedule: state.schedule, overrides: s.hoursOverride, model: getModel(), hotelPerks: s.hotelPerks });
}

function dayPlan(date, park) {
  return P.planDay({
    park, date, wd: P.weekdayOf(date), settings: state.settings, model: getModel(),
    meta: state.meta, catalog: state.catalog, seed: state.seeds[date] || 0, priorities: prioById(),
    hours: hoursFor(date, park),
  });
}

/** 570 -> « 9h30 » (FR) / « 9:30 AM » (EN) ; au-delà de minuit : 1500 -> « 1h » */
function fmtHour(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  if (state.lang === "fr") return `${h}h${mm ? String(mm).padStart(2, "0") : ""}`;
  return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Ligne d'horaires : « 9h–22h · Early entry 8h30 · Soirée prolongée → 0h · 🎟️ … · horaire estimé » */
function hoursLine(h, { extras = true } = {}) {
  const parts = [`🕘 ${fmtHour(h.open)}–${fmtHour(h.close)}`];
  if (extras) {
    for (const e of h.early) parts.push(t("hours_early", { time: fmtHour(e.startMin) }));
    for (const e of h.evening) parts.push(t("hours_evening", { time: fmtHour(e.endMin) }));
    for (const e of h.events) parts.push(`🎟️ ${esc(e.name || t("hours_event"))} ${fmtHour(e.startMin)}–${fmtHour(e.endMin)}`);
  }
  const tag = { estimated: t("hours_estimated"), manual: t("hours_manual") }[h.source];
  return `<span class="hours-line">${parts.join(" · ")}${tag ? ` <span class="badge hours-${h.source}">${tag}</span>` : ""}</span>`;
}

// ------------------------------------------------------------------ rendu général

function render() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  $("#btn-lang").textContent = t("lang_switch");
  applyTheme();
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

const STEPS = ["dates", "parks", "passes", "pace", "forced", "must", "recap"];

function viewSetup() {
  const s = state.settings;
  const step = Math.min(state.step, STEPS.length - 1);
  const valid = STEPS.slice(0, step + 1).every(stepValid);
  const last = step === STEPS.length - 1;
  const dots = STEPS.map((_, i) => `<span class="${i <= step ? "on" : ""}" data-action="step" data-step="${i}"></span>`).join("");
  const STEP_VIEWS = { dates: stepDates, parks: stepParks, passes: stepPasses, pace: stepPace, forced: stepForced, must: stepMust, recap: stepRecap };
  return `
  <section class="card">
    <div class="steps">${dots}</div>
    <p class="step-label">${t("step", { n: step + 1, total: STEPS.length })}</p>
    ${STEP_VIEWS[STEPS[step]](s)}
    <div class="wizard-nav">
      <button class="pill ghost" data-action="prev" ${step === 0 ? "disabled" : ""}>← ${t("prev")}</button>
      ${last
        ? `<button class="pill big" data-action="finish" ${valid ? "" : "disabled"}>✓ ${t("create_trip")}</button>`
        : `<button class="pill" data-action="next" ${stepValid(STEPS[step]) ? "" : "disabled"}>${t("next")} →</button>`}
    </div>
  </section>
  ${hoursCard()}
  ${importsCard()}`;
}

/** Horaires de chaque journée de parc, avec correction manuelle */
function hoursCard() {
  if (!state.configured) return "";
  const days = trip().filter((d) => d.park);
  if (!days.length) return "";
  const rows = days.map((d) => {
    const key = `${d.date}|${d.park}`;
    const h = hoursFor(d.date, d.park);
    const p = parkOf(d.park);
    const editing = state.editHours === key;
    const toVal = (m) => P.fmtTime(m % 1440);
    return `<div class="hours-row">
      <div class="grow"><b>${esc(fmtDate(d.date))}</b> · ${p.emoji} ${p.name}<br>${hoursLine(h, { extras: false })}</div>
      ${editing ? "" : `<button type="button" class="link" data-action="hours-edit" data-key="${key}">${t("edit")}</button>`}
      ${editing ? `<div class="hours-edit">
        <label class="field"><span>${t("hours_open")}</span><input type="time" id="hours-open" value="${toVal(h.open)}"></label>
        <label class="field"><span>${t("hours_close")}</span><input type="time" id="hours-close" value="${toVal(h.close)}"></label>
        <div class="row gap">
          <button type="button" class="pill" data-action="hours-save" data-key="${key}">${t("save")}</button>
          <button type="button" class="pill ghost" data-action="hours-cancel">${t("cancel")}</button>
        </div></div>` : ""}
      ${h.source === "manual" && !editing ? `<button type="button" class="link" data-action="hours-reset" data-key="${key}">${t("hours_reset")}</button>` : ""}
    </div>`;
  }).join("");
  return `<section class="card">
    <h3>🕘 ${t("hours_title")}</h3>
    <p class="muted small">${t("hours_help")}</p>
    <div class="hours-list">${rows}</div>
  </section>`;
}

function stepValid(name) {
  const s = state.settings;
  if (name === "dates") {
    return !!(s.start && s.end && s.end >= s.start && P.dateRange(s.start, s.end, 46).length <= 45);
  }
  if (name === "parks") return P.totalVisits(s.visits) > 0;
  return true;
}

const visitMsgHtml = () => (state.visitMsg ? `<p class="small notice" role="status">ℹ️ ${esc(state.visitMsg)}</p>` : "");

function stepDates(s) {
  const n = stepValid("dates") ? P.dateRange(s.start, s.end).length : 0;
  return `
    <h2>${t("s_dates")}</h2><p class="muted small">${t("s_dates_help")}</p>
    <div class="two">
      <label class="field"><span>${t("date_start")}</span><input type="date" data-set="start" value="${esc(s.start)}"></label>
      <label class="field"><span>${t("date_end")}</span><input type="date" data-set="end" value="${esc(s.end)}" min="${esc(s.start)}"></label>
    </div>
    <p class="small ${n ? "muted" : "err"}">${n ? t("days_count", { n }) : t("dates_invalid")}</p>
    ${visitMsgHtml()}`;
}

function stepParks(s) {
  const total = P.totalVisits(s.visits);
  const rest = P.restDays(s);
  const forcedRest = P.forcedRestDays(s);
  const days = stepValid("dates") ? P.tripDays(s) : 0;
  const full = total + rest >= days; // limite commune : visites + repos ≤ jours du séjour
  const forcedCount = {};
  for (const f of s.forced) if (f.park !== "rest") forcedCount[f.park] = (forcedCount[f.park] || 0) + 1;
  const counter = ({ cls = "", label, sub, n, min, action, park = "", less, more }) => `
      <div class="counter-row ${n ? "on" : ""} ${cls}">
        <span class="grow">${label}<small class="muted">${sub}</small></span>
        <button type="button" class="round" data-action="${action}" data-park="${park}" data-d="-1" ${n <= min ? "disabled" : ""}
          aria-label="${esc(less)}">−</button>
        <output class="count" aria-live="polite">${n}</output>
        <button type="button" class="round" data-action="${action}" data-park="${park}" data-d="1" ${full ? "disabled" : ""}
          aria-label="${esc(more)}">+</button>
      </div>`;
  const group = (g) => `
    <div class="group-title"><span class="dot ${g}"></span>${t(g)}</div>
    ${P.PARKS.filter((p) => p.group === g).map((p) => {
      const n = s.visits?.[p.id] || 0;
      return counter({ label: `${p.emoji} <b>${p.name}</b>`, sub: n ? t("visits_n", { n }) : t("visits_none"),
        n, min: forcedCount[p.id] || 0, action: "visit", park: p.id,
        less: t("visit_less", { park: p.name }), more: t("visit_more", { park: p.name }) });
    }).join("")}`;
  const restRow = `
    <div class="group-title">🏖️ ${t("rest_days")}</div>
    ${counter({ cls: "rest", label: `<b>${t("rest_days")}</b>`,
      sub: forcedRest ? t("rest_forced_n", { n: forcedRest }) : t("rest_help"),
      n: rest, min: forcedRest, action: "rest", less: t("rest_less"), more: t("rest_more") })}`;
  return `<h2>${t("s_parks")}</h2><p class="muted small">${t("s_parks_help")}</p>
    <p class="small total-line"><b>${t("days_total", { v: total, r: rest, sum: total + rest, days })}</b></p>
    ${full ? `<p class="small notice" role="status">${t("days_limit", { days })}</p>` : ""}
    ${visitMsgHtml()}
    ${group("disney")}${group("universal")}${restRow}
    ${total ? "" : `<p class="small err">${t("parks_none")}</p>`}`;
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
        <span><b>${t("express")}</b><small>${t("express_help")}</small></span></label>` : ""}
    <div class="group-title">🏨 ${t("hotel_title")}</div>
    <label class="choice"><input type="checkbox" data-set="hotelPerks" ${s.hotelPerks ? "checked" : ""}>
      <span><b>${t("hotel_perks")}</b><small>${t("hotel_perks_help")}</small></span></label>`;
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
      <select data-forced="${i}" data-key="date" aria-label="${t("date")}">${dates.map((d) => `<option value="${d}" ${d === f.date ? "selected" : ""}>${esc(fmtDate(d))}</option>`).join("")}</select>
      <select data-forced="${i}" data-key="park" aria-label="${t("live_park")}">
        ${s.parks.map((p) => `<option value="${p}" ${p === f.park ? "selected" : ""}>${parkOf(p).emoji} ${parkOf(p).name}</option>`).join("")}
        <option value="rest" ${f.park === "rest" ? "selected" : ""}>🏖️ ${t("rest_day")}</option>
      </select>
      <button class="pill ghost danger" data-action="forced-del" data-i="${i}" aria-label="${t("remove")}">✕</button>
    </div>`).join("");
  return `<h2>${t("s_forced")}</h2><p class="muted small">${t("s_forced_help")}</p>
    ${rows || `<p class="muted small">${t("forced_none")}</p>`}
    ${visitMsgHtml()}
    <button class="pill ghost" data-action="forced-add" ${dates.length ? "" : "disabled"}>+ ${t("forced_add")}</button>`;
}

function stepMust(s) {
  return `<h2>${t("s_must")}</h2><p class="muted small">${t("s_must_help")}</p>
    <label class="choice"><input type="checkbox" data-set="surprise" ${s.surprise ? "checked" : ""}>
      <span><b>🎲 ${t("surprise")}</b><small>${t("surprise_help")}</small></span></label>
    ${s.surprise ? "" : `
      ${catChips("must")}
      <div class="row gap" style="margin-top:8px">
        <input type="search" id="must-search" class="grow" placeholder="${t("search")}" aria-label="${t("search")}" value="${esc(state.search)}">
        <span class="badge must" id="must-count">${t("must_count", { n: s.mustDo.length })}</span>
      </div>
      <div class="must-list" id="must-list">${mustList()}</div>`}`;
}

function mustList() {
  const s = state.settings;
  const q = state.search.trim().toLowerCase();
  const html = P.PARKS.filter((p) => s.parks.includes(p.id)).map((p) => {
    const ids = P.eligibleRides(p.id, s, state.meta)
      .filter((id) => (!q || rideName(id).toLowerCase().includes(q)) && catMatch("must", id))
      .sort((a, b) => state.meta[b].base_wait - state.meta[a].base_wait);
    if (!ids.length) return "";
    return `<div class="group-title"><span class="dot ${p.group}"></span>${p.emoji} ${p.name}</div>` + ids.map((id) => {
      const m = state.meta[id];
      return `<label class="must-item">
        <input type="checkbox" data-must="${id}" ${s.mustDo.includes(id) ? "checked" : ""}>
        <span class="grow"><span class="name">${esc(rideName(id))}</span>
          <span class="badges">${tierBadge(id)}${typeBadge(id)}<span class="badge">${m.height ? t("height_min", { cm: m.height }) : t("no_height")}</span></span></span>
      </label>`;
    }).join("");
  }).join("");
  return html || `<p class="muted small">${t("filter_empty")}</p>`;
}

function stepRecap(s) {
  const n = STEPS.indexOf.bind(STEPS);
  const days = P.dateRange(s.start, s.end).length;
  const total = P.totalVisits(s.visits);
  const rest = P.restDays(s);
  const forcedRest = P.forcedRestDays(s);
  const freeDays = Math.max(0, days - rest - total);
  const row = (label, value, step) => `
    <div class="recap-row">
      <div class="grow"><div class="small muted">${label}</div><div>${value}</div></div>
      <button type="button" class="link" data-action="step" data-step="${n(step)}" aria-label="${esc(t("edit") + " : " + label)}">${t("edit")}</button>
    </div>`;
  const yes = (b) => (b ? t("yes") : t("no"));
  const passes = [];
  if (s.parks.some((p) => parkOf(p).group === "disney")) {
    passes.push(`${t("ll_multi")} : ${yes(s.ll.multi)}`, `${t("ll_single")} : ${yes(s.ll.single)}`);
  }
  if (s.parks.some((p) => parkOf(p).group === "universal")) passes.push(`${t("express")} : ${yes(s.express)}`);
  const forced = s.forced.length
    ? s.forced.map((f) => `${esc(fmtDate(f.date))} → ${f.park === "rest" ? "🏖️ " + t("rest_day") : parkOf(f.park).emoji + " " + parkOf(f.park).name}`).join("<br>")
    : t("forced_none");
  const must = s.surprise
    ? `🎲 ${t("surprise")}`
    : s.mustDo.length
      ? `${t("must_count", { n: s.mustDo.length })}<ul class="recap-list">${s.mustDo.map((id) => `<li>${esc(rideName(id))}</li>`).join("")}</ul>`
      : t("must_none");
  return `<h2>${t("s_recap")}</h2><p class="muted small">${t("s_recap_help")}</p>
    ${row(t("s_dates"), `${esc(fmtDate(s.start, { day: "numeric", month: "long" }))} → ${esc(fmtDate(s.end, { day: "numeric", month: "long", year: "numeric" }))} · ${t("days_count", { n: days })}`, "dates")}
    ${row(t("s_parks"), P.PARKS.filter((p) => s.visits?.[p.id]).map((p) => `${p.emoji} ${p.name} × ${s.visits[p.id]}`).join("<br>") + `<br><b>${t("days_total", { v: total, r: rest, sum: total + rest, days })}</b>`, "parks")}
    ${row(t("recap_rest"), t("recap_rest_v", { n: rest, forced: forcedRest }) + (freeDays ? `<br>${t("recap_free", { n: freeDays })}` : ""), "parks")}
    ${row(t("s_passes"), passes.join("<br>") || "—", "passes")}
    ${row(t("s_pace"), t("pace_" + s.pace), "pace")}
    ${row(t("lunch_on"), s.lunch.enabled ? `${t("yes")} · ${P.fmtTime(+s.lunch.at)}` : t("no"), "pace")}
    ${row(t("s_forced"), forced, "forced")}
    ${row(t("s_must"), must, "must")}
    <div class="recap-row">
      <div class="grow"><div class="small muted">${t("imports_title")}</div><div>${esc(importsSummary())}</div></div>
      <button type="button" class="link" data-action="open-notes">${t("edit")}</button>
    </div>`;
}

// ------------------------------------------------------------------ visites

/** Applique les limites de visites ; signale si on a dû en retirer */
function applyVisitLimits() {
  const s = state.settings;
  const { visits, restDays, reduced, reducedRest } = P.normalizeVisits(s);
  s.visits = visits;
  s.restDays = restDays;
  syncParks();
  if (reduced || reducedRest) {
    const parts = [];
    if (reducedRest) parts.push(t("n_rest", { n: reducedRest }));
    if (reduced) parts.push(t("n_visits", { n: reduced }));
    state.visitMsg = t("days_reduced", { list: parts.join(t("then")), days: P.tripDays(s) });
  }
}

/** La liste des parcs visités découle du nombre de visites */
function syncParks() {
  const s = state.settings;
  s.parks = P.PARKS.map((p) => p.id).filter((p) => (s.visits?.[p] || 0) > 0);
  s.mustDo = s.mustDo.filter((id) => s.parks.includes(state.meta[id]?.park));
  s.forced = s.forced.filter((f) => f.park === "rest" || s.parks.includes(f.park));
}

function ensureVisits() {
  const s = state.settings;
  if (!s.visits || typeof s.visits !== "object") {
    s.visits = P.defaultVisits(s, (s.parks || []).filter((p) => P.PARK_BY_ID[p]), state.meta);
  }
  // anciens réglages sans compteur de repos : les jours sans visite deviennent des jours de repos
  if (typeof s.restDays !== "number") {
    s.restDays = Math.max(P.forcedRestDays(s), P.tripDays(s) - P.totalVisits(s.visits));
  }
  applyVisitLimits();
  state.visitMsg = "";
  saveSettings();
}

// ------------------------------------------------------------------ calendrier

function needSetup() {
  return `<div class="card center"><p>${t("setup_first")}</p><button class="pill big" data-action="tab" data-tab="setup">${t("go_setup")}</button></div>`;
}

const dayEmoji = (d) => (d.park ? parkOf(d.park).emoji : d.rest ? "🏖️" : "🗓️");

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
      return `<button class="cal-day ${p ? p.group : d.rest ? "rest" : "free"}" data-action="open-day" data-date="${d.date}">
        <span class="cal-date"><small>${esc(fmtDate(d.date, { weekday: "short" }))}</small><b>${+d.date.slice(8)}</b><small>${esc(fmtDate(d.date, { month: "short" }))}</small></span>
        <span class="cal-emoji">${dayEmoji(d)}</span>
        <span class="grow">
          <span class="cal-park">${p ? p.name : d.rest ? t("rest_day") : t("free_day")}</span>
          ${d.forced ? `<span class="badge">📌 ${t("forced")}</span>` : ""}<br>
          ${p ? `${crowdTag(d.crowd)}<br>${hoursLine(hoursFor(d.date, d.park))}` : d.restAuto ? `<span class="small muted">${t("rest_auto")}</span>` : !d.rest ? `<span class="small muted">${t("free_help")}</span>` : ""}
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
      fill="var(--bar-${P.waitLevel(p.wait)})" opacity="${on ? 1 : 0.4}"><title>${P.fmtTime(p.min)} · ${p.wait} min</title></rect>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${pts.length * bw} ${h}" preserveAspectRatio="none" role="img" aria-label="${t("curve")}">${bars}</svg>
    <div class="spark-axis"><span>${P.fmtTime(pts[0].min)}</span><span>${P.fmtTime(pts[pts.length - 1].min + 30)}</span></div>`;
}

function timelineHtml(plan, wd) {
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
    return `<li class="tl">${time}<div class="tl-body">
      ${it.walk ? `<div class="tl-walk">🚶 ${t("walk", { n: it.walk })}</div>` : ""}
      <div class="tl-card ${it.must ? "must" : ""}">
        <div class="grow">
          <div class="title">${esc(rideName(it.id))}</div>
          <div class="meta">${esc(state.catalog[it.id]?.land || "")} · ${t("ride_dur", { n: m.duration })}</div>
          <div class="badges">${badges}</div>
          ${sparkline(it.id, wd, plan.hours.open, plan.hours.close, it.at)}
        </div>
        ${waitChip(it.wait)}
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
      <small>${esc(fmtDate(d.date, { weekday: "short" }))}</small><b>${+d.date.slice(8)}</b><small>${dayEmoji(d)}</small>
    </button>`).join("");

  if (!day.park) {
    return `<div class="chips">${chips}</div><section class="card center"><p style="font-size:2rem;margin:0">${dayEmoji(day)}</p>
      <h2>${day.rest ? t("rest_day") : t("free_day")}</h2>
      <p>${day.rest ? t("rest_msg") : t("free_help")}</p>${day.restAuto ? `<p class="small muted">${t("rest_auto")}</p>` : ""}</section>`;
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
            </div>
          <p class="small" style="margin:4px 0 0">${hoursLine(hoursFor(day.date, day.park))}</p>
        </div>
      </div>
      <p class="small" style="margin:10px 0 0">${t("total_wait", { n: plan.totalWait })}</p>
      ${plan.skippedMust.length ? `<p class="small err">${esc(t("skipped_must", { list: plan.skippedMust.map(rideName).join(", ") }))}</p>` : ""}
      ${sparse ? `<p class="small muted">ℹ️ ${t("estimate_note")}</p>` : ""}
      ${state.settings.surprise ? `<button class="pill ghost" data-action="reshuffle" data-date="${day.date}">🎲 ${t("reshuffle")}</button>` : ""}
    </section>
    ${timelineHtml(plan, day.wd)}`;
}

// ------------------------------------------------------------------ direct

const doneKey = (date, park) => `done.${date}.${park}`;

/** Spectacles du parc qui commencent dans les 60 min, ou commencés il y a moins de 10 min (shows.json) */
function showsSoon(park) {
  const nowMs = Date.now();
  return (state.shows?.parks?.[park] || [])
    .map((sh) => ({ ...sh, delta: Math.round((new Date(sh.start).getTime() - nowMs) / 60000) }))
    .filter((sh) => isFinite(sh.delta) && sh.delta >= -10 && sh.delta <= 60)
    .sort((a, b) => a.delta - b.delta);
}

function showsSoonHtml(park) {
  const shows = showsSoon(park);
  const startMin = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(iso); return m ? +m[1] * 60 + +m[2] : 0; };
  return `<section class="card" id="shows-soon" ${shows.length ? "" : "hidden"}>
    <h3>🎭 ${t("shows_soon")}</h3>
    <div class="shows-list">${shows.map((sh) => `
      <div class="show-row">
        <span class="show-time">${fmtHour(startMin(sh.start))}</span>
        <span class="grow name">${esc(sh.name)}</span>
        <span class="badge ${sh.delta <= 0 ? "show-now" : ""}">${sh.delta <= 0 ? t("show_started", { n: -sh.delta }) : t("show_in", { n: sh.delta })}</span>
      </div>`).join("")}</div></section>`;
}

function viewLive() {
  const now = P.orlandoNow();
  const days = state.configured ? trip() : [];
  const todayPlan = days.find((d) => d.date === now.date);
  const selected = state.settings.parks.length ? state.settings.parks : P.PARKS.map((p) => p.id);
  if (!state.livePark || !P.PARK_BY_ID[state.livePark]) state.livePark = todayPlan?.park || selected[0];
  const park = state.livePark;
  const waits = state.latest?.parks?.[park] || {};
  const done = new Set(store.get(doneKey(now.date, park), []));
  const model = getModel();
  const stale = state.latest?.updated && Date.now() - new Date(state.latest.updated) > 40 * 60000;

  const parkSelect = `<select id="live-park" aria-label="${t("live_park")}">${P.PARKS.map((p) => `<option value="${p.id}" ${p.id === park ? "selected" : ""}>${p.emoji} ${p.name}</option>`).join("")}</select>`;

  // attractions décrites dans rides_meta.json, plus leurs files Single Rider (même type que l'attraction)
  const liveRide = (id) => state.meta[id] || / single rider$/i.test(state.catalog[id]?.name || "");
  const ids = Object.keys(waits).filter((id) => liveRide(id) && catMatch("live", id));
  const isOpen = (id) => waits[id].open && typeof waits[id].wait === "number";
  const open = ids.filter(isOpen).sort((a, b) => waits[a].wait - waits[b].wait || rideName(a).localeCompare(rideName(b)));
  const closed = ids.filter((id) => !isOpen(id)).sort((a, b) => rideName(a).localeCompare(rideName(b)));

  const row = (id) => {
    const w = waits[id];
    const isDone = done.has(id);
    const usual = state.meta[id] ? model.expected(id, now.wd, now.min) : null;
    const good = isOpen(id) && usual != null && usual - w.wait >= 10 && w.wait <= usual * 0.7;
    return `<div class="live-row ${isOpen(id) ? "" : "closed"} ${isDone ? "done" : ""}">
      ${isOpen(id) ? waitChip(w.wait) : `<span class="wait none">${t("closed")}</span>`}
      <div class="grow">
        <div class="name">${esc(rideName(id))}${isDone ? ` <span class="sr-done">✓ ${t("done")}</span>` : ""}</div>
        <div class="badges">${tierBadge(id)}${typeBadge(id)}${good ? `<span class="badge good">👍 ${t("live_good", { n: usual })}</span>` : ""}</div>
      </div>
      ${isDone
        ? `<button type="button" class="link small" data-action="undo" data-id="${id}">${t("undo")}</button>`
        : isOpen(id) ? `<button type="button" class="pill ghost small-btn" data-action="done" data-id="${id}">✓ ${t("done")}</button>` : ""}
    </div>`;
  };

  return `
    ${showsSoonHtml(park)}
    <section class="card">
      <div class="row gap between"><h2>📡 ${t("live_title")}</h2>
        <button class="pill ghost" data-action="refresh">↻ ${t("live_refresh")}</button></div>
      <label class="field"><span>${t("live_park")}</span>${parkSelect}</label>
      <p class="small muted" style="margin:0">${state.latest?.updated ? esc(t("data_updated", { ago: ago(state.latest.updated) })) + " · " + t("live_auto") : t("live_nodata")}</p>
      ${stale ? `<p class="small notice">⚠️ ${esc(t("live_stale", { ago: ago(state.latest.updated) }))}</p>` : ""}
      ${catChips("live")}
      ${state.liveCats.length ? "" : `<p class="small muted" style="margin:6px 0 0">${t("live_hidden_cats")}</p>`}
    </section>
    <h3 class="section-title">${t("live_open", { n: open.length })}</h3>
    ${open.length ? `<div class="live-list">${open.map(row).join("")}</div>`
      : `<section class="card center muted">🌙 ${t(Object.keys(waits).length ? "live_none_open" : "live_nodata")}</section>`}
    ${closed.length ? `<details class="closed-list"><summary class="section-title">${t("live_closed", { n: closed.length })}</summary>
      <div class="live-list">${closed.map(row).join("")}</div></details>` : ""}`;
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
      state.visitMsg = ""; applyVisitLimits(); saveSettings(); render(); break;
    }
    case "forced-del": s.forced.splice(+el.dataset.i, 1); state.visitMsg = ""; applyVisitLimits(); saveSettings(); render(); break;
    case "visit": {
      const p = el.dataset.park;
      if (!P.PARK_BY_ID[p]) break;
      const d = +el.dataset.d;
      if (d > 0 && P.totalVisits(s.visits) + P.restDays(s) >= P.tripDays(s)) break;
      s.visits = { ...s.visits, [p]: Math.max(0, (s.visits?.[p] || 0) + d) };
      state.visitMsg = "";
      applyVisitLimits(); saveSettings(); render();
      $(`[data-action=visit][data-park="${p}"][data-d="${d}"]`)?.focus();
      break;
    }
    case "rest": {
      const d = +el.dataset.d;
      if (d > 0 && P.totalVisits(s.visits) + P.restDays(s) >= P.tripDays(s)) break;
      s.restDays = Math.max(P.forcedRestDays(s), P.restDays(s) + d);
      state.visitMsg = "";
      applyVisitLimits(); saveSettings(); render();
      $(`[data-action=rest][data-d="${d}"]`)?.focus();
      break;
    }
    case "cat": {
      const key = el.dataset.scope + "Cats";
      const c = el.dataset.cat;
      state[key] = c === "all" ? [] : state[key].includes(c) ? state[key].filter((x) => x !== c) : [...state[key], c];
      store.set(key, state[key]);
      render();
      $(`[data-action=cat][data-scope="${el.dataset.scope}"][data-cat="${c}"]`)?.focus();
      break;
    }
    case "theme": setTheme(el.dataset.theme); break;
    case "hours-edit": state.editHours = el.dataset.key; render(); $("#hours-open")?.focus(); break;
    case "hours-cancel": state.editHours = null; render(); break;
    case "hours-save": {
      const open = P.hmToMin($("#hours-open")?.value), close0 = P.hmToMin($("#hours-close")?.value);
      if (open == null || close0 == null) break;
      const close = close0 <= open ? close0 + 1440 : close0; // fermeture après minuit
      s.hoursOverride = { ...(s.hoursOverride || {}), [el.dataset.key]: { open, close } };
      state.editHours = null; saveSettings(); render(); break;
    }
    case "hours-reset": {
      const o = { ...(s.hoursOverride || {}) };
      delete o[el.dataset.key];
      s.hoursOverride = o; saveSettings(); render(); break;
    }
    case "open-notes": notesStatus(); $("#notes-dialog").showModal(); break;
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
    if (el.dataset.set === "lunch.at") v = +v;
    setPath(s, el.dataset.set, v);
    if (el.dataset.set === "start" && s.end < s.start) s.end = s.start;
    // les contraintes hors des dates du séjour sont retirées
    if (el.dataset.set === "start" || el.dataset.set === "end") {
      s.forced = s.forced.filter((f) => f.date >= s.start && f.date <= s.end);
      // dates raccourcies : on réduit les visites si besoin et on le signale
      state.visitMsg = "";
      if (stepValid("dates")) applyVisitLimits();
    }
    saveSettings(); render(); return;
  }
  if (el.dataset.forced != null) {
    s.forced[+el.dataset.forced][el.dataset.key] = el.value;
    state.visitMsg = ""; applyVisitLimits();
    saveSettings(); render(); return;
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

// ------------------------------------------------------------------ thème clair / sombre

const THEME_COLORS = { light: "#FFF8E8", dark: "#2A2A31" };
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === "auto") delete root.dataset.theme; else root.dataset.theme = state.theme;
  const effective = state.theme === "auto" ? (darkQuery?.matches ? "dark" : "light") : state.theme;
  // les deux balises theme-color (claire / sombre) suivent le choix forcé, sinon le réglage du téléphone
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.content = state.theme === "auto" ? THEME_COLORS[m.dataset.mode] : THEME_COLORS[effective];
  }
  const icon = { auto: "🌗", light: "☀️", dark: "🌙" }[state.theme];
  $("#theme-icon").textContent = icon;
  $("#theme-summary").setAttribute("aria-label", `${t("theme")} : ${t("theme_" + state.theme)}`);
  for (const b of document.querySelectorAll("[data-action=theme]")) {
    b.setAttribute("aria-checked", String(b.dataset.theme === state.theme));
    b.lastElementChild.textContent = t("theme_" + b.dataset.theme);
  }
}

function setTheme(theme) {
  if (!["auto", "light", "dark"].includes(theme)) return;
  state.theme = theme;
  store.set("theme", theme);
  applyTheme();
  $("#theme-menu").open = false;
}
darkQuery?.addEventListener?.("change", applyTheme);

/** Place le menu du thème sous son bouton, entièrement dans l'écran (marge de 16 px) */
function positionThemeMenu() {
  const menu = $("#theme-menu .menu");
  if (!$("#theme-menu").open || !menu) return;
  const MARGIN = 16;
  const btn = $("#theme-summary").getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(btn.right - w, MARGIN), vw - MARGIN - w);
  let top = btn.bottom + 6;
  if (top + h > vh - MARGIN) top = Math.max(MARGIN, btn.top - 6 - h); // pas la place dessous : au-dessus
  menu.style.left = `${Math.max(MARGIN, left)}px`;
  menu.style.top = `${top}px`;
}
$("#theme-menu").addEventListener("toggle", positionThemeMenu);
window.addEventListener("resize", positionThemeMenu);
window.addEventListener("scroll", () => { if ($("#theme-menu").open) $("#theme-menu").open = false; }, { passive: true });
document.addEventListener("click", (e) => {
  const menu = $("#theme-menu");
  if (menu?.open && !menu.contains(e.target)) menu.open = false;
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
    ensureVisits();
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
  setInterval(() => {
    updateClock();
    // « dans X min » des spectacles tenu à jour sans recharger toute la page
    const box = $("#shows-soon");
    if (box && state.tab === "live") box.outerHTML = showsSoonHtml(state.livePark);
  }, 30000);
  setInterval(() => { if (state.tab === "live" && document.visibilityState === "visible") refreshLatest(); }, 5 * 60000);
}

init();
