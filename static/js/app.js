// Scanner HL terminal: a hash router and one render function per page.
// Data text always goes into the DOM through textContent (node()), never innerHTML.
// Charts reuse edgeterm's chart module, served from the edgeterm package under /et/.

import { lineChart } from "../../et/js/chart.js";
import { candleChart } from "./candles.js";

const view = document.getElementById("view");
let charts = [];
let filterText = "";

// ---------- formatting (French) ----------
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const fr = (x, d = 2, signed = false) => {
  if (!isNum(x)) return "—";
  const s = x.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (signed && x > 0 ? "+" : "") + s.replace("-", "−");
};
const pct = (x, d = 0, signed = false) => (isNum(x) ? fr(100 * x, d, signed) + " %" : "—");
const usd = (x, d = 2, signed = true) => (isNum(x) ? fr(x, d, signed) + " $" : "—");
const price = (x) => (!isNum(x) ? "—" : x >= 100 ? fr(x, 2) : x >= 1 ? fr(x, 4) : fr(x, 5));
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function when(t, withTime = true) {
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d)) return "—";
  const p = (n) => String(n).padStart(2, "0");
  const day = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
  return withTime ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const tone = (x) => (!isNum(x) || x === 0 ? "neutral" : x > 0 ? "good" : "bad");
const sym = (coin) => (coin || "").split(":").pop();

// strategy keys -> display names (the keys are internal)
const STRAT = {
  rsi4h: "RSI 4H long",
  bb160_4h: "BB 160 · 4H crypto (2σ + filtres)",
  "reconciled:bb160_4h": "BB 160 · 4H · 3σ (crypto, actions)",
};
const MAIN_TXT = "RSI 4H long et BB 160 · 4H crypto";
const VARIANT = { bbmid: "stop + objectif Bollinger", bbstop: "stop Bollinger, sortie −1σ", nostop: "sans stop", stop: "stop 2,5 × ATR",
  time3d: "limite 3 jours", cap: "plafond 5 positions", farstop: "stop catastrophe −3σ", maker: "sorties limite", combo: "plafond + stop cata. + limite" };
const VARIANTS_FOR = {
  rsi4h: ["nostop", "combo", "cap", "farstop", "maker", "stop", "time3d"],
  bb160_4h: ["nostop", "combo", "cap", "farstop", "maker", "bbmid", "bbstop", "stop", "time3d"],
  "reconciled:bb160_4h": ["nostop", "bbmid", "bbstop", "stop", "time3d"],
};
const REASON = { target: "sortie −1σ", rsi: "RSI ≥ 50", horizon: "horizon 5 j", time3d: "limite 3 j", stop: "stop", tp: "objectif atteint", open: "ouvert" };
const reasonFr = (r) => REASON[r] || r || "—";

// ---------- DOM helper ----------
function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v; // CSSOM: allowed by the page's CSP, unlike a style attribute
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const term = (word, tip) => node("span", { class: "term", tabindex: "0", "data-tip": tip }, word);
const signed = (x, fmt = (v) => fr(v, 2, true)) => node("span", { class: tone(x) }, fmt(x));

function table(headers, rows, { numeric = [], rowClass } = {}) {
  const t = node("table", { class: "data dense" });
  t.append(node("thead", {}, node("tr", {}, headers.map((h, i) => node("th", { class: numeric.includes(i) ? "num" : "" }, h)))));
  const tb = node("tbody");
  rows.forEach((r, k) => tb.append(node("tr", { class: rowClass ? rowClass(k) : "" },
    r.map((c, i) => node("td", { class: numeric.includes(i) ? "num" : "" }, c)))));
  t.append(tb);
  return node("div", { class: "table-wrap" }, t);
}
const tile = (label, value, sub, cls = "") => node("div", { class: "tile" }, node("div", { class: "label" }, label),
  node("div", { class: `value ${cls}` }, value), sub ? node("div", { class: "sub" }, sub) : null);
const sectionHead = (title, sub) => node("div", { class: "section-head" }, node("h2", {}, title), sub ? node("span", { class: "sub" }, sub) : null);
const checksList = (bv) => {
  const ul = node("ul", { class: "checks" });
  for (const p of bv.passed || []) ul.append(node("li", { class: "pass" }, p));
  for (const f of bv.failed || []) ul.append(node("li", {}, f));
  return ul;
};

// Online version (GitHub Pages): no server, the VPS exports each API answer as a JSON file
// (hlscan/site.py writes them under the same names) and republishes every 15 minutes.
const STATIC = document.documentElement.dataset.static === "1";
function apiUrl(url) {
  if (!STATIC) return url;
  const name = url.replace(/^\/api\//, "").replace(/[^A-Za-z0-9._-]/g, "_");
  return `data/${name}.json?v=${Math.floor(Date.now() / 60000)}`;
}
async function get(url) {
  const r = await fetch(apiUrl(url));
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
function clearCharts() { charts.forEach((c) => c.destroy && c.destroy()); charts = []; }

// ---------- bias squares ----------
const STATE_FR = { up: "▲ confirmé", down: "▼ confirmé", up_nascent: "▲ naissant", down_nascent: "▼ naissant",
  up_pullback: "repli dans ▲", down_pullback: "rebond dans ▼", neutral: "neutre" };
function mtf(states) {
  if (!states) return "";
  const box = node("span", { class: "mtf" });
  for (const tf of ["1d", "4h", "1h"]) {
    const s = states[tf] || {};
    const tip = `${tf.toUpperCase()} : dernière clôture ${STATE_FR[s.last] || "—"} · bougie en cours ${STATE_FR[s.live] || "—"}`;
    box.append(node("span", { class: "tf", title: tip }, tf.toUpperCase(),
      node("i", { class: `sq big ${s.last || "none"}` }), node("i", { class: `sq small ${s.live || "none"}` })));
  }
  return box;
}

// ---------- status line + UTC clock ----------
async function renderStatus(snapWrap) {
  const s = document.getElementById("status");
  const chips = [];
  const snap = snapWrap?.snapshot;
  if (snap) {
    chips.push(node("span", { class: "chip good" }, node("span", { class: "dot" }), `CLÔTURE 4H ${when(snap.last_close)}`));
    if (snap.live_at) chips.push(node("span", { class: "chip good" }, node("span", { class: "dot blink" }), `PRIX LIVE ${when(snap.live_at).slice(-5)}`));
    if (STATIC) {
      chips.push(node("span", { class: "chip" }, node("span", { class: "dot" }), `EN LIGNE · INSTANTANÉ ${when(snapWrap.exported_at).slice(-5)} · MAJ /15 MIN`));
    } else {
      const mins = Math.round((snapWrap.next_refresh_s || 0) / 60);
      chips.push(node("span", { class: "chip" }, node("span", { class: "dot" }), `RECALCUL ~${mins} MIN`));
    }
  }
  if (snapWrap?.refreshing) chips.push(node("span", { class: "chip" }, node("span", { class: "dot blink" }), "RAFRAÎCHISSEMENT"));
  if (snapWrap?.error) chips.push(node("span", { class: "chip bad" }, node("span", { class: "dot" }), "ERREUR"));
  s.replaceChildren(...chips);
}
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  document.getElementById("clock").textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}
tickClock();
setInterval(tickClock, 1000);

// ---------- instrument chart (edgeterm's chart module) ----------
const chartBox = node("div");
async function openChart(coin, interval) {
  clearCharts();
  chartBox.replaceChildren(node("p", { class: "loading" }, `CHARGEMENT ${sym(coin)} ${interval.toUpperCase()}…`));
  let d;
  try { d = await get(`/api/chart/${encodeURIComponent(coin)}?interval=${interval}`); }
  catch { chartBox.replaceChildren(node("p", { class: "muted" }, `Graphique ${sym(coin)} ${interval.toUpperCase()} non disponible.`)); return; }
  if (d.error) { chartBox.replaceChildren(node("p", { class: "muted" }, d.error)); return; }
  const holder = node("div");
  const close = node("button", { class: "btn", type: "button" }, "Fermer");
  close.addEventListener("click", () => { clearCharts(); chartBox.replaceChildren(); });
  chartBox.replaceChildren(node("section", { class: "card chart-card" },
    node("div", { class: "section-head", style: "margin:0 0 6px;justify-content:space-between" },
      node("h3", {}, `${sym(coin)} · ${interval.toUpperCase()} · 400 dernières bougies`), close),
    node("p", { class: "note" }, "Clôture, bande médiane SMA160 (objectif), ligne −1σ, bande d'entrée 3σ et bande 2σ."), holder));
  const S = (label, color, v) => ({ label, color, t: d.t, v });
  charts.push(lineChart(holder, { series: [S("clôture", "--neutral-line", d.close), S("médiane SMA160", "--series-4", d.mid),
    S("ligne −1σ", "--series-3", d.target), S("entrée 3σ", "--series-1", d.band3), S("bande 2σ", "--series-2", d.band2)],
    yFmt: (x) => price(x), yTick: (v) => fr(v, Math.abs(v) >= 100 ? 0 : 2), height: 320, endLabels: false,
    xDomain: [d.t[0], d.t[d.t.length - 1]], ariaLabel: `${coin} bandes de Bollinger` }));
}
const coinLink = (coin, interval) => {
  const b = node("button", { class: "link", type: "button", title: "Voir le graphique",
    style: "color:var(--amber);font-weight:700;font-size:12.5px" }, sym(coin));
  b.addEventListener("click", () => { openChart(coin, interval); window.scrollTo({ top: 0, behavior: "smooth" }); });
  return b;
};

// ---------- page: scanner ----------
const matches = (coin) => !filterText || sym(coin).toLowerCase().includes(filterText) || (coin || "").toLowerCase().includes(filterText);

async function pageScanner() {
  const w = await get("/api/scanner");
  renderStatus(w);
  const snap = w.snapshot;
  if (!snap) {
    view.replaceChildren(node("div", { class: "card" }, node("h1", {}, "Pas encore de données"),
      node("p", {}, "Le premier rafraîchissement télécharge les bougies. Rechargez dans une minute, ou lancez :"),
      node("code", {}, "hlscan scan")));
    return;
  }
  const u = snap.universe;
  const open = (snap.qualified || []).filter((q) => q.status === "open" && q.main);
  const head = node("div", {},
    node("h1", {}, "Scanner"),
    node("p", { class: "lede" }, `${u.total} instruments surveillés (actions ${u.stocks} · indices ${u.indices} · crypto ${u.crypto}) · `
      + `positions ouvertes, stratégies principales : crypto ${open.filter((q) => q.kind === "crypto").length} · actions et indices ${open.filter((q) => q.kind !== "crypto").length}`),
    node("p", { class: "legend-line" },
      "Biais MTF par unité de temps 1D · 4H · 1H (EMA20 / EMA50) : grand carré = dernière clôture, petit = bougie en cours ; "
      + "plein = confirmé, pâle = naissant, contour = repli / rebond, gris = neutre. Familles risk-on / risk-off au-delà de ±30 %."));
  const search = node("input", { type: "search", placeholder: "FILTRE  (ex. META)", "aria-label": "Filtrer par instrument", value: filterText });
  const refreshBtn = node("button", { class: "btn", type: "button" }, "Rafraîchir");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true; refreshBtn.textContent = "Rafraîchissement… (1–3 min)";
    try { await get("/api/scanner?refresh=1"); } finally { route(); }
  });
  const filters = node("div", { class: "filters" }, search, STATIC ? null : refreshBtn,
    node("span", { class: "muted small" }, STATIC ? `Version en ligne : instantané du serveur publié toutes les 15 minutes (dernier : ${when(w.exported_at)} UTC) · signaux et journal recalculés après chaque clôture 1H (dernier : ${when(snap.generated)} UTC)` : `Prix et positions ouvertes chaque minute${snap.live_at ? ` (${when(snap.live_at)} UTC)` : ""} · signaux et journal recalculés après chaque clôture 1H (dernier : ${when(snap.generated)} UTC)`));
  const body = node("div");
  const draw = () => body.replaceChildren(sectionImminent(snap), sectionQualified(snap), sectionJournal(snap));
  search.addEventListener("input", () => { filterText = search.value.trim().toLowerCase(); draw(); });
  draw();
  chartBox.replaceChildren();
  view.replaceChildren(head, filters, chartBox, body);
}

function sectionImminent(snap) {
  const rows = (snap.imminent || []).filter((r) => matches(r.coin));
  const out = node("section");
  out.append(sectionHead("1 · Entrées imminentes", "instruments qui approchent d'un déclencheur, triés par probabilité"));
  const tr = rows.map((r) => [
    node("span", {}, coinLink(r.coin, r.interval), " ", mtf(r.mtf)),
    STRAT[r.strategy] || r.strategy,
    node("span", { class: "mono" }, r.distance_txt,
      isNum(r.live_distance) ? node("span", { class: "muted" }, ` · maintenant ${fr(r.live_distance, 2)} σ`) : ""),
    node("span", {}, node("span", { class: "probbar" }, node("i", { style: `width:${Math.round(100 * (r.prob || 0))}%` })),
      isNum(r.prob) ? pct(r.prob) : "—"),
    signed(r.usd_per_trade, (v) => usd(v)),
    r.speed_txt,
    node("span", { class: "tagrow" }, (r.tags || []).map((t) => node("span", { class: `tagc ${t === "séance fermée" || t === "purge de levier" ? "warn" : ""}` }, t))),
    `${fr(r.since_hours, 0)} h`,
  ]);
  out.append(rows.length ? table(["Instrument", "Stratégie", "Distance",
    term("Proba 24 h", "Fréquence historique, sur toutes les barres passées regroupées par distance et vitesse, à laquelle le déclencheur a été atteint dans les 24 h. Tables reconstruites chaque jour."),
    term("Gain moyen/trade", "Gain moyen par trade de 1 000 $ dans le backtest (Hyperliquid, coûts et funding inclus, positions ouvertes au prix du marché), avec la règle de sortie affichée."),
    "Vitesse", "Contexte", "Depuis"], tr, { numeric: [3, 4, 7] })
    : node("p", { class: "muted" }, "Aucun instrument dans la zone pour le moment."));
  const b = snap.blocked?.counts || {};
  const parts = Object.entries(b).map(([k, v]) => `${k} ${v}`);
  const tables = Object.entries(snap.prob_table || {}).map(([k, v]) => `${STRAT[k] || k} : ${v.instruments} instruments`).join(" · ");
  out.append(node("p", { class: "note" }, `Bloqués (zone atteinte, filtre non rempli) : ${parts.length ? parts.join(" · ") : "aucun"}. `,
    `${snap.armed || 0} ordres limites BB 160 armés. Tables de probabilité : ${tables} (construites le ${when(snap.prob_built, false)}).`));
  return out;
}

function qualifiedTable(rows) {
  const tr = rows.map((r) => {
    const openNow = r.status === "open";
    const status = openNow ? (r.pending ? "ouvert · sortie en cours" : "ouvert") : `clôturé · ${reasonFr(r.reason)}`;
    return [
      when(r.signal_time), coinLink(r.coin, "4h"), "LONG", STRAT[r.strategy] || r.strategy,
      price(r.entry), isNum(r.stop) ? price(r.stop) : "–", price(r.target), when(r.horizon_end), price(openNow ? r.price : r.exit),
      signed(openNow ? r.latent_r : r.r_net), r.validation || "—", status,
      r.distribution ? node("span", { class: r.distribution.startsWith("hors") ? "bad" : "" }, r.distribution) : "—",
      r.mode === "replay" ? node("span", { class: "muted", title: "Trouvé en rejouant l'historique : le journal n'existait pas encore à ce moment-là." }, "rejoué") : "live",
    ];
  });
  return table(["Signal (UTC)", "Instrument", "Sens", "Stratégie", "Entrée", "Stop", "Objectif", "Fin d'horizon", "Prix",
    term("R", "Ouvert : (prix − entrée) / ATR14 de la bougie d'entrée. Clôturé : résultat net de frais et funding, dans la même unité."),
    term("Backtest", "Échantillon de recherche du backtest Hyperliquid pour cette règle : part de trades gagnants, R moyen par trade, nombre de trades."),
    "Statut",
    term("Distribution", "« dans la distribution » : l'excursion actuelle (en ATR) à cet âge est entre les 10e et 90e centiles des trades passés de la même règle encore ouverts au même âge.")],
    tr, { numeric: [4, 5, 6, 8, 9], rowClass: (k) => (rows[k].status === "open" ? "row-open" : "") });
}

function exitText(v) {
  return v === "bbmid" ? "stop Bollinger (une bande sous l'entrée, figée) et objectif à la bande médiane SMA160, horizon 5 jours"
    : v === "bbstop" ? "stop Bollinger (une bande sous l'entrée, figée), sortie à −1σ ou à l'horizon" : "sans stop, sortie à −1σ ou à l'horizon de 5 jours";
}

function sectionQualified(snap) {
  const all = (snap.qualified || []).filter((r) => matches(r.coin));
  const main = all.filter((r) => r.main), others = all.filter((r) => !r.main);
  const out = node("section");
  out.append(sectionHead("2 · Signaux qualifiés",
    `stratégies principales : ${MAIN_TXT} · RSI : achat quand le RSI 4H ≤ 27, sortie à RSI ≥ 50 · BB : achat au contact de la bande 2σ, ${exitText(snap.journal?.main_variant)} · positions ouvertes et sorties des dernières 24 h`));
  out.append(main.length ? qualifiedTable(main) : node("p", { class: "muted" }, "Aucun signal ouvert."));
  if (others.length) {
    out.append(node("h3", { style: "margin-top:14px" }, "Aussi surveillée : BB 160 · 4H · 3σ (crypto, actions)"));
    out.append(qualifiedTable(others));
  }
  return out;
}

function sectionJournal(snap) {
  const j = snap.journal || {};
  const s = j.main_rule || {};
  const out = node("section");
  out.append(sectionHead("3 · Journal papier", `${MAIN_TXT} · ${VARIANT[j.main_variant] || "sans stop"} · depuis le ${when(snap.replay_from, false)} · 1 000 $ par trade · coûts réels et funding horaire inclus`));
  if (!s.signals) { out.append(node("p", { class: "muted" }, "Journal vide.")); return out; }
  const c = s.closed_only || {}, m = s.with_open_mtm || {};
  out.append(node("div", { class: "tiles" },
    tile("Signaux", String(s.signals), `${s.open} ouverts · ${s.closed} clôturés`),
    tile("Trades clôturés", pct(c.win_rate), `gagnants · ${fr(c.avg_r, 2, true)} R moyen · ${usd(c.pnl_usd)}`, tone(c.avg_r)),
    tile("Ouverts compris (au marché)", pct(m.win_rate), `gagnants · ${fr(m.avg_r, 2, true)} R moyen · ${usd(m.pnl_usd)}`, tone(m.avg_r)),
    tile("Pire trade", `${fr(m.worst_r, 2, true)} R`, "ouverts compris, frais de sortie inclus", tone(m.worst_r))));
  const notes = [];
  if (s.replayed) notes.push(`${s.replayed} trades « rejoués » : trouvés en rejouant l'historique depuis le ${when(snap.replay_from, false)}, pas vus en direct.`);
  for (const [k, o] of Object.entries({ ...(j.main_by_strategy || {}), ...(j.others || {}) })) {
    if (!o.signals) continue;
    notes.push(`${STRAT[k] || k} : ${o.signals} signaux · ${o.open} ouverts · clôturés ${pct(o.closed_only?.win_rate)} gagnants / ${fr(o.closed_only?.avg_r, 2, true)} R · ouverts compris ${pct(o.with_open_mtm?.win_rate)} / ${fr(o.with_open_mtm?.avg_r, 2, true)} R · ${usd(o.with_open_mtm?.pnl_usd)}`);
  }
  if (notes.length) out.append(node("ul", { class: "note" }, notes.map((t) => node("li", {}, t))));
  const rows = (j.trades || []).filter((r) => matches(r.coin)).map((r) => [
    coinLink(r.coin, "4h"), STRAT[r.strategy] || r.strategy, when(r.entry_time), price(r.entry),
    r.status === "closed" ? when(r.exit_time) : "ouvert", price(r.status === "closed" ? r.exit : r.price),
    reasonFr(r.reason), pct(r.max_dd_pct, 2), signed(r.r_net), signed(r.pnl_usd, (v) => usd(v)), usd(r.funding_usd, 3),
    r.mode === "replay" ? "rejoué" : "live"]);
  out.append(table(["Instrument", "Stratégie", "Entrée (UTC)", "Prix", "Sortie", "Prix", "Raison", "DD max", "R net", "P&L", "dont funding", "Mode"],
    rows, { numeric: [3, 5, 7, 8, 9, 10] }));
  return out;
}

// ---------- page: journal ----------
async function pageJournal() {
  const keys = ["rsi4h", "bb160_4h", "reconciled:bb160_4h"].map((k) => [k, STRAT[k]]);
  const st = { strategy: keys[0][0], variant: "nostop" };
  const seg = (items, keyName) => {
    const box = node("div", { class: "seg", role: "group" });
    for (const [k, label] of items) {
      const b = node("button", { type: "button", "aria-pressed": String(st[keyName] === k) }, label);
      b.addEventListener("click", () => { st[keyName] = k; draw(); });
      box.append(b);
    }
    return box;
  };
  const body = node("div");
  async function draw() {
    const variants = (VARIANTS_FOR[st.strategy] || ["nostop"]).map((v) => [v, VARIANT[v] || v]);
    if (!variants.some(([k]) => k === st.variant)) st.variant = variants[0][0];
    const d = await get(`/api/journal?strategy=${encodeURIComponent(st.strategy)}&variant=${st.variant}`);
    const s = d.summary || {};
    const c = s.closed_only || {}, m = s.with_open_mtm || {};
    const rows = (d.trades || []).map((r) => [coinLink(r.coin, "4h"), when(r.signal_time), price(r.entry),
      isNum(r.stop) ? price(r.stop) : "–", price(r.target), r.status === "open" ? "ouvert" : `clôturé · ${reasonFr(r.reason)}`,
      price(r.status === "open" ? r.price : r.exit), signed(r.status === "open" ? r.latent_r : r.r_net), signed(r.pnl_usd, (v) => usd(v)),
      usd(r.fee_usd), usd(r.funding_usd, 3), pct(r.max_dd_pct, 2), r.distribution || "—", r.mode === "replay" ? "rejoué" : "live"]);
    body.replaceChildren(
      node("div", { class: "controls" }, seg(keys, "strategy"), seg(variants, "variant")),
      node("div", { class: "tiles" },
        tile("Signaux", String(s.signals || 0), `${s.open || 0} ouverts · ${s.closed || 0} clôturés`),
        tile("Gagnants, clôturés", pct(c.win_rate), `${fr(c.avg_r, 2, true)} R moyen · ${usd(c.pnl_usd)}`),
        tile("Gagnants, ouverts compris", pct(m.win_rate), `${fr(m.avg_r, 2, true)} R moyen · ${usd(m.pnl_usd)}`, tone(m.avg_r)),
        tile("Pire trade", `${fr(m.worst_r, 2, true)} R`, "au prix du marché, frais de sortie inclus", tone(m.worst_r))),
      table(["Instrument", "Signal (UTC)", "Entrée", "Stop", "Objectif", "Statut", "Prix", "R", "P&L", "Frais", "Funding", "DD max", "Distribution", "Mode"],
        rows, { numeric: [2, 3, 4, 6, 7, 8, 9, 10, 11] }),
      node("h2", { style: "margin-top:22px" }, "Derniers événements"),
      table(["Heure (UTC)", "Stratégie", "Règle de sortie", "Instrument", "Type", "Niveau", "Mode"],
        (d.signals || []).slice(0, 60).map((x) => [when(x.time), STRAT[x.strategy] || x.strategy, VARIANT[x.variant] || x.variant, sym(x.coin), x.kind, price(x.level), x.mode]),
        { numeric: [5] }));
  }
  view.replaceChildren(node("h1", {}, "Journal papier"),
    node("p", { class: "lede" }, "Chaque signal, remplissage, sortie et marque des positions ouvertes, enregistrés dans SQLite. Chaque stratégie tourne avec toutes ses règles de sortie et de risque pour comparer : plafond = au plus 5 positions ouvertes et 2 par famille ; stop catastrophe = 3σ sous l'entrée ; sorties limite = vente par ordre limite (frais maker)."), body);
  await draw();
}

// ---------- page: backtest ----------
const SEG_FR = { research: "recherche (75 %)", holdout: "holdout (25 % final)", all: "tout" };
async function pageBacktest() {
  const rep = await get("/api/backtest");
  if (!rep) { view.replaceChildren(node("div", { class: "card" }, node("h1", {}, "Pas encore de rapport"), node("code", {}, "hlscan backtest"))); return; }
  const parts = [node("h1", {}, "Backtest"),
    node("p", { class: "lede" }, `Chaque stratégie recalculée avec coûts réels (frais, écart, profondeur du carnet), funding horaire, positions ouvertes comptées, un holdout (25 % final) jamais regardé, le hasard comme référence, et ${rep.n_trials} essais déclarés pour le Deflated Sharpe Ratio. 1 000 $ par trade ; après impôt = flat tax 31,4 % (gains et pertes compensés par année). Rapport du ${when(rep.generated)} UTC.`)];
  parts.push(overviewTable(rep));
  for (const [key, s] of Object.entries(rep.strategies)) parts.push(strategyCard(key, s));
  const ov = rep.overfitting || {};
  const pboRows = Object.entries(ov).filter(([, o]) => o && isNum(o.pbo)).map(([src, o]) => [src, String(Object.keys(o.configs || {}).length), fr(o.pbo, 2), o.winner, fr(o.winner_dsr, 3)]);
  if (pboRows.length) parts.push(sectionHead("Sur-ajustement (backtest-autopsy)"),
    node("p", { class: "section-intro" }, "PBO (CSCV) : probabilité que la meilleure configuration choisie sur une moitié de l'historique soit sous la médiane sur l'autre moitié. 0,5 = hasard ; sur du bruit l'écart-type est d'environ 0,2."),
    table(["Source", "Configurations", "PBO", "Meilleure", "DSR de la meilleure"], pboRows, { numeric: [1, 2, 4] }));
  view.replaceChildren(...parts);
}

const SOURCE_SHORT = { hyperliquid: "Hyperliquid", binance: "Binance, 28 alts", binance_wide: "Binance, toutes cryptos",
  majors_long: "BTC ETH LTC XRP", yahoo: "Yahoo (actions)" };

function overviewTable(rep) {
  const rows = [];
  for (const s of Object.values(rep.strategies)) {
    for (const [src, b] of Object.entries(s.sources || {})) {
      const m = b.variants?.nostop?.stress?.["1"] || {};
      const all = m.all?.mtm || {}, hold = m.holdout?.mtm || {};
      if (!all.n) continue;
      const rnd = b.baselines?.random?.dip || {};
      const neg = Object.entries(b.by_year?.nostop || {}).filter(([, y]) => isNum(y.expectancy_r) && y.expectancy_r < 0).map(([y]) => y);
      rows.push([s.label, SOURCE_SHORT[src] || src, `${b.start.slice(0, 4)} → ${b.end.slice(0, 4)}`, String(b.instruments), String(all.n),
        pct(all.win_rate), signed(all.expectancy_r), `[${fr(all.expectancy_ci?.[0], 2, true)} ; ${fr(all.expectancy_ci?.[1], 2, true)}]`,
        signed(hold.expectancy_r), fr(rnd.p_value, 3), fr(b.portfolio?.summary?.sharpe, 2), fr(b.dsr_default, 2), neg.join(" ") || "—"]);
    }
  }
  if (!rows.length) return node("div");
  return node("section", { class: "card", style: "margin-top:14px" }, node("h2", { style: "margin-top:0" }, "Vue d'ensemble (sans stop, coûts 1×)"),
    node("p", { class: "section-intro" }, "Une ligne par stratégie et par source de données. Hyperliquid ne garde que 5 000 bougies (4H crypto depuis juillet 2024, actions depuis novembre 2025) ; les historiques longs testent les mêmes règles sur d'autres données : spot Binance depuis 2017, BTC depuis 2011 (Bitstamp), ETH, LTC, XRP (Bitfinex), actions sur Yahoo (2 ans maximum en 1H)."),
    table(["Stratégie", "Source", "Période", "Instr.", "Trades", "Gagnants", "R net", "IC 90 %", "R holdout", term("p hasard", "Probabilité que des achats de creux au hasard, avec les mêmes sorties, fassent aussi bien (en $). Sous 0,10 : mieux que le hasard."),
      term("Sharpe", "Sharpe annuel du carnet entier, P&L marqué chaque jour."), term("DSR", "Deflated Sharpe Ratio : il faut > 0,95 pour écarter la chance compte tenu de tous les essais."), "Années négatives"],
      rows, { numeric: [3, 4, 5, 6, 8, 9, 10, 11] }));
}

function strategyCard(key, s) {
  const v = s.verdict || {};
  const card = node("section", { class: `card verdict ${v.ok ? "ok" : ""}`, style: "margin-top:14px" });
  card.append(node("h2", { style: "margin-top:0" }, s.label));
  card.append(node("p", { class: "lede", style: "margin-bottom:6px" }, `Sans stop : ${v.text || ""}`));
  for (const [src, bv] of Object.entries(v.by_source || {})) {
    card.append(node("p", { class: "small muted", style: "margin:8px 0 0" }, `Tests sur ${s.sources?.[src]?.label || src} :`), checksList(bv));
  }
  for (const vs of [s.verdict_shown, s.verdict_combo].filter(Boolean)) {
    card.append(node("h3", { style: "margin-top:14px" }, `Avec ${vs.variant_label}`), node("p", {}, vs.text));
    for (const [src, bv] of Object.entries(vs.by_source || {})) {
      card.append(node("p", { class: "small muted", style: "margin:8px 0 0" }, `Tests sur ${s.sources?.[src]?.label || src} :`), checksList(bv));
    }
  }
  for (const [src, b] of Object.entries(s.sources || {})) {
    card.append(node("h3", { style: "margin-top:18px" }, `${b.label} · ${b.instruments} instruments · ${b.start} → ${b.end}`));
    card.append(node("p", { class: "note" }, `Holdout à partir de ~${b.holdout_from_median} (25 % final de chaque historique). Funding : ${b.funding}${isNum(b.funding_coverage) ? ` (heures avec un taux réel : ${pct(b.funding_coverage)} en moyenne)` : ""}.`));
    const n1 = b.variants?.nostop?.stress?.["1"] || {};
    const all = n1.all?.mtm || {};
    card.append(node("div", { class: "tiles" },
      tile("Gagnants (sans stop, ouverts compris)", pct(all.win_rate), `seuil de rentabilité ${pct(all.break_even_win_rate)}`),
      tile("R net par trade", fr(all.expectancy_r, 2, true), `IC 90 % [${fr(all.expectancy_ci?.[0], 2, true)} ; ${fr(all.expectancy_ci?.[1], 2, true)}] · brut ${fr(all.expectancy_r_gross, 2, true)}`, tone(all.expectancy_r)),
      tile("Trades", String(all.n || 0), `${all.independent_bets || 0} paris indépendants`),
      tile("$ par trade", usd(all.usd_per_trade), `après impôt ${usd(all.usd_per_trade_after_tax)} · pire trade ${fr(all.worst_r, 1, true)} R`, tone(all.usd_per_trade))));
    const rows = [];
    for (const [vk, vr] of Object.entries(b.variants || {})) {
      for (const k of ["1", "2", "3"]) {
        for (const segk of ["research", "holdout"]) {
          const m = vr.stress?.[k]?.[segk]?.mtm || {};
          const c = vr.stress?.[k]?.[segk]?.closed || {};
          if (!m.n) continue;
          rows.push([VARIANT[vk] || vr.label, `${k}×`, SEG_FR[segk], String(m.n), String(m.independent_bets), pct(m.win_rate), pct(c.win_rate),
            pct(m.break_even_win_rate), fr(m.avg_win_r, 2), fr(m.avg_loss_r, 2), signed(m.expectancy_r),
            `[${fr(m.expectancy_ci?.[0], 2, true)} ; ${fr(m.expectancy_ci?.[1], 2, true)}]`, fr(m.worst_r, 1, true),
            fr(m.mae_r?.p10, 1, true), `${fr(m.hours_median, 0)} h`, signed(m.usd_per_trade, (x) => usd(x)), signed(m.usd_per_trade_after_tax, (x) => usd(x)),
            pct(m.target_exit_loss_share)]);
        }
      }
    }
    card.append(table(["Règle de sortie", "Coûts", "Segment", "Trades", "Paris indép.", "Gagnants", term("Gagn. clôturés", "Trades encore ouverts à la fin ignorés."),
      "Seuil", "Gain moy. R", "Perte moy. R", "R net", "IC 90 %", "Pire R", term("MAE p10", "Excursion défavorable maximale : 10 % des trades sont descendus plus bas que ça (en R) avant de sortir."),
      "Durée méd.", "$/trade", "$ après impôt", term("Sorties −1σ perdantes", "Part des sorties à la ligne −1σ qui perdent de l'argent : la ligne baisse avec le prix, donc « sortie −1σ » ne veut pas dire « gagnant ».")],
      rows, { numeric: [3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17] }));
    const yr = b.by_year || {}, mk = b.market_by_year || {};
    const years = Object.keys(yr.nostop || {}).sort();
    if (years.length > 1) {
      const hasCombo = !!yr.combo;
      const yrows = years.map((y) => {
        const n = yr.nostop[y] || {}, c = (yr.combo || {})[y] || {};
        const row = [y, pct(mk[y]?.median_return, 0, true), String(n.n || 0), pct(n.win_rate), signed(n.expectancy_r), signed(n.pnl_usd, (x) => usd(x, 0))];
        if (hasCombo) row.push(String(c.n || 0), signed(c.expectancy_r), signed(c.pnl_usd, (x) => usd(x, 0)));
        return row;
      });
      const head = ["Année", term("Marché", "Rendement médian sur l'année des instruments eux-mêmes (achat-conservation)."), "Trades", "Gagnants", "R net", "P&L"];
      if (hasCombo) head.push("Trades (combo)", "R net (combo)", "P&L (combo)");
      card.append(node("p", { class: "small muted", style: "margin:10px 0 4px" }, `Année par année (année d'entrée, coûts 1×, ouverts au prix du marché) : sans stop${hasCombo ? " et combo (plafond + stop lointain + limites)" : ""}.`),
        table(head, yrows, { numeric: hasCombo ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5] }));
    }
    const bl = b.baselines || {};
    const lines = [];
    for (const [kind, label] of [["dip", "achats de creux au hasard, mêmes sorties"], ["time", "entrées au hasard, même durée de détention"]]) {
      const x = bl.random?.[kind];
      if (x) lines.push(node("li", {}, `Sans stop, contre ${label} (${bl.random.runs} tirages, entrées au marché) : hasard ${usd(x.mean_usd)} par trade [${usd(x.p05_usd)} ; ${usd(x.p95_usd)}], ${pct(x.win_rate)} gagnants — stratégie ${usd(x.real_usd)}. p = ${fr(x.p_value, 3)} `,
        node("span", { class: x.p_value < 0.1 ? "good" : "bad" }, x.p_value < 0.1 ? "(mieux que le hasard)" : "(pas mieux que le hasard)")));
    }
    for (const [vk, extra] of Object.entries(b.baselines_by_variant || {})) {
      const x = extra?.random?.dip;
      if (x) lines.push(node("li", {}, `Avec ${VARIANT[vk] || vk}, contre des creux au hasard avec les mêmes stop et objectif : hasard ${usd(x.mean_usd)} par trade, stratégie ${usd(x.real_usd)}. p = ${fr(x.p_value, 3)} `,
        node("span", { class: x.p_value < 0.1 ? "good" : "bad" }, x.p_value < 0.1 ? "(mieux que le hasard)" : "(pas mieux que le hasard)")));
    }
    if (bl.buy_hold?.instruments) lines.push(node("li", {}, `Achat-conservation des mêmes instruments : ${pct(bl.buy_hold.mean_return, 1, true)} en moyenne, médiane ${pct(bl.buy_hold.median_annual, 1, true)} par an (holdout ${pct(bl.buy_hold.holdout_mean_return, 1, true)}). La stratégie a ${fr(bl.buy_hold.avg_open_positions, 1)} positions ouvertes en moyenne : comparer avec son rendement annuel ci-dessous.`));
    const sb = b.snapshot_bias;
    if (sb?.snapshots) lines.push(node("li", {}, `Lecture « journal » (chaque jour, trades des 7 derniers jours) : clôturés seulement ${pct(sb.closed_only_win_rate)} gagnants ; ouverts compris au prix du marché ${pct(sb.with_open_win_rate)}. Un journal qui ignore les ouverts afficherait 100 % de gagnants ${pct(sb.share_snapshots_closed_100pct)} des jours.`));
    const ss = b.session_split;
    if (ss?.open?.n && ss?.closed?.n) lines.push(node("li", {}, `Actions et indices, signal pendant la séance du sous-jacent : ${ss.open.n} trades, ${fr(ss.open.expectancy_r, 2, true)} R ; séance fermée (prix fait par les seuls traders du perp) : ${ss.closed.n} trades, ${fr(ss.closed.expectancy_r, 2, true)} R.`));
    const wf = b.walk_forward;
    if (wf?.selected) lines.push(node("li", {}, `Walk-forward (${(wf.folds || []).length} plis) : choisir à chaque pli la règle de sortie qui a le mieux marché avant donne ${fr(wf.selected.mean_r, 2, true)} R sur ${wf.selected.n} trades, contre ${fr(wf.his_rule.mean_r, 2, true)} R sans stop.`));
    const pf = b.portfolio;
    if (pf?.summary) {
      const sm = pf.summary, ci = pf.ci90 || {};
      lines.push(node("li", {}, `Carnet entier sans stop (capital ${usd(pf.capital, 0, false)} = ${pf.peak_open} positions au maximum en même temps, P&L marqué chaque jour) : rendement annuel ${pct(sm.cagr, 1, true)} [IC 90 % ${pct(ci.cagr?.[1], 1, true)} ; ${pct(ci.cagr?.[2], 1, true)}], Sharpe ${fr(sm.sharpe, 2)} [${fr(ci.sharpe?.[1], 2)} ; ${fr(ci.sharpe?.[2], 2)}], Sortino ${fr(sm.sortino, 2)}, pire baisse ${pct(sm.max_drawdown, 1)}.`));
    }
    const pbv = b.portfolio_by_variant || {};
    if (Object.keys(pbv).length) {
      const books = [["nostop", b.portfolio], ...Object.entries(pbv)].filter(([, x]) => x?.summary);
      lines.push(node("li", {}, `Carnet entier par règle de sortie (capital = positions ouvertes au maximum × 1 000 $) : ` +
        books.map(([vk, x]) => `${VARIANT[vk] || vk} : capital ${usd(x.capital, 0, false)}, ${pct(x.summary.cagr, 1, true)} par an, Sharpe ${fr(x.summary.sharpe, 2)}, pire baisse ${pct(x.summary.max_drawdown, 1)}`).join(" · ") + "."));
    }
    const dsr = b.dsr_by_variant || {};
    const dsrTxt = Object.entries(dsr).filter(([, x]) => isNum(x)).map(([vk, x]) => `${VARIANT[vk] || vk} ${fr(x, 2)}`).join(" · ");
    if (dsrTxt) lines.push(node("li", {}, `Deflated Sharpe Ratio (il faut > 0,95) : ${dsrTxt}.`));
    card.append(node("ul", { class: "checks-list" }, lines));
    if (b.equity?.t?.length) {
      const holder = node("div");
      card.append(node("h3", {}, "P&L cumulé sans stop (1 000 $ par trade, coûts et funding inclus, marqué chaque jour)"), holder);
      setTimeout(() => charts.push(lineChart(holder, { series: [{ label: "P&L cumulé", color: "--series-1", t: b.equity.t, v: b.equity.v, area: true }],
        yFmt: (x) => usd(x, 0), height: 220, includeZero: true, ariaLabel: `P&L cumulé ${key} ${src}` })), 0);
    }
  }
  return card;
}

// ---------- page: rules ----------
async function pageRules() {
  const rep = await get("/api/backtest").catch(() => null);
  const rules = [
    ["Bollinger", "période 160 ; bande médiane = SMA160 ; σ = écart-type de population des clôtures sur 160 barres"],
    ["RSI 4H long (principale)", "RSI14 4H ≤ 27 et largeur BB(20,2) ≥ 2 %, volatilité réalisée 20 jours ≥ sa médiane sur 1 an, biais 1D pas ▼ confirmé : achat à l'ouverture suivante ; sortie à RSI ≥ 50 ou après 5 jours. Crypto, actions et indices"],
    ["BB 160 · 4H crypto (principale)", "ordre limite d'achat à la bande médiane − 2σ de la dernière clôture 4H, seulement si la volatilité réalisée 20 jours ≥ sa médiane sur 1 an et si le biais 1D n'est pas ▼ confirmé ; rempli si le plus bas de la barre suivante la touche (à la bande, ou à l'ouverture si elle ouvre en dessous). Altcoins"],
    ["BB 160 · 4H · 3σ (surveillée)", "même chose à − 3σ, sans filtre, sur crypto et actions"],
    ["Stop Bollinger (testé)", "une bande au-delà de l'entrée (− 3σ pour une entrée à 2σ, − 4σ à 3σ), calculée à l'entrée et figée ; pas d'entrée si le prix est déjà en dessous"],
    ["Objectif Bollinger (testé)", "vente limite à la bande médiane SMA160 de la dernière clôture, réarmée à chaque barre ; si une barre peut toucher le stop et l'objectif, le stop est compté en premier"],
    ["Sorties", "affichée : sans stop, sortie quand une clôture repasse la ligne −1σ (BB) ou RSI ≥ 50 (RSI), horizon 5 jours ; testées et journalisées aussi : stop + objectif Bollinger, stop Bollinger seul, stop 2,5 × ATR14, limite de 3 jours"],
    ["Biais MTF", "par unité de temps : ▲ confirmé = clôture > EMA20 > EMA50 et EMA20 montante ; naissant ; repli ; neutre (mêmes règles en miroir pour ▼)"],
    ["Familles", "risk-on / risk-off quand (part ▲ − part ▼) des instruments d'une famille dépasse ±30 % (états 4H)"],
    ["Distribution", "excursion en ATR entre les 10e et 90e centiles des trades passés encore ouverts au même âge"],
    ["Proba 24 h", "fréquence historique d'atteinte du déclencheur dans les 24 h, par distance (σ) et vitesse d'approche"],
    ["1 R", "ATR14 (Wilder) de la bougie d'entrée"],
    ["Coûts", "frais Hyperliquid du marché (maker pour un ordre limite rempli à son prix, taker sinon), écart et profondeur en parcourant le carnet pour 1 000 $, funding à chaque heure réelle"],
  ];
  view.replaceChildren(node("h1", {}, "Règles"),
    node("p", { class: "lede" }, `Toutes les règles sont des valeurs écrites dans config.toml. Toute modification après avoir vu un résultat est un nouvel essai, inscrit au registre (${rep?.n_trials ?? "?"} essais à ce jour) : le Deflated Sharpe Ratio en tient compte.`),
    table(["Règle", "Définition"], rules));
}

// ---------- page: paper (F5) ----------
const STEP_4H = 4 * 3600 * 1000;
const KIND = { crypto: "crypto", stock: "action", index: "indice" };
const EXIT_RULE = {
  rsi50: "vend à l'ouverture suivante dès qu'une clôture 4H ramène le RSI à 50 ; l'objectif est la clôture qu'il faut pour ça (exact pour la bougie en cours)",
  minus1sigma: "vend à l'ouverture suivante dès qu'une clôture 4H repasse la ligne −1σ ; l'objectif est cette ligne (≈ : elle bouge un peu à chaque clôture)",
};
const pctOf = (a, b) => (isNum(a) && isNum(b) && b ? a / b - 1 : null);
function untilText(t) {
  const ms = new Date(t) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "maintenant";
  const hrs = Math.floor(ms / 36e5);
  return hrs >= 24 ? `dans ${Math.floor(hrs / 24)} j ${hrs % 24} h` : `dans ${hrs} h ${Math.floor((ms % 36e5) / 6e4)} min`;
}
function ageText(t) {
  const hrs = Math.max(0, Math.floor((Date.now() - new Date(t)) / 36e5));
  return hrs >= 24 ? `${Math.floor(hrs / 24)} j ${hrs % 24} h` : `${hrs} h`;
}
const DIP_LABEL = { p50: ["CREUX HABITUEL", "CREUX"], p10: ["1 SUR 10 SOUS", "1/10"] };

function paperChartOpts(x) {
  const levels = (x.dips || []).filter((d) => isNum(d.price)).map((d) => ({
    v: d.price, label: DIP_LABEL[d.key][0], short: DIP_LABEL[d.key][1], color: "--bad", dash: d.key === "p50" ? "6 4" : "2 3" }));
  const horizon = x.horizon_end ? new Date(x.horizon_end).getTime() : null;
  return { bars: x.bars, live: x.live_bar, step: STEP_4H, xEnd: horizon ? horizon + STEP_4H : null, horizon,
    entry: { t: new Date(x.entry_time).getTime(), v: x.entry }, exitNext: x.exit_level, levels, price: x.price,
    yFmt: price, height: 250, ariaLabel: `${sym(x.coin)} bougies 4H, achat, objectif et creux`,
    labels: { exitTip: x.exit_rule === "rsi50" ? "clôture pour RSI 50" : "ligne −1σ", horizon: "vente forcée" } };
}

function paperHead(x) {
  const gain = isNum(x.pnl_usd) && x.pnl_usd > 0;
  return node("div", { class: "phead" },
    node("div", { class: "ptitle" }, node("span", { class: "pcoin" }, sym(x.coin)),
      node("span", { class: "muted small" }, ` ${KIND[x.kind] || x.kind || ""} · ${x.mode === "replay" ? "rejoué" : "live"}`)),
    node("div", { class: "pstatus" },
      node("span", { class: `pbadge ${gain ? "good" : "bad"}` }, gain ? "EN GAIN" : "EN PERTE"),
      node("span", { class: `pnl ${tone(x.pnl_usd)}` }, usd(x.pnl_usd)),
      node("span", { class: "muted small" }, `${pct(x.move_pct, 1, true)} · ${fr(x.latent_r, 2, true)} R`)));
}

function paperFacts(x) {
  const dips = Object.fromEntries((x.dips || []).map((d) => [d.key, d]));
  const kv = (k, v, cls = "") => node("div", {}, node("dt", {}, k), node("dd", { class: cls }, v));
  const facts = node("dl", { class: "pfacts" },
    kv("Achat", `${when(x.entry_time)} à ${price(x.entry)}`),
    kv("Prix live", `${price(x.price)} (${pct(x.move_pct, 1, true)})`),
    kv("Objectif", isNum(x.exit_level) ? `${x.exit_rule === "minus1sigma" ? "≈ " : ""}${price(x.exit_level)} (${pct(x.exit_pct, 1, true)} d'ici)` : "—", "exitc"),
    kv("Creux habituel", isNum(dips.p50?.price) ? `${price(dips.p50.price)} (${pct(pctOf(dips.p50.price, x.entry), 1, true)})` : "—", "bad"),
    kv("1 trade sur 10 sous", isNum(dips.p10?.price) ? `${price(dips.p10.price)} (${pct(pctOf(dips.p10.price, x.entry), 1, true)})` : "—", "bad"),
    kv("Vente forcée", `${when(x.horizon_end)} (${untilText(x.horizon_end)})`));
  const bits = [`ouvert depuis ${ageText(x.entry_time)}`];
  if (x.distribution) bits.push(x.distribution);
  if (x.worst && isNum(x.worst.price)) bits.push(`pire creux vu au backtest : ${price(x.worst.price)} (${pct(pctOf(x.worst.price, x.entry), 1, true)})`);
  const note = node("p", { class: "note pnote" }, bits.join(" · "));
  if (x.pending) note.prepend(node("span", { class: "pbadge exit" }, "VENTE À L'OUVERTURE SUIVANTE"), " ");
  return [facts, note];
}

function paperCard(x) {
  const holder = node("div", { class: "pchart" });
  const card = node("article", { class: `card pcard ${isNum(x.pnl_usd) && x.pnl_usd > 0 ? "good" : "bad"}` }, paperHead(x), holder, ...paperFacts(x));
  return { card, holder };
}

const paperView = { ids: "", cards: new Map() };
const paperIds = (d) => (d.trades || []).map((x) => `${x.strategy}|${x.id}`).join(",");

function paperTiles(d) {
  const s = d.summary || {};
  const worst = (d.trades || []).reduce((a, x) => (isNum(x.pnl_usd) && (!a || x.pnl_usd < a.pnl_usd) ? x : a), null);
  return node("div", { class: "tiles" },
    tile("Positions ouvertes", String(s.open || 0), `${s.live || 0} vues en direct · ${(s.open || 0) - (s.live || 0)} rejouées`),
    tile("En gain / en perte", `${s.gain || 0} / ${s.loss || 0}`, "frais et funding compris"),
    tile("P&L ouvert", usd(s.pnl_usd), "1 000 $ par position, au prix live", tone(s.pnl_usd)),
    tile("Pire position", worst ? usd(worst.pnl_usd) : "—", worst ? `${sym(worst.coin)} · ${STRAT[worst.strategy] || worst.strategy}` : "", tone(worst?.pnl_usd)));
}

function paperLegend() {
  const k = (cls, text) => node("span", { class: "lg" }, node("i", { class: `lgk ${cls}` }), text);
  return node("p", { class: "legend-line plegend" },
    k("dot", "achat"), k("exit", "objectif de sortie"), k("p50", "creux habituel des trades passés"),
    k("p10", "1 trade passé sur 10 est descendu plus bas"), k("price", "prix live"), k("live", "bougie 4H en cours"),
    k("zone", "temps restant jusqu'à la vente forcée (5 jours)"));
}

async function pagePaper(update = false) {
  const d = await get("/api/paper");
  const ids = paperIds(d);
  if (update && ids === paperView.ids && paperView.cards.size) {
    for (const x of d.trades) {
      const c = paperView.cards.get(`${x.strategy}|${x.id}`);
      if (!c) continue;
      c.card.className = `card pcard ${isNum(x.pnl_usd) && x.pnl_usd > 0 ? "good" : "bad"}`;
      c.card.querySelector(".phead").replaceWith(paperHead(x));
      c.card.querySelector(".pfacts").remove();
      c.card.querySelector(".pnote").remove();
      c.card.append(...paperFacts(x));
      c.chart.update(paperChartOpts(x));
    }
    document.getElementById("paper-tiles")?.replaceChildren(paperTiles(d));
    document.getElementById("paper-stamp").textContent = paperStamp(d);
    return;
  }
  clearCharts();
  paperView.ids = ids;
  paperView.cards = new Map();
  const parts = [node("h1", {}, "Paper"),
    node("p", { class: "lede" }, `Toutes les positions papier ouvertes, ${VARIANT[d.variant] || "sans stop"}, 1 000 $ chacune. Rien n'est acheté pour de vrai. `
      + (STATIC ? "Bougies 4H de Hyperliquid ; version en ligne mise à jour toutes les 15 minutes." : "Bougies 4H de Hyperliquid ; la dernière se forme en direct et la page se met à jour chaque minute.")),
    node("p", { class: "small muted", id: "paper-stamp" }, paperStamp(d)),
    node("div", { id: "paper-tiles" }, paperTiles(d)), paperLegend()];
  if (!d.trades?.length) parts.push(node("p", { class: "muted" }, "Aucune position papier ouverte pour le moment."));
  const pending = [];
  for (const key of ["rsi4h", "bb160_4h", "reconciled:bb160_4h"]) {
    const rows = (d.trades || []).filter((x) => x.strategy === key);
    if (!rows.length) continue;
    const first = rows[0];
    const n = first.backtest_trades;
    parts.push(sectionHead(`${STRAT[key] || key} · ${rows.length} ouverte${rows.length > 1 ? "s" : ""}`, key === "reconciled:bb160_4h" ? "surveillée, pas une stratégie principale" : ""),
      node("p", { class: "section-intro" }, `Sortie : ${EXIT_RULE[first.exit_rule]}, ou vente forcée après 5 jours. Pas de stop : les lignes rouges disent jusqu'où les ${n || ""} trades passés de cette stratégie `
        + "(backtest Hyperliquid) sont descendus sous leur prix d'achat avant de finir. La moitié est descendue sous « creux habituel », 1 sur 10 sous « 1 sur 10 ». Ce n'est pas un plancher."));
    const grid = node("div", { class: "pgrid" });
    for (const x of rows) {
      const c = paperCard(x);
      grid.append(c.card);
      paperView.cards.set(`${x.strategy}|${x.id}`, c);
      pending.push([c, x]);
    }
    parts.push(grid);
  }
  if (d.held?.length) parts.splice(5, 0, node("p", { class: "note" }, `Suivi${d.held.length > 1 ? "s" : ""} jusqu'à la sortie : ${d.held.map(sym).join(", ")} — passé${d.held.length > 1 ? "s" : ""} sous le seuil de volume du scanner, aucun nouveau trade dessus, mais la position ouverte continue jusqu'à sa vente.`));
  const armed = Object.entries(d.armed || {}).filter(([, v]) => v);
  if (armed.length) parts.push(node("p", { class: "note" }, `Pas encore dedans : ordres limites BB 160 armés sous le prix, pas remplis — ${armed.map(([k, v]) => `${STRAT[k] || k} : ${v}`).join(" · ")}. Ils n'apparaissent ici qu'une fois remplis.`));
  view.replaceChildren(...parts);
  for (const [c, x] of pending) {
    c.chart = candleChart(c.holder, paperChartOpts(x));
    charts.push(c.chart);
  }
}
const paperStamp = (d) => `Prix live ${d.live_at ? when(d.live_at) : "—"} UTC · signaux et journal du ${when(d.generated)} UTC`;

// ---------- router + function keys ----------
const ROUTES = { scanner: pageScanner, journal: pageJournal, backtest: pageBacktest, regles: pageRules, paper: pagePaper };
const KEYS = { F1: "scanner", F2: "journal", F3: "backtest", F4: "regles", F5: "paper" };
async function route() {
  clearCharts();
  let name = (location.hash || "#scanner").slice(1);
  if (!ROUTES[name]) name = "scanner";
  for (const a of document.querySelectorAll("#tabs a")) {
    if (a.getAttribute("href") === `#${name}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  try { await ROUTES[name](); } catch (e) { view.replaceChildren(node("div", { class: "card" }, node("h2", {}, "Erreur"), node("pre", {}, String(e)))); }
  if (name !== "scanner") get("/api/scanner").then(renderStatus).catch(() => {});
}
window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {
  const target = KEYS[e.key];
  if (!target || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  location.hash = `#${target}`;
});
document.getElementById("theme").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
  document.dispatchEvent(new Event("themechange"));
});
route();
// redraw the scanner every minute with the live prices, unless a chart is open or the filter is in use
setInterval(() => {
  if ((location.hash || "#scanner") !== "#scanner" || document.hidden) return;
  if (chartBox.childElementCount || document.activeElement?.type === "search") return;
  route();
}, 60 * 1000);
// the paper page updates its cards in place every minute (live candle, price, P&L)
setInterval(() => {
  if (location.hash !== "#paper" || document.hidden) return;
  pagePaper(true).catch(() => {});
}, 60 * 1000);
