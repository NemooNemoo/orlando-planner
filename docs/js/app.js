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
  parks: P.PARKS.map((p) => p.id).filter((p) => p !== "volcano_bay"), // parc aquatique : à ajouter soi-même
  // coupe-files par jour : mode "all" (tous les jours), "none" ou "some" (dates cochées)
  passes: { multi: { mode: "all", dates: [] }, single: { mode: "none", dates: [] }, express: { mode: "none", dates: [] } },
  visits: null, // { parc: nombre de visites } — calculé au démarrage si absent
  pace: "normal",
  lunch: { enabled: true, at: 720 },
  earlyDisney: false,    // Early Entry Disney (et soirées prolongées)
  earlyUniversal: false, // Early Park Admission Universal
  hoursOverride: {}, // corrections manuelles { "AAAA-MM-JJ|parc": { open, close } } en minutes
  dayTypes: {}, // { "AAAA-MM-JJ": "rest" | "park" | parc } ; absent = automatique
  mustDo: [],
  surprise: false,
};

// Anciennes valeurs migrées ou ignorées sans erreur
function loadSettings() {
  const saved = store.get("settings", {});
  const old = saved && typeof saved === "object" ? saved : {};
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...old };
  delete s.kids; // mode enfants supprimé
  // coupe-files : ancien choix oui / non -> tous les jours ou aucun
  if (!old.passes && (old.ll || "express" in old)) {
    const m = (on) => ({ mode: on ? "all" : "none", dates: [] });
    s.passes = { multi: m(old.ll?.multi), single: m(old.ll?.single), express: m(old.express) };
  }
  delete s.ll; delete s.express;
  // option unique « hôtel sur place » -> une option par resort
  if ("hotelPerks" in old && !("earlyDisney" in old)) s.earlyDisney = s.earlyUniversal = !!old.hotelPerks;
  delete s.hotelPerks;
  // parcs / repos imposés -> type de chaque jour
  if (Array.isArray(old.forced) && old.forced.length && !old.dayTypes) {
    s.dayTypes = Object.fromEntries(old.forced.filter((f) => f.date && f.park).map((f) => [f.date, f.park]));
  }
  delete s.forced;
  for (const k of ["multi", "single", "express"]) {
    const v = s.passes?.[k];
    if (!v || !["all", "none", "some"].includes(v.mode)) s.passes[k] = { mode: "none", dates: [] };
    if (!Array.isArray(s.passes[k].dates)) s.passes[k].dates = [];
  }
  if (!s.dayTypes || typeof s.dayTypes !== "object") s.dayTypes = {};
  return s;
}

/** Coupe-file actif ce jour-là ? (k = multi | single | express) */
function passOn(k, date) {
  const v = state.settings.passes?.[k];
  return v?.mode === "all" || (v?.mode === "some" && v.dates.includes(date));
}

/** Réglages du jour : coupe-files de la date (le planificateur ne les applique qu'à la bonne marque) */
function settingsFor(date) {
  const s = state.settings;
  return { ...s, ll: { multi: passOn("multi", date), single: passOn("single", date) }, express: passOn("express", date) };
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
  plusCats: [], plusSearch: "", plusPick: null, plusDone: null, // panneau « + »
  dayState: null, dayMsg: "", editEntry: null,
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
/** File « Single Rider » -> identifiant de l'attraction principale (sinon l'identifiant tel quel) */
function mainRideId(id) {
  if (state.meta[id]) return id;
  const name = state.catalog[id]?.name || "";
  if (!/ single rider$/i.test(name)) return id;
  const main = P.normName(name.replace(/ single rider$/i, ""));
  return Object.keys(state.meta).find((k) => P.normName(rideName(k)) === main) || id;
}

function rideType(id) {
  const type = P.rideType(id, state.meta, state.catalog);
  if (type) return type;
  const main = mainRideId(id);
  return main !== id ? state.meta[main].type : null;
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
  // entrée anticipée seulement si l'option de la marque du parc est cochée
  const early = parkOf(park)?.group === "disney" ? s.earlyDisney : s.earlyUniversal;
  return P.dayHours(park, date, { schedule: state.schedule, overrides: s.hoursOverride, model: getModel(), hotelPerks: !!early });
}

function dayPlan(date, park) {
  return P.planDay({
    park, date, wd: P.weekdayOf(date), settings: settingsFor(date), model: getModel(),
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
  // bouton « + » : onglet Journée uniquement, quand le jour a un parc
  const fab = state.tab === "day" && state.dayState && document.querySelector(".day-end");
  $("#fab-plus").hidden = !fab;
  $("#fab-plus").setAttribute("aria-label", t("plus_label"));
  document.body.classList.toggle("has-fab", !!fab);
  if (!fab) state.dayState = null;
  updateFooter();
  updateClock();
  maybeOpenOverflow();
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

const STEPS = ["dates", "parks", "days", "passes", "pace", "must", "recap"];

function viewSetup() {
  const s = state.settings;
  const step = Math.min(state.step, STEPS.length - 1);
  const valid = STEPS.slice(0, step + 1).every(stepValid);
  const last = step === STEPS.length - 1;
  const dots = STEPS.map((_, i) => `<span class="${i <= step ? "on" : ""}" data-action="step" data-step="${i}"></span>`).join("");
  const STEP_VIEWS = { dates: stepDates, parks: stepParks, passes: stepPasses, pace: stepPace, days: stepDays, must: stepMust, recap: stepRecap };
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
  if (name === "days" || name === "recap") return !P.normalizeVisits(s).missingVisits;
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
  const counts = P.parkDayCounts(s);
  const forcedCount = counts.specific;
  const restMax = P.restLimit(s); // les jours « en parc » ne peuvent pas être des repos
  const restFull = rest >= restMax;
  const missing = P.normalizeVisits(s).missingVisits;
  const counter = ({ cls = "", label, sub, n, min, action, park = "", less, more, plusOff = full }) => `
      <div class="counter-row ${n ? "on" : ""} ${cls}">
        <span class="grow">${label}<small class="muted">${sub}</small></span>
        <button type="button" class="round" data-action="${action}" data-park="${park}" data-d="-1" ${n <= min ? "disabled" : ""}
          aria-label="${esc(less)}">−</button>
        <output class="count" aria-live="polite">${n}</output>
        <button type="button" class="round" data-action="${action}" data-park="${park}" data-d="1" ${plusOff ? "disabled" : ""}
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
      n: rest, min: forcedRest, action: "rest", less: t("rest_less"), more: t("rest_more"), plusOff: full || restFull })}
    ${restFull && !full ? `<p class="small notice" role="status">${t("rest_limit", { n: counts.total })}</p>` : ""}`;
  return `<h2>${t("s_parks")}</h2><p class="muted small">${t("s_parks_help")}</p>
    <p class="small total-line"><b>${t("days_total", { v: total, r: rest, sum: total + rest, days })}</b></p>
    ${full ? `<p class="small notice" role="status">${t("days_limit", { days })}</p>` : ""}
    ${missing ? `<p class="small err" role="alert">${t("visits_missing", { n: counts.total, v: total })}</p>` : ""}
    ${visitMsgHtml()}
    ${group("disney")}${group("universal")}${restRow}
    ${closedWarnings(s)}
    ${(s.visits?.volcano_bay || 0) > 0 ? `<p class="small muted">🌋 ${t("vb_closed_note")}</p>` : ""}
    ${total ? "" : `<p class="small err">${t("parks_none")}</p>`}`;
}

/** Parcs avec plus de visites que de jours d'ouverture pendant le séjour (fermeture pour rénovation) */
function closedWarnings(s) {
  const dates = stepValid("dates") ? P.dateRange(s.start, s.end) : [];
  return P.PARKS.filter((p) => (s.visits?.[p.id] || 0) > 0).map((p) => {
    const open = dates.filter((d) => !P.parkClosed(p.id, d)).length;
    return open < s.visits[p.id]
      ? `<p class="small err" role="alert">${p.emoji} ${esc(t("park_closed_trip", { park: p.name, n: s.visits[p.id], open }))}</p>` : "";
  }).join("");
}

function stepPasses(s) {
  const hasDisney = s.parks.some((p) => parkOf(p).group === "disney");
  const hasUni = s.parks.some((p) => parkOf(p).group === "universal");
  const dates = stepValid("dates") ? P.dateRange(s.start, s.end) : [];
  const days = state.configured ? Object.fromEntries(trip().map((d) => [d.date, d])) : {};
  const passBlock = (k, brand, title, help) => {
    const v = s.passes[k];
    const n = dates.filter((d) => passOn(k, d)).length;
    return `<div class="pass-block">
      <div class="row gap between"><b>${t(title)}</b><span class="badge">${v.mode === "all" ? t("pass_all") : t("pass_n", { n })}</span></div>
      <small class="muted">${t(help)}</small>
      <div class="row gap" style="margin:6px 0">
        <button type="button" class="pill ghost small-btn" data-action="pass-mode" data-pass="${k}" data-mode="all">${t("pass_all_btn")}</button>
        <button type="button" class="pill ghost small-btn" data-action="pass-mode" data-pass="${k}" data-mode="none">${t("pass_none_btn")}</button>
      </div>
      <div class="date-chips" role="group" aria-label="${esc(t(title))}">${dates.map((d) => {
        const on = passOn(k, d);
        const park = days[d]?.park;
        const other = park && parkOf(park).group !== brand; // ce jour-là, parc de l'autre marque
        return `<button type="button" class="dchip ${on ? "on" : ""} ${other ? "other" : ""}" aria-pressed="${on}"
          data-action="pass-day" data-pass="${k}" data-date="${d}"
          title="${other ? esc(t("pass_other_brand")) : ""}">${esc(fmtDate(d, { weekday: "short", day: "numeric" }))}${park ? " " + parkOf(park).emoji : ""}</button>`;
      }).join("")}</div>
    </div>`;
  };
  return `<h2>${t("s_passes")}</h2><p class="muted small">${t("s_passes_help")}</p>
    ${hasDisney ? `<div class="group-title"><span class="dot disney"></span>${t("disney")}</div>
      ${passBlock("multi", "disney", "ll_multi", "ll_multi_help")}
      ${passBlock("single", "disney", "ll_single", "ll_single_help")}
      <label class="choice"><input type="checkbox" data-set="earlyDisney" ${s.earlyDisney ? "checked" : ""}>
        <span><b>${t("early_disney")}</b><small>${t("early_disney_help")}</small></span></label>` : ""}
    ${hasUni ? `<div class="group-title"><span class="dot universal"></span>${t("universal")}</div>
      ${passBlock("express", "universal", "express", "express_help")}
      <label class="choice"><input type="checkbox" data-set="earlyUniversal" ${s.earlyUniversal ? "checked" : ""}>
        <span><b>${t("early_universal")}</b><small>${t("early_universal_help")}</small></span></label>` : ""}`;
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

function stepDays(s) {
  const dates = stepValid("dates") ? P.dateRange(s.start, s.end) : [];
  const types = P.dayTypes(s);
  const counts = P.parkDayCounts(s);
  const missing = P.normalizeVisits(s).missingVisits;
  const rows = dates.map((d) => {
    const v = types[d] || "auto";
    const opt = (val, label, disabled = false) =>
      `<option value="${val}" ${v === val ? "selected" : ""} ${disabled ? "disabled" : ""}>${label}</option>`;
    return `<div class="day-type-row ${v !== "auto" ? "set" : ""}">
      <span class="grow"><b>${esc(fmtDate(d, { weekday: "short", day: "numeric", month: "short" }))}</b></span>
      <select data-daytype="${d}" aria-label="${esc(t("day_type_of", { date: fmtDate(d) }))}">
        ${opt("auto", "✨ " + t("dt_auto"))}
        ${opt("rest", "🏖️ " + t("dt_rest"))}
        ${opt("park", "🎢 " + t("dt_park"))}
        <optgroup label="${t("dt_specific")}">
          ${P.PARKS.map((p) => opt(p.id, `${p.emoji} ${p.name}${P.parkClosed(p.id, d) ? " — " + t("closed") : ""}`, P.parkClosed(p.id, d))).join("")}
        </optgroup>
      </select>
    </div>`;
  }).join("");
  return `<h2>${t("s_days")}</h2><p class="muted small">${t("s_days_help")}</p>
    <p class="small"><b>${esc(t("days_summary", { rest: P.forcedRestDays(s), park: counts.total }))}</b></p>
    ${missing ? `<p class="small err" role="alert">${t("visits_missing", { n: counts.total, v: P.totalVisits(s.visits) })}</p>` : ""}
    ${visitMsgHtml()}
    <div class="day-types">${rows}</div>`;
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
  const allDates = P.dateRange(s.start, s.end);
  const passTxt = (k) => {
    const n = allDates.filter((d) => passOn(k, d)).length;
    return s.passes[k].mode === "all" ? t("pass_all") : n ? t("pass_n", { n }) : t("no");
  };
  if (s.parks.some((p) => parkOf(p).group === "disney")) {
    passes.push(`${t("ll_multi")} : ${passTxt("multi")}`, `${t("ll_single")} : ${passTxt("single")}`,
      `${t("early_disney")} : ${yes(s.earlyDisney)}`);
  }
  if (s.parks.some((p) => parkOf(p).group === "universal")) {
    passes.push(`${t("express")} : ${passTxt("express")}`, `${t("early_universal")} : ${yes(s.earlyUniversal)}`);
  }
  const types = Object.entries(P.dayTypes(s)).sort();
  const dtLabel = (v) => (v === "rest" ? "🏖️ " + t("dt_rest") : v === "park" ? "🎢 " + t("dt_park") : parkOf(v).emoji + " " + parkOf(v).name);
  const forced = types.length ? types.map(([d, v]) => `${esc(fmtDate(d))} → ${dtLabel(v)}`).join("<br>") : t("dt_all_auto");
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
    ${row(t("s_days"), forced, "days")}
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
  // un jour imposé à un parc garde au moins une visite de ce parc (normalizeVisits) : rien à retirer ici
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
      ${closedWarnings(state.settings)}
    </section>
    ${days.map((d) => {
      const p = d.park && parkOf(d.park);
      return `<button class="cal-day ${p ? p.group : d.rest ? "rest" : "free"}" data-action="open-day" data-date="${d.date}">
        <span class="cal-date"><small>${esc(fmtDate(d.date, { weekday: "short" }))}</small><b>${+d.date.slice(8)}</b><small>${esc(fmtDate(d.date, { month: "short" }))}</small></span>
        <span class="cal-emoji">${dayEmoji(d)}</span>
        <span class="grow">
          <span class="cal-park">${p ? p.name : d.rest ? t("rest_day") : t("free_day")}</span>
          ${d.forced ? `<span class="badge">📌 ${t("forced")}</span>` : d.anyPark ? `<span class="badge">📌 ${t("dt_park")}</span>` : ""}<br>
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

// Stockage par date : entrées dans les files, fin de journée, programme prévu, reports
const entriesKey = (date) => `entries.${date}`;
const getEntries = (date) => { const v = store.get(entriesKey(date), []); return Array.isArray(v) ? v : []; };
const setEntries = (date, list) => store.set(entriesKey(date), list);
const getDeferred = () => { const v = store.get("deferred", []); return Array.isArray(v) ? v : []; };
const doneKey = (date, park) => `done.${date}.${park}`;

/** Où en est la journée : programme recalculé, entrées, activités prévues qui ne tiennent plus */
function computeDay(date, park) {
  const s = settingsFor(date); // coupe-files du jour
  const h = hoursFor(date, park);
  const wd = P.weekdayOf(date);
  const entries = getEntries(date).filter((e) => e.park === park).sort((a, b) => a.at - b.at);
  const deferred = getDeferred();
  const deferredOut = new Set(deferred.filter((d) => d.from === date && d.park === park).map((d) => d.id));
  const deferredIn = deferred.filter((d) => d.to === date && d.park === park);
  const endAt = store.get(`dayEnd.${date}`, null);
  const base = { park, date, wd, settings: s, model: getModel(), meta: state.meta, catalog: state.catalog,
    seed: state.seeds[date] || 0, priorities: prioById(), hours: h, endAt,
    exclude: deferredOut, extraMust: deferredIn.map((d) => d.id) };
  // programme prévu (sans les entrées) : référence pour savoir ce qui ne tient plus
  const sig = daySig(date, h, endAt, deferredIn);
  let snap = store.get(`snapshot.${date}`, null);
  if (!snap || snap.sig !== sig || snap.park !== park) {
    snap = { sig, park, ids: P.planDay(base).firstIds };
    store.set(`snapshot.${date}`, snap);
  }
  // fait : entrées enregistrées, « Fait » de Direct, et ce que le programme avait terminé avant chaque entrée
  const done = new Set([...entries.filter((e) => e.id).map((e) => e.id), ...entries.flatMap((e) => e.assumed || []),
    ...store.get(doneKey(date, park), []).map(mainRideId)]);
  const lastExit = entries.length ? Math.max(...entries.map((e) => e.exit)) : null;
  const plan = P.planDay({ ...base, from: lastExit ?? undefined, done, only: new Set(snap.ids),
    lastRide: entries.at(-1)?.id || null });
  const placed = new Set(plan.firstIds);
  const remaining = snap.ids.filter((id) => !deferredOut.has(id) && !done.has(id));
  const dropped = [...new Set([...remaining.filter((id) => !placed.has(id)), ...plan.unplaced])];
  return { plan, h, entries, endAt, remaining, dropped, deferredIn, wd };
}

function daySig(date, h, endAt, deferredIn) {
  return JSON.stringify([state.settings, h.planOpen, h.planClose, endAt, state.seeds[date] || 0, deferredIn.map((d) => d.id),
    state.priorities?.at, state.stats?.generated]);
}

function entryStatus(date, e) {
  const now = P.orlandoNow();
  if (date < now.date) return "done";
  if (date > now.date) return "saved";
  return now.min < e.exit ? "current" : "done";
}

function timelineHtml(plan, wd, extra = {}) {
  const entries = extra.entries || [];
  const deferredIn = new Map((extra.deferredIn || []).map((d) => [d.id, d.from]));
  const rows = [
    ...entries.map((e) => ({ kind: "entry", at: e.at, e })),
    ...plan.items.filter((it) => !(entries.length && it.kind === "start")).map((it) => ({ ...it })),
  ];
  if (entries.length) rows.push({ kind: "resume", at: plan.start });
  rows.sort((a, b) => a.at - b.at || (a.kind === "entry" ? -1 : 1));
  const items = rows.map((it) => {
    const time = `<div class="tl-time">${P.fmtTime(it.at)}</div>`;
    if (it.kind === "start") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">🚪 ${t("arrive")}</div></div></li>`;
    if (it.kind === "resume") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">▶️ ${t("resume")}</div></div></li>`;
    if (it.kind === "end") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">👋 ${t("leave")}</div></div></li>`;
    if (it.kind === "lunch") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">🍽️ ${t("lunch")} · ${P.fmtTime(it.at)}–${P.fmtTime(it.end)}</div></div></li>`;
    if (it.kind === "break") return `<li class="tl">${time}<div class="tl-body"><div class="tl-note">☕ ${t("break")} · ${it.end - it.at} ${t("min")}</div></div></li>`;
    if (it.kind === "entry") return entryHtml(it.e, time, extra.date);
    const m = state.meta[it.id];
    const from = deferredIn.get(it.id);
    const badges = [
      tierBadge(it.id),
      typeBadge(it.id),
      it.must ? `<span class="badge must">★ ${t("must")}</span>` : "",
      from ? `<span class="badge">↪️ ${esc(t("deferred_from", { date: fmtDate(from) }))}</span>` : "",
      it.reride ? `<span class="badge">🔁 ${t("reride")}</span>` : "",
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

function entryHtml(e, time, date) {
  const status = entryStatus(date, e);
  const editing = state.editEntry === e.uid;
  const icon = e.kind === "show" ? "🎭" : TYPE_ICON[rideType(e.id)] || "🎢";
  return `<li class="tl">${time}<div class="tl-body">
    <div class="tl-card entry ${status}">
      <div class="grow">
        <div class="title">${icon} ${esc(e.name)}</div>
        <div class="meta">${e.kind === "show"
          ? esc(t("entry_show_meta", { arrive: fmtHour(e.at), start: fmtHour(e.showStart), end: fmtHour(e.exit) }))
          : esc(t("entry_meta", { at: fmtHour(e.at), wait: e.wait, dur: e.dur }))}</div>
        <div class="badges"><span class="badge entry-${status}">${t("entry_" + status)}</span>
          <span class="badge">${esc(t("exit_at", { time: fmtHour(e.exit) }))}</span></div>
        ${editing ? `<div class="row gap" style="margin-top:8px">
            <input type="time" id="entry-time" value="${P.fmtTime(e.at)}" aria-label="${t("entry_time")}" style="max-width:9rem">
            <button type="button" class="pill" data-action="entry-save" data-uid="${e.uid}">${t("save")}</button>
            <button type="button" class="pill ghost" data-action="entry-edit" data-uid="">${t("cancel")}</button></div>`
          : `<div class="row gap" style="margin-top:6px">
            <button type="button" class="link small" data-action="entry-edit" data-uid="${e.uid}">${t("entry_fix")}</button>
            <button type="button" class="link small" data-action="entry-del" data-uid="${e.uid}">${t("entry_cancel")}</button></div>`}
      </div>
    </div></div></li>`;
}

function notThisTimeHtml() {
  const list = getDeferred().filter((d) => !d.to);
  if (!list.length) return "";
  return `<section class="card">
    <h3>📝 ${t("not_this_time")}</h3>
    <ul class="plain-list">${list.map((d) => `<li>${parkOf(d.park)?.emoji || ""} ${esc(rideName(d.id))}
      <span class="small muted">· ${esc(fmtDate(d.from))}</span>
      <button type="button" class="link small" data-action="undefer" data-id="${d.id}" data-from="${d.from}">${t("put_back")}</button></li>`).join("")}</ul>
  </section>`;
}

function viewDay() {
  state.dayState = null;
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
  const cd = computeDay(day.date, day.park);
  const { plan, h } = cd;
  state.dayState = { date: day.date, park: day.park, cd };
  const sparse = plan.items.some((i) => i.kind === "ride" && !getModel().hasData(i.id));
  const endVal = P.fmtTime(Math.min(cd.endAt ?? plan.close, plan.close) % 1440);
  return `
    <div class="chips">${chips}</div>
    <section class="card">
      <div class="day-head">
        <span class="emoji">${p.emoji}</span>
        <div class="grow">
          <p class="muted small" style="margin:0">${esc(fmtDate(day.date, { weekday: "long", day: "numeric", month: "long" }))}</p>
          <h2>${p.name}</h2>
          <div class="row gap small">${crowdTag(day.crowd)}</div>
          <p class="small" style="margin:4px 0 0">${hoursLine(h)}</p>
        </div>
      </div>
      <div class="day-end">
        <label class="field"><span>${t("day_end")}</span>
          <input type="time" id="day-end" value="${endVal}" data-date="${day.date}"></label>
        <p class="small muted">${plan.userEnd != null ? esc(t("day_end_custom", { time: fmtHour(plan.userEnd) })) : esc(t("day_end_close", { time: fmtHour(plan.close) }))}</p>
        ${plan.userEnd != null ? `<button type="button" class="pill ghost" data-action="day-end-reset" data-date="${day.date}">${t("until_close")}</button>` : ""}
      </div>
      ${state.dayMsg ? `<p class="small notice" role="status">ℹ️ ${esc(state.dayMsg)}</p>` : ""}
      <p class="small" style="margin:10px 0 0">${t("total_wait", { n: plan.totalWait })}</p>
      ${cd.dropped.length ? `<p class="small err">${esc(t("dropped_line", { list: cd.dropped.map(rideName).join(", ") }))}
        <button type="button" class="link small" data-action="overflow-open">${t("choose")}</button></p>` : ""}
      ${sparse ? `<p class="small muted">ℹ️ ${t("estimate_note")}</p>` : ""}
      ${state.settings.surprise ? `<button class="pill ghost" data-action="reshuffle" data-date="${day.date}">🎲 ${t("reshuffle")}</button>` : ""}
    </section>
    ${timelineHtml(plan, day.wd, { entries: cd.entries, date: day.date, deferredIn: cd.deferredIn })}
    ${notThisTimeHtml()}`;
}

// ------------------------------------------------------------------ « + » : j'entre dans la file

function plusItems(date, park) {
  const now = P.orlandoNow();
  const today = date === now.date;
  const waits = today ? state.latest?.parks?.[park] || {} : {};
  const done = new Set([...getEntries(date).map((e) => e.id).filter(Boolean), ...store.get(doneKey(date, park), []).map(mainRideId)]);
  const list = P.eligibleRides(park, state.settings, state.meta).map((id) => {
    const live = waits[id];
    const type = rideType(id);
    const wait = type === "show" ? null
      : live?.open && typeof live.wait === "number" ? live.wait : getModel().expected(id, P.weekdayOf(date), now.min);
    return { key: id, id, name: rideName(id), type, wait, live: !!(live?.open), done: done.has(id) };
  });
  // spectacles et rencontres à horaires fixes de shows.json absents de rides_meta.json
  const seen = new Set(list.map((x) => P.normName(x.name)));
  for (const sh of showsOf(park, date)) {
    const k = P.normName(sh.name);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ key: "show:" + k, id: null, name: sh.name, type: isMeetName(sh.name) ? "meet" : "show", wait: null, showOnly: true });
  }
  return list;
}

const isMeetName = (name) => /\bmeet\b/i.test(name || "");

/** Séances du jour (shows.json) d'un parc ; vide si la date n'est pas celle du fichier */
function showsOf(park, date) {
  const list = state.shows?.parks?.[park] || [];
  return list.filter((sh) => (sh.start || "").slice(0, 10) === date);
}

/** Séances d'une attraction/spectacle par correspondance de nom tolérante */
function showtimesFor(name, park, date) {
  const k = P.normName(name);
  if (!k) return [];
  return showsOf(park, date).filter((sh) => {
    const n = P.normName(sh.name);
    return n === k || (k.length > 6 && n.includes(k)) || (n.length > 6 && k.includes(n));
  });
}

const isoMin = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(iso || ""); return m ? +m[1] * 60 + +m[2] : null; };

function plusSheetHtml() {
  const ds = state.dayState;
  if (!ds) return "";
  const { date, park } = ds;
  const q = state.plusSearch.trim().toLowerCase();
  if (state.plusPick) return showPickHtml();
  if (state.plusDone) {
    const e = state.plusDone;
    return `<div class="sheet-head"><h2>✅ ${t("entry_saved_head")}</h2></div>
      <p><b>${esc(e.name)}</b></p>
      <p>${esc(e.kind === "show" ? t("entry_show_meta", { arrive: fmtHour(e.at), start: fmtHour(e.showStart), end: fmtHour(e.exit) })
        : t("entry_meta", { at: fmtHour(e.at), wait: e.wait, dur: e.dur }))}</p>
      <p class="big-exit">${esc(t("exit_at", { time: fmtHour(e.exit) }))}</p>
      <div class="row gap"><button type="button" class="pill" data-action="plus-close">${t("close")}</button>
        <button type="button" class="pill ghost danger" data-action="entry-del" data-uid="${e.uid}">${t("entry_cancel")}</button></div>`;
  }
  const items = plusItems(date, park)
    .filter((x) => (!q || x.name.toLowerCase().includes(q)) && (!state.plusCats.length || state.plusCats.includes(x.type)))
    .sort((a, b) => (a.wait ?? 999) - (b.wait ?? 999) || a.name.localeCompare(b.name));
  return `<div class="sheet-head"><h2>➕ ${t("plus_title")}</h2>
      <button type="button" class="pill ghost" data-action="plus-close" aria-label="${t("close")}">✕</button></div>
    <p class="small muted">${esc(t("plus_help", { park: parkOf(park).name }))}</p>
    <input type="search" id="plus-search" placeholder="${t("search")}" aria-label="${t("search")}" value="${esc(state.plusSearch)}">
    ${catChips("plus")}
    <div class="plus-list">${items.map((x) => `
      <button type="button" class="plus-item" data-action="plus-pick" data-key="${esc(x.key)}">
        ${x.wait != null ? waitChip(x.wait) : `<span class="wait none">${TYPE_ICON[x.type] || "🎭"}</span>`}
        <span class="grow"><span class="name">${esc(x.name)}</span>
          <span class="small muted">${TYPE_ICON[x.type] || ""} ${x.type ? t("type_" + x.type) : ""}${x.wait != null ? " · " + (x.live ? t("wait_live") : t("wait_forecast")) : ""}${x.done ? " · ✓ " + t("done_already") : ""}</span></span>
      </button>`).join("") || `<p class="muted small">${t("filter_empty")}</p>`}</div>`;
}

function showPickHtml() {
  const { date, park } = state.dayState;
  const x = state.plusPick;
  const times = showtimesFor(x.name, park, date);
  return `<div class="sheet-head"><h2>🎭 ${esc(x.name)}</h2>
      <button type="button" class="pill ghost" data-action="plus-back">← ${t("prev")}</button></div>
    <p class="small muted">${t("show_pick_help")}</p>
    ${times.length ? `<div class="plus-list">${times.map((sh, i) => `
      <button type="button" class="plus-item" data-action="plus-show" data-i="${i}">
        <span class="show-time">${fmtHour(isoMin(sh.start))}</span>
        <span class="grow small">${esc(t("arrive_before", { time: fmtHour(isoMin(sh.start) - 15) }))}</span></button>`).join("")}</div>`
      : `<p class="small">${t("showtimes_none")}</p>
        <button type="button" class="pill" data-action="plus-show-now">${t("show_go_now")}</button>`}`;
}

function openPlus() {
  state.plusSearch = ""; state.plusPick = null; state.plusDone = null;
  const d = $("#plus-sheet");
  d.innerHTML = plusSheetHtml();
  d.setAttribute("aria-label", t("plus_title"));
  d.showModal();
  $("#plus-search")?.focus();
}
const refreshPlus = () => { const d = $("#plus-sheet"); if (d.open) d.innerHTML = plusSheetHtml(); };

function recordEntry(entry) {
  const { date, park } = state.dayState;
  // on suppose que le programme a été suivi jusqu'ici : ce qui était fini avant l'entrée est fait
  const before = computeDay(date, park).plan.items;
  entry.assumed = before.filter((i) => i.kind === "ride" && !i.reride && i.end <= entry.at && i.id !== entry.id).map((i) => i.id);
  const list = getEntries(date);
  list.push(entry);
  setEntries(date, list);
  state.plusDone = entry;
  state.plusPick = null;
  state.dayMsg = "";
  refreshPlus();
  render();
}

function pickPlus(key) {
  const { date, park } = state.dayState;
  const x = plusItems(date, park).find((i) => i.key === key);
  if (!x) return;
  if (x.type === "show" || x.showOnly) { state.plusPick = x; refreshPlus(); return; }
  const now = P.orlandoNow();
  const dur = state.meta[x.id]?.duration ?? 5;
  const wait = Math.round(x.wait ?? 0);
  recordEntry({ uid: Date.now(), id: x.id, name: x.name, kind: "ride", park, at: now.min, wait, dur, exit: now.min + wait + dur });
}

function recordShow(sh) {
  const { park } = state.dayState;
  const x = state.plusPick;
  const start = sh ? isoMin(sh.start) : P.orlandoNow().min;
  const end = sh?.end ? isoMin(sh.end) : null;
  const dur = end && end > start ? end - start : state.meta[x.id]?.duration ?? 20;
  const arrive = sh ? start - 15 : start;
  recordEntry({ uid: Date.now(), id: x.id, name: x.name, kind: "show", park, at: arrive, showStart: start, wait: start - arrive, dur, exit: start + dur });
}

// ------------------------------------------------------------------ quand tout ne tient plus

function overflowHtml() {
  const ds = state.dayState;
  if (!ds) return "";
  const { cd, date, park } = ds;
  const mustAll = new Set([...(state.settings.mustDo || []), ...cd.deferredIn.map((d) => d.id)]);
  const list = [...new Set([...cd.dropped, ...cd.remaining])];
  return `<form method="dialog" class="dialog-body">
    <h2>⏳ ${t("overflow_title")}</h2>
    <p>${t("overflow_question")}</p>
    <div class="plus-list">${list.map((id) => `
      <button type="button" class="plus-item" data-action="defer" data-id="${id}">
        <span class="grow"><span class="name">${esc(rideName(id))}</span>
          <span class="badges">${mustAll.has(id) ? `<span class="badge must">★ ${t("must")}</span>` : ""}${cd.dropped.includes(id) ? `<span class="badge hours-estimated">${t("no_longer_fits")}</span>` : ""}</span></span>
        <span aria-hidden="true">›</span>
      </button>`).join("")}</div>
    ${cd.endAt != null ? `<button type="button" class="pill ghost" data-action="finish-later">🕘 ${t("finish_later")}</button>` : ""}
    <button type="button" class="pill ghost" data-action="overflow-later">${t("decide_later")}</button>
  </form>`;
}

function maybeOpenOverflow(force = false) {
  const ds = state.dayState;
  const dlg = $("#overflow-dialog");
  if (state.tab !== "day" || !ds || !ds.cd.dropped.length) { if (dlg.open) dlg.close(); return; }
  if ($("#plus-sheet").open) return; // on attend la fermeture du panneau « + »
  const sig = `${ds.date}|${[...ds.cd.dropped].sort().join(",")}`;
  if (!force && store.get(`overflowSeen.${ds.date}`, "") === sig) return;
  dlg.innerHTML = overflowHtml();
  if (!dlg.open) dlg.showModal();
}

function deferActivity(id) {
  const { date, park } = state.dayState;
  const next = trip().find((d) => d.park === park && d.date > date);
  const list = getDeferred().filter((d) => !(d.id === id && d.from === date));
  list.push({ id, park, from: date, to: next?.date || null });
  store.set("deferred", list);
  state.dayMsg = next
    ? t("deferred_to", { name: rideName(id), date: fmtDate(next.date, { weekday: "long", day: "numeric", month: "long" }), park: parkOf(park).name })
    : t("deferred_none", { name: rideName(id) });
  $("#overflow-dialog").close();
  render();
}

/** Fin de journée la plus proche qui permet de tout faire (au plus la fermeture), même programme prévu */
function finishLater() {
  const { date, park, cd } = state.dayState;
  const close = cd.plan.close;
  const ids = store.get(`snapshot.${date}`, { ids: [] }).ids;
  const tryEnd = (e) => {
    if (e >= close) store.del(`dayEnd.${date}`); else store.set(`dayEnd.${date}`, e);
    // on garde le même programme prévu : seule l'heure de fin change
    store.set(`snapshot.${date}`, { sig: daySig(date, cd.h, e >= close ? null : e, cd.deferredIn), park, ids });
    return !computeDay(date, park).dropped.length;
  };
  let end = close;
  for (let e = (cd.endAt ?? close) + 15; e < close; e += 15) if (tryEnd(e)) { end = e; break; }
  if (end >= close) tryEnd(close);
  state.dayMsg = end >= close ? t("until_close_set") : t("day_end_custom", { time: fmtHour(end) });
  $("#overflow-dialog").close();
  render();
}

// ------------------------------------------------------------------ direct

const SOON_WINDOW = 120; // les 2 prochaines heures, plus les séances commencées il y a moins de 10 min

/** Rencontre à horaires fixes ? (nom « Meet … » ou fiche de type rencontre) */
function isMeetShow(name) {
  if (isMeetName(name)) return true;
  const k = P.normName(name);
  return Object.values(state.meta).some((m) => m.type === "meet" && P.normName(m.name) === k);
}

function showsSoon(park, meets) {
  const nowMs = Date.now();
  return (state.shows?.parks?.[park] || [])
    .filter((sh) => isMeetShow(sh.name) === meets)
    .map((sh) => ({ ...sh, delta: Math.round((new Date(sh.start).getTime() - nowMs) / 60000) }))
    .filter((sh) => isFinite(sh.delta) && sh.delta >= -10 && sh.delta <= SOON_WINDOW)
    .sort((a, b) => a.delta - b.delta);
}

/** Section repliable « Spectacles » ou « Rencontres » ; masquée s'il n'y a rien dans les 2 h */
function soonSectionHtml(park, meets) {
  const list = showsSoon(park, meets);
  const id = meets ? "meets-soon" : "shows-soon";
  const open = store.get(meets ? "meetsOpen" : "showsOpen", false);
  const next = list.find((sh) => sh.delta >= 0) || list[0];
  const icon = meets ? "🤝" : "🎭";
  return `<details class="card shows-card" id="${id}" ${open ? "open" : ""} ${list.length ? "" : "hidden"}>
    <summary><span class="grow"><b>${icon} ${t(meets ? "meets_soon" : "shows_soon")}</b><br>
      <span class="small muted">${next ? esc(t(meets ? "meets_summary" : "shows_summary", { n: list.length, time: fmtHour(isoMin(next.start)) })) : ""}</span></span>
      <span class="chev" aria-hidden="true">▾</span></summary>
    <div class="shows-list">${list.map((sh) => `
      <div class="show-row">
        <span class="show-time">${fmtHour(isoMin(sh.start))}</span>
        <span class="grow name">${esc(sh.name)}</span>
        <span class="badge ${sh.delta <= 0 ? "show-now" : ""}">${sh.delta <= 0 ? t("show_started", { n: -sh.delta }) : t("show_in", { n: sh.delta })}</span>
      </div>`).join("")}</div></details>`;
}

const showsSoonHtml = (park) => soonSectionHtml(park, false) + soonSectionHtml(park, true);

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

  const liveRide = (id) => state.meta[id] || / single rider$/i.test(state.catalog[id]?.name || "");
  const ids = Object.keys(waits).filter((id) => liveRide(id) && catMatch("live", id));
  const isShow = (id) => rideType(id) === "show";
  const isOpen = (id) => !isShow(id) && waits[id].open && typeof waits[id].wait === "number";
  const open = ids.filter(isOpen).sort((a, b) => waits[a].wait - waits[b].wait || rideName(a).localeCompare(rideName(b)));
  const shows = ids.filter(isShow).sort((a, b) => rideName(a).localeCompare(rideName(b)));
  const closed = ids.filter((id) => !isOpen(id) && !isShow(id)).sort((a, b) => rideName(a).localeCompare(rideName(b)));

  const row = (id) => {
    const w = waits[id];
    if (isShow(id)) {
      // spectacle : pas d'attente ni de bouton « Fait », mais ses prochaines séances
      const next = showtimesFor(rideName(id), park, now.date).map((sh) => isoMin(sh.start)).filter((m) => m >= now.min - 10);
      return `<div class="live-row show">
        <span class="wait none">🎭</span>
        <div class="grow"><div class="name">${esc(rideName(id))}</div>
          <div class="small muted">${next.length ? esc(t("next_shows", { list: next.slice(0, 4).map(fmtHour).join(", ") })) : t("showtimes_none")}</div></div>
      </div>`;
    }
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

  // ordre : parc -> spectacles -> rencontres -> filtres et attractions
  return `
    <section class="card">
      <div class="row gap between"><h2>📡 ${t("live_title")}</h2>
        <button class="pill ghost" data-action="refresh">↻ ${t("live_refresh")}</button></div>
      <label class="field"><span>${t("live_park")}</span>${parkSelect}</label>
      <p class="small muted" style="margin:0">${state.latest?.updated ? esc(t("data_updated", { ago: ago(state.latest.updated) })) + " · " + t("live_auto") : t("live_nodata")}</p>
      ${stale ? `<p class="small notice">⚠️ ${esc(t("live_stale", { ago: ago(state.latest.updated) }))}</p>` : ""}
      ${P.parkClosed(park, now.date) ? `<p class="small notice">🌋 ${t("vb_closed_now")}</p>` : ""}
    </section>
    <div id="soon-sections">${showsSoonHtml(park)}</div>
    <section class="card">
      ${catChips("live")}
      ${state.liveCats.length ? "" : `<p class="small muted" style="margin:6px 0 0">${t("live_hidden_cats")}</p>`}
    </section>
    <h3 class="section-title">${t("live_open", { n: open.length })}</h3>
    ${open.length ? `<div class="live-list">${open.map(row).join("")}</div>`
      : `<section class="card center muted">🌙 ${t(Object.keys(waits).length ? "live_none_open" : "live_nodata")}</section>`}
    ${shows.length ? `<h3 class="section-title">🎭 ${t("cat_show")} · ${shows.length}</h3><div class="live-list">${shows.map(row).join("")}</div>` : ""}
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
    case "pass-mode": {
      s.passes[el.dataset.pass] = { mode: el.dataset.mode, dates: [] };
      saveSettings(); render(); break;
    }
    case "pass-day": {
      const k = el.dataset.pass, d = el.dataset.date;
      const all = P.dateRange(s.start, s.end);
      const cur = all.filter((x) => passOn(k, x));
      const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
      s.passes[k] = next.length === all.length ? { mode: "all", dates: [] } : next.length ? { mode: "some", dates: next } : { mode: "none", dates: [] };
      saveSettings(); render();
      $(`[data-action=pass-day][data-pass="${k}"][data-date="${d}"]`)?.focus();
      break;
    }
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
      if (d > 0 && (P.totalVisits(s.visits) + P.restDays(s) >= P.tripDays(s) || P.restDays(s) >= P.restLimit(s))) break;
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
      if (el.dataset.scope === "plus") { refreshPlus(); $(`#plus-sheet [data-cat="${c}"]`)?.focus(); break; }
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
    case "plus-open": openPlus(); break;
    case "plus-close": $("#plus-sheet").close(); break;
    case "plus-pick": pickPlus(el.dataset.key); break;
    case "plus-back": state.plusPick = null; refreshPlus(); break;
    case "plus-show": {
      const sh = showtimesFor(state.plusPick.name, state.dayState.park, state.dayState.date)[+el.dataset.i];
      if (sh) recordShow(sh);
      break;
    }
    case "plus-show-now": recordShow(null); break;
    case "entry-edit": state.editEntry = el.dataset.uid ? +el.dataset.uid : null; render(); $("#entry-time")?.focus(); break;
    case "entry-save": {
      const date = state.dayState.date;
      const at = P.hmToMin($("#entry-time")?.value);
      if (at == null) break;
      setEntries(date, getEntries(date).map((e) => (e.uid === +el.dataset.uid
        ? { ...e, at, ...(e.kind === "show" ? {} : { exit: at + e.wait + e.dur }) } : e)));
      state.editEntry = null; render(); break;
    }
    case "entry-del": {
      const date = state.dayState.date;
      setEntries(date, getEntries(date).filter((e) => e.uid !== +el.dataset.uid));
      if ($("#plus-sheet").open) $("#plus-sheet").close();
      render(); break;
    }
    case "day-end-reset": store.del(`dayEnd.${el.dataset.date}`); state.dayMsg = ""; render(); break;
    case "overflow-open": maybeOpenOverflow(true); break;
    case "overflow-later": {
      const ds = state.dayState;
      store.set(`overflowSeen.${ds.date}`, `${ds.date}|${[...ds.cd.dropped].sort().join(",")}`);
      $("#overflow-dialog").close(); break;
    }
    case "defer": deferActivity(el.dataset.id); break;
    case "finish-later": finishLater(); break;
    case "undefer":
      store.set("deferred", getDeferred().filter((d) => !(d.id === el.dataset.id && d.from === el.dataset.from)));
      render(); break;
    case "open-notes": notesStatus(); $("#notes-dialog").showModal(); break;
    case "open-day": state.dayDate = el.dataset.date; go("day"); break;
    case "pick-day": state.dayDate = el.dataset.date; state.dayMsg = ""; state.editEntry = null; render(); break;
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
  if (el.id === "day-end") {
    const m = P.hmToMin(el.value);
    if (m == null) return;
    const close = state.dayState?.cd.plan.close ?? 1440;
    if (m >= close % 1440 && close < 1440) store.del(`dayEnd.${el.dataset.date}`);
    else store.set(`dayEnd.${el.dataset.date}`, m < 300 ? m + 1440 : m);
    state.dayMsg = ""; render(); return;
  }
  if (el.dataset.set) {
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.dataset.set === "lunch.at") v = +v;
    setPath(s, el.dataset.set, v);
    if (el.dataset.set === "start" && s.end < s.start) s.end = s.start;
    // les contraintes hors des dates du séjour sont retirées
    if (el.dataset.set === "start" || el.dataset.set === "end") {
      s.dayTypes = Object.fromEntries(Object.entries(s.dayTypes || {}).filter(([d]) => d >= s.start && d <= s.end));
      for (const k of ["multi", "single", "express"]) {
        const v = s.passes[k];
        if (v.mode === "some") { v.dates = v.dates.filter((d) => d >= s.start && d <= s.end); if (!v.dates.length) v.mode = "none"; }
      }
      // dates raccourcies : on réduit les visites si besoin et on le signale
      state.visitMsg = "";
      if (stepValid("dates")) applyVisitLimits();
    }
    saveSettings(); render(); return;
  }
  if (el.dataset.daytype) {
    const d = el.dataset.daytype, v = el.value;
    const types = { ...(s.dayTypes || {}) };
    if (v === "auto") delete types[d]; else types[d] = v;
    s.dayTypes = types;
    // un parc précis compte dans ses visites : on en ajoute une si besoin (normalizeVisits ajuste le reste)
    if (P.PARK_BY_ID[v]) {
      const need = P.parkDayCounts(s).specific[v] || 0;
      if ((s.visits?.[v] || 0) < need) s.visits = { ...s.visits, [v]: need };
    }
    state.visitMsg = ""; applyVisitLimits();
    saveSettings(); render();
    $(`[data-daytype="${d}"]`)?.focus();
    return;
  }
  if (el.dataset.must) {
    s.mustDo = el.checked ? [...new Set([...s.mustDo, el.dataset.must])] : s.mustDo.filter((id) => id !== el.dataset.must);
    saveSettings();
    $("#must-count").textContent = t("must_count", { n: s.mustDo.length });
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "plus-search") {
    state.plusSearch = e.target.value;
    const pos = e.target.selectionStart;
    refreshPlus();
    const input = $("#plus-search");
    input.focus(); input.setSelectionRange(pos, pos);
    return;
  }
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

// panneau « + » fermé : la fenêtre « plus assez de temps » peut s'ouvrir si besoin
$("#plus-sheet").addEventListener("close", () => maybeOpenOverflow());

// section spectacles de Direct : état ouvert / fermé mémorisé
document.addEventListener("toggle", (e) => {
  if (e.target.id === "shows-soon") store.set("showsOpen", e.target.open);
  if (e.target.id === "meets-soon") store.set("meetsOpen", e.target.open);
}, true);

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

/**
 * Fiches saisies avant que queue-times ne publie leurs identifiants (ex. Volcano Bay, clés « vb-… ») :
 * reliées à l'identifiant de rides.json qui porte le même nom dans le même parc.
 */
function linkMetaToCatalog() {
  const byName = {};
  for (const [id, r] of Object.entries(state.catalog)) byName[`${r.park}|${P.normName(r.name)}`] = id;
  const renamed = {};
  for (const [key, m] of Object.entries(state.meta)) {
    if (state.catalog[key]) continue;
    const id = byName[`${m.park}|${P.normName(m.name)}`];
    if (id && !state.meta[id]) { state.meta[id] = m; delete state.meta[key]; renamed[key] = id; }
  }
  if (Object.keys(renamed).length) {
    const s = state.settings;
    s.mustDo = s.mustDo.map((id) => renamed[id] || id);
    saveSettings();
    model = null; // le modèle d'attente doit relire les fiches
  }
}

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
    linkMetaToCatalog();
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
    const box = $("#soon-sections");
    if (box && state.tab === "live") box.innerHTML = showsSoonHtml(state.livePark);
  }, 30000);
  setInterval(() => { if (state.tab === "live" && document.visibilityState === "visible") refreshLatest(); }, 5 * 60000);
}

init();
