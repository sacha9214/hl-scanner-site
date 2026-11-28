// edgeterm dashboard: a hash router and one render function per page.
// All data text goes into the DOM through textContent (see node()), never innerHTML,
// except the "How it works" page, whose HTML is generated server-side from our own template.

import { intervalPlot, lineChart } from "./chart.js";
import { compact, date, isNum, money, multiple, num, pct, price, tone } from "./format.js";

const view = document.getElementById("view");
const cache = new Map();
let charts = [];

// ---------- tiny DOM helper ----------
function node(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const term = (word, tip) => node("span", { class: "term", tabindex: "0", "data-tip": tip }, word);
const signed = (x, fmt = (v) => pct(v), good = true) => node("span", { class: tone(x, good) }, fmt(x));

const TIPS = {
  perYear: "Compound annual growth rate: the steady yearly return that would turn the starting amount into the final one.",
  worstFall: "Maximum drawdown: the largest drop from a previous high, before a new high was reached.",
  sharpe: "Return divided by its volatility, per year. Higher means a smoother ride for the same return. Holding BTC is about 0.8.",
  unseen: "The rule's authors designed it on data from 2015 to March 2025. Results before 2015 and after March 2025 are out of sample: the rule could not have been fitted to them.",
  r: "R is the amount at risk when a trade is opened (position size × distance to its stop). +1 R means the trade made back what it risked.",
  range: "90% range from a block bootstrap: the history is resampled thousands of times; 9 times in 10 the result falls inside.",
  slippage: "The difference between the mid price and the average price you actually get when your order eats through the order book.",
  funding: "On perpetual futures, longs and shorts pay each other a small fee every few hours. Positive funding means longs pay shorts.",
  kelly: "The Kelly fraction is the bet size that maximises long-run growth if the edge is known exactly. It is never known exactly.",
  sizing: "Each strategy position is 25% divided by the coin's volatility, so calm coins get bigger positions and wild coins smaller ones.",
};

async function get(url, { fresh = false } = {}) {
  if (!fresh && cache.has(url)) return cache.get(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const data = await r.json();
  cache.set(url, data);
  return data;
}

function clearCharts() { charts.forEach((c) => c.destroy && c.destroy()); charts = []; }

function tile(label, value, sub, cls = "") {
  return node("div", { class: "tile" }, node("div", { class: "label" }, label),
              node("div", { class: `value ${cls}` }, value), sub ? node("div", { class: "sub" }, sub) : null);
}

function table(headers, rows, numeric = []) {
  const t = node("table", { class: "data" });
  t.append(node("thead", {}, node("tr", {}, headers.map((h, i) => node("th", { class: numeric.includes(i) ? "num" : "" }, h)))));
  const tb = node("tbody");
  for (const r of rows) tb.append(node("tr", {}, r.map((c, i) => node("td", { class: numeric.includes(i) ? "num" : "" }, c))));
  t.append(tb);
  return node("div", { class: "table-wrap" }, t);
}

function chartCard(title, note) {
  const holder = node("div");
  const card = node("section", { class: "card chart-card" }, node("h3", {}, title), note ? node("p", { class: "note" }, note) : null, holder);
  return { card, holder };
}

// ---------- status chips ----------
async function renderStatus() {
  const s = document.getElementById("status");
  const chips = [];
  try {
    const o = await get("/api/overview");
    if (o.ready) chips.push(node("span", { class: "chip" }, node("span", { class: "dot" }), `Data to ${o.data_end}`));
  } catch { /* the page still works without the chip */ }
  try {
    const p = await get("/api/paper");
    chips.push(p.started
      ? node("span", { class: `chip ${p.halt ? "bad" : "good"}` }, node("span", { class: "dot" }),
             p.halt ? "Paper: halted" : `Paper: day ${p.days} of ${p.required_days}`)
      : node("span", { class: "chip" }, node("span", { class: "dot" }), "Paper: not started here"));
  } catch { /* idem */ }
  s.replaceChildren(...chips);
  get("/api/market").then((m) => {
    if (m.error) return;
    s.append(node("span", { class: "chip good" }, node("span", { class: "dot" }), `Live books ${m.at.slice(11, 16)} UTC`));
  }).catch(() => {});
}

// ---------- pages ----------
async function pageOverview() {
  const o = await get("/api/overview");
  if (!o.ready) return [node("h1", {}, "No backtest yet"), node("p", { class: "lede" }, "Run: edgeterm backtest")];
  const tiles = node("div", { class: "tiles" }, o.tiles.map((t) => tile(
    t.label === "Trend, worst fall" ? term(t.label, TIPS.worstFall) :
      t.label.includes("unseen") ? term(t.label, TIPS.unseen) : term(t.label, TIPS.perYear),
    signed(t.value, (v) => pct(v)), t.sub)));
  const { card, holder } = chartCard("Growth of 1 since 2018",
    "Logarithmic scale: the same height means the same percentage change. The shaded part is after March 2025, data the rule never saw. Click a legend entry to show or hide a line.");
  const eq = o.equity;
  const holdoutT = Date.UTC(2025, 2, 20);
  const s = (id, color, visible = true) => ({ label: eq[id].label, short: eq[id].label.replace("Holding ", "").replace("100-day average filter", "SMA").replace("Trend strategy", "Trend"),
                                              color, t: eq[id].t, v: eq[id].v, visible });
  const chartsBody = [card];
  queueMicrotask(() => charts.push(lineChart(holder, {
    series: [s("trend_zpb", "--series-1"), s("bh_btc", "--series-2"), s("sma", "--series-3", false), s("bh_basket", "--series-4", false)],
    y: "log", yFmt: multiple, height: 320, bands: [{ from: holdoutT, label: "unseen" }],
    ariaLabel: "growth of 1 for each strategy since 2018, log scale",
  })));
  const summary = node("section", { class: "card summary" }, node("h3", {}, "In short"),
                       node("ul", {}, o.bullets.map((b) => node("li", {}, b))));
  const today = node("section", { class: "card" }, node("h3", {}, "Right now"), node("p", { class: "loading" }, "Computing today's signals…"));
  get("/api/signals").then((g) => {
    today.replaceChildren(node("h3", {}, "Right now"), node("p", { class: "section-intro" }, g.headline),
                          node("a", { href: "#today" }, "See the math for each coin →"));
  }).catch((e) => today.replaceChildren(node("h3", {}, "Right now"), node("p", { class: "bad" }, String(e))));
  return [
    node("h1", {}, "Is there an edge in trend following on crypto majors?"),
    node("p", { class: "lede" }, "A published trend-following rule on 11 large cryptocurrencies (no memecoins), tested after real trading costs, against simply holding, and on years its authors never saw. Signals come from prices only."),
    summary, node("div", { class: "spacer" }), tiles, ...chartsBody, today,
  ];
}

async function pageToday() {
  const g = await get("/api/signals");
  const body = node("tbody");
  for (const r of g.rows) {
    const pips = node("span", { class: "pips", "aria-hidden": "true" }, Array.from({ length: 9 }, (_, i) => node("i", { class: i < r.systems ? "on" : "" })));
    const meter = node("span", { class: "meter", "aria-hidden": "true" }, node("i"));
    meter.firstChild.style.setProperty("width", `${Math.min(100, (r.coin_weight || 0) * 100)}%`);
    const row = node("tr", { class: "clickable", tabindex: "0", "aria-expanded": "false" },
      node("td", { class: "strong" }, node("span", { class: "caret" }, "›"), " ", r.coin),
      node("td", { class: "num" }, price(r.close)),
      node("td", { class: "num" }, signed(r.change_1d)),
      node("td", { class: "num" }, signed(r.change_30d)),
      node("td", {}, pips, `${r.systems} of 9`),
      node("td", {}, meter, pct(r.portfolio_weight, 1, false)),
      node("td", { class: "num" }, r.systems ? price(r.plan.stop) : "—"),
      node("td", { class: "num" }, r.systems ? money(r.plan.risk_1r) : "—"),
      node("td", { class: "num" }, r.systems ? money(r.plan.round_trip_cost) : "—"));
    const p = r.plan, hb = p.history.before_holdout || {}, ho = p.history.holdout || {};
    const detail = node("tr", { class: "detail", hidden: true }, node("td", { colspan: "9" },
      node("div", {}, r.plain),
      node("div", { class: "detail-grid" },
        node("div", {}, node("span", {}, "Distance to the stop"), node("b", {}, pct(p.stop_distance, 1, false))),
        node("div", {}, node("span", {}, "Cost of the round trip, in R"), node("b", {}, isNum(p.cost_in_r) ? num(p.cost_in_r, 3) + " R" : "—")),
        node("div", {}, node("span", {}, "Average trade before 2025-03"), node("b", {}, isNum(hb.expectancy_r) ? num(hb.expectancy_r, 2, true) + " R" : "—")),
        node("div", {}, node("span", {}, "Average trade since 2025-03"), node("b", {}, isNum(ho.expectancy_r) ? num(ho.expectancy_r, 2, true) + " R" : "—")),
        node("div", {}, node("span", {}, "Size by volatility target"), node("b", {}, pct(p.sizing.vol_target_weight, 0, false))),
        node("div", {}, node("span", {}, "Size by fixed 1% risk"), node("b", {}, pct(p.sizing.fixed_risk_weight, 0, false))),
        node("div", {}, node("span", {}, "Size by ¼ Kelly"), node("b", {}, pct(p.sizing.fractional_kelly_weight, 0, false))),
        node("div", {}, node("span", {}, "Systems that exited today"), node("b", {}, p.closed_today.length ? p.closed_today.map((x) => `${x.system.replace("donchian", "")}-day ${num(x.r, 1, true)} R`).join(", ") : "none")),
      )));
    const toggle = () => { const open = row.getAttribute("aria-expanded") === "true"; row.setAttribute("aria-expanded", String(!open)); detail.hidden = open; };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    body.append(row, detail);
  }
  const t = node("table", { class: "data" },
    node("thead", {}, node("tr", {}, ["Coin", "Price", "24 h", "30 d", "Trend strength", "Holding (of book)", "Stop", "Loss if stopped", "Cost to trade"]
      .map((h, i) => node("th", { class: [1, 2, 3, 6, 7, 8].includes(i) ? "num" : "" },
        h === "Trend strength" ? term(h, "How many of the 9 breakout systems (5 to 360 days) are currently long this coin.")
          : h === "Loss if stopped" ? term(h, TIPS.r) : h === "Cost to trade" ? term(h, "Fees plus spread plus slippage to buy now and sell later, at today's order-book depth.") : h)))),
    body);
  const costs = node("div", {}, node("p", { class: "loading" }, "Reading live order books…"));
  const carry = node("div", {}, node("p", { class: "loading" }, "Reading funding rates…"));
  get("/api/market").then((m) => {
    if (m.error) { costs.replaceChildren(node("p", { class: "bad" }, m.error)); carry.replaceChildren(); return; }
    costs.replaceChildren(table(
      ["Coin", "Pair", "Spread", `Slippage, ${compact(m.size)} buy`, "Taker fee", "Cost per side", "Round trip"],
      m.costs.filter((c) => !c.error).map((c) => [c.coin, c.symbol, `${num(c.spread * 1e4, 1)} bp`, `${num(c.slip_buy * 1e4, 1)} bp`,
        pct(c.fee, 2, false), pct(c.per_side, 3, false), node("span", { class: c.per_side * 2 > 0.005 ? "bad" : "" }, pct(c.per_side * 2, 2, false))]),
      [2, 3, 4, 5, 6]));
    carry.replaceChildren(table(
      ["Perpetual", term("Funding, last 7 days", TIPS.funding), "Last 12 months", "Negative prints", "Needed to cover costs", "Yield on capital", "Rule says"],
      m.funding.map((f) => [f.coin, signed(f.apr_7d), signed(f.apr_365d), pct(f.negative_365d, 0, false), pct(f.hurdle, 1, false),
        signed(f.net_on_capital), node("span", { class: `pill ${f.decision === "enter" ? "good" : "neutral"}` }, f.decision === "enter" ? "enter (paper only)" : "stay flat")]),
      [1, 2, 3, 4, 5]));
  }).catch((e) => costs.replaceChildren(node("p", { class: "bad" }, String(e))));
  return [
    node("h1", {}, "Today's signals"),
    node("p", { class: "lede" }, g.headline),
    node("div", { class: "tiles" },
      tile("Book invested", pct(g.invested, 1, false), `of a ${compact(g.book)} ${g.quote} paper book`),
      tile("Coins held", `${g.rows.filter((r) => r.portfolio_weight > 0).length} of ${g.rows.length}`, "split equally, then sized by volatility"),
      tile("Last daily close", g.bar, "signals update once a day, after 00:00 UTC")),
    node("section", { class: "card" }, node("h3", {}, "The math before each trade"),
      node("p", { class: "note" }, "Click a coin for the full calculation. Positions are sized so each coin carries similar risk; the rest of the book stays in USDC."),
      node("div", { class: "table-wrap" }, t)),
    node("h2", {}, "What trading costs right now"),
    node("p", { class: "section-intro" }, "Measured on the live OKX EU order books for an order of your book's size. This is what a market order would pay, both ways, before tax."),
    node("section", { class: "card" }, costs),
    node("h2", {}, "Funding carry"),
    node("p", { class: "section-intro" }, "Buy the coin and short the same amount of its perpetual future: price moves cancel out and you collect funding. It only makes sense when funding beats trading costs, and it has to beat the Livret A (1.7%, tax-free) to be worth the trouble."),
    node("section", { class: "card" }, carry),
  ];
}

const RANGES = [["6M", 182], ["1Y", 365], ["2Y", 730], ["5Y", 1826], ["All", null]];

async function pageChart(coinArg) {
  const o = await get("/api/overview");
  const coins = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LINK", "AVAX", "LTC", "DOT", "TRX"];
  let coin = coins.includes(coinArg) ? coinArg : "BTC";
  let range = null;
  const coinSeg = node("div", { class: "seg", role: "group", "aria-label": "Coin" });
  const rangeSeg = node("div", { class: "seg", role: "group", "aria-label": "Period" });
  const stats = node("div", { class: "tiles" });
  const head = node("p", { class: "lede" });
  const cards = ["price", "invested", "growth", "drawdown"].map(() => node("div"));
  const titles = [
    ["Price, with the strategy's buys and sells", "Logarithmic scale. ▲ the first system breaks out and the strategy starts buying; ▼ the last system exits and the strategy is fully out."],
    ["How much of this coin the strategy held", "Share of this coin's slice of the book, from 0 (no system in a trend) to 100% (all nine in a trend, capped by volatility)."],
    ["Growth of 1: strategy vs holding this coin", "After trading costs. Logarithmic scale."],
    ["Worst falls along the way", "How far each was below its previous high."],
  ];
  const cardEls = titles.map(([t, n], i) => node("section", { class: "card chart-card" }, node("h3", {}, t), node("p", { class: "note" }, n), cards[i]));
  const priceNote = cardEls[0].querySelector(".note");
  const instances = [];

  const draw = async () => {
    cardEls.forEach((c) => c.classList.add("stale"));
    const d = await get(`/api/chart/${coin}`);
    let i0 = 0;
    if (range) { const from = d.t[d.t.length - 1] - range * 864e5; while (i0 < d.t.length - 1 && d.t[i0] < from) i0++; }
    const T = d.t.slice(i0), C = d.close.slice(i0), Wt = d.weight.slice(i0);
    const tr0 = d.trend[i0], ho0 = d.hold[i0];
    const TR = d.trend.slice(i0).map((v) => v / tr0), HO = d.hold.slice(i0).map((v) => v / ho0);
    const dd = (arr) => { let peak = -Infinity; return arr.map((v) => { peak = Math.max(peak, v); return v / peak - 1; }); };
    const TD = dd(TR), HD = dd(HO);
    const years = (T[T.length - 1] - T[0]) / (365.25 * 864e5);
    const cagr = (arr) => arr[arr.length - 1] ** (1 / years) - 1;
    const minOf = (a) => a.reduce((m, v) => Math.min(m, v), 0);
    const invested = Wt.filter((w) => w > 0).length / Wt.length;
    head.replaceChildren(`${d.source}, ${date(T[0])} to ${date(T[T.length - 1])}. `,
      T[0] < d.paper_start ? "Before 2015 the rule's authors had no data, so that stretch is out of sample. " : "",
      "Daily closes; the strategy decides once a day.");
    stats.replaceChildren(
      tile(term("Strategy, per year", TIPS.perYear), signed(cagr(TR)), "after costs"),
      tile(term("Strategy, worst fall", TIPS.worstFall), signed(minOf(TD)), null),
      tile(`Holding ${coin}, per year`, signed(cagr(HO)), null),
      tile(`Holding ${coin}, worst fall`, signed(minOf(HD)), null),
      tile("Days with a position", pct(invested, 0, false), `${d.entries.filter((m) => m.t >= T[0]).length} buys in this period`));
    const bands = [];
    if (T[0] < d.paper_start) bands.push({ from: T[0], to: d.paper_start, label: "before the paper's data" });
    bands.push({ from: d.holdout_start, label: "unseen" });
    const allMarkers = [
      ...d.entries.filter((m) => m.t >= T[0]).map((m) => ({ ...m, shape: "up", color: "--series-1", label: `▲ strategy starts buying at ${price(m.v)}` })),
      ...d.exits.filter((m) => m.t >= T[0]).map((m) => ({ ...m, shape: "down", color: "--series-1", label: `▼ strategy fully out at ${price(m.v)}` })),
    ];
    // past ~90 triangles they merge into blobs: hide them and say how to see them
    const dense = allMarkers.length > 90;
    const markers = dense ? [] : allMarkers;
    const nBuy = allMarkers.filter((m) => m.shape === "up").length, nSell = allMarkers.length - nBuy;
    priceNote.textContent = dense
      ? `${nBuy} buys and ${nSell} sells in this period, too many to draw legibly: pick 2Y or less to see each one. Logarithmic scale.`
      : "Logarithmic scale. ▲ the first system breaks out and the strategy starts buying; ▼ the last system exits and the strategy is fully out.";
    const specs = [
      { series: [{ label: `${coin} price`, color: "--neutral-line", t: T, v: C }], y: "log", yFmt: price, yTick: compact, height: 340, markers, bands,
        markerLegend: dense ? [] : [{ shape: "up", color: "--series-1", label: "strategy starts buying" }, { shape: "down", color: "--series-1", label: "strategy fully out" }],
        ariaLabel: `${coin} price with entries and exits` },
      { series: [{ label: "Held", color: "--series-1", t: T, v: Wt, area: true }], y: "linear", yDomain: [0, 1], yFmt: (v) => pct(v, 0, false), height: 160, bands,
        ariaLabel: "share of the coin's slice held" },
      { series: [{ label: "Strategy", short: "strategy", color: "--series-1", t: T, v: TR }, { label: `Holding ${coin}`, short: `hold`, color: "--series-2", t: T, v: HO }],
        y: "log", yFmt: multiple, height: 280, bands, ariaLabel: "growth of 1, strategy vs holding" },
      { series: [{ label: "Strategy", short: "strategy", color: "--series-1", t: T, v: TD, area: true }, { label: `Holding ${coin}`, short: "hold", color: "--series-2", t: T, v: HD, area: true }],
        y: "linear", includeZero: true, yFmt: (v) => pct(v, 0), height: 220, bands, ariaLabel: "drawdowns" },
    ];
    specs.forEach((spec, i) => { if (instances[i]) instances[i].update(spec); else { instances[i] = lineChart(cards[i], spec); charts.push(instances[i]); } });
    cardEls.forEach((c) => c.classList.remove("stale"));
  };
  const seg = (container, items, current, onPick) => {
    container.replaceChildren(...items.map(([label, value]) => node("button", { type: "button", "aria-pressed": String(value === current),
      on: { click: (e) => { [...container.children].forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); onPick(value); } } }, label)));
  };
  seg(coinSeg, coins.map((c) => [c, c]), coin, (c) => { coin = c; history.replaceState(null, "", `#chart/${c}`); draw(); });
  seg(rangeSeg, RANGES, range, (r) => { range = r; draw(); });
  queueMicrotask(draw);
  return [
    node("h1", {}, "Replay the strategy on any coin"),
    head,
    node("div", { class: "controls" }, coinSeg, rangeSeg),
    stats, ...cardEls,
    node("p", { class: "note" }, `BTC uses Bitstamp history from 2011, LTC and ETH Bitfinex history, the other coins Binance from 2017. Data to ${o.data_end || "—"}.`),
  ];
}

async function pageBacktest() {
  const b = await get("/api/backtest");
  if (!b.ready) return [node("h1", {}, "No backtest yet"), node("p", { class: "lede" }, "Run: edgeterm backtest")];
  let period = "full";
  const resultsBody = node("div");
  const drawResults = () => {
    const rows = b.rows.filter((r) => r.period === period);
    resultsBody.replaceChildren(
      node("p", { class: "note" }, `${rows[0].start} to ${rows[0].end}. After trading costs, before tax.`),
      table(["Strategy", term("Per year", TIPS.perYear), term("90% range", TIPS.range), term("Worst fall", TIPS.worstFall), term("Sharpe", TIPS.sharpe), "Longest below a previous high", "Average invested"],
        rows.map((r) => [node("span", { class: "strong" }, r.strategy), signed(r.cagr), `${pct(r.cagr_ci[0], 0)} to ${pct(r.cagr_ci[1], 0)}`,
          signed(r.max_drawdown), num(r.sharpe, 2), `${r.underwater_days} days`, pct(r.invested, 0, false)]), [1, 2, 3, 4, 5, 6]));
  };
  const periodSeg = node("div", { class: "seg", role: "group", "aria-label": "Period" },
    [["2018 – 2026", "full"], ["Since March 2025 (unseen)", "holdout"]].map(([label, value]) => node("button", {
      type: "button", "aria-pressed": String(value === period),
      on: { click: (e) => { period = value; [...periodSeg.children].forEach((x) => x.setAttribute("aria-pressed", String(x === e.currentTarget))); drawResults(); } } }, label)));
  drawResults();

  const color = { trend_zpb: "--series-1", sma: "--series-3", bh_basket: "--series-4" };
  const vsHolder = node("div");
  const vsRows = b.versus.map((v) => ({ label: `${v.strategy}, ${v.period === "full" ? "2018–2026" : "since 2025-03"}`, value: v.gap, ci: v.ci,
    color: color[v.id], note: `${pct(v.gap, 0)} a year · ${pct(v.p_ahead, 0, false)} chance ahead` }));
  queueMicrotask(() => intervalPlot(vsHolder, vsRows, { fmt: (x) => pct(x, 0) }));

  const yrs = b.years.years;
  const yearsTable = table(["Strategy", ...yrs], Object.entries(b.years.series).map(([name, vals]) => [node("span", { class: "strong" }, name), ...vals.map((v) => signed(v, (x) => pct(x, 0)))]),
                           yrs.map((_, i) => i + 1));
  const oldTable = table(["Coin", "Window", "Strategy per year", "at 2013 fees", "Strategy worst fall", "Holding per year", "Holding worst fall"],
    b.old.map((r) => [node("span", { class: "strong" }, r.coin), `${r.window} · ${r.start.slice(0, 7)} → ${r.end.slice(0, 7)}`, signed(r.trend), signed(r.trend_old_fees),
      signed(r.trend_dd), signed(r.hold), signed(r.hold_dd)]), [2, 3, 4, 5, 6]);
  const checks = node("div", { class: "grid-2" }, b.checks.map((c) => node("section", { class: "card" },
    node("div", { class: "label muted" }, c.name), node("div", { class: "hero hero-sm" }, c.value), node("p", { class: "note" }, c.plain))));
  const stress = table(["Scenario", "Strategy per year", "Worst fall"], [
    ...b.stress.map((s) => [s.label.replace("Costs x", "Trading costs ×"), signed(s.cagr), signed(s.max_drawdown)]),
    ["Tax deferred (today: switching to USDC is not taxed)", signed(b.tax.deferred), ""],
    ["Every exit taxed (2027 finance bill, if passed)", signed(b.tax.stablecoin), ""],
  ], [1, 2]);
  const sz = b.sizing;
  const sizing = table(["Method", "Position", "Risk per trade", "Chance of losing 50% (100 trades)", "Chance of a 30% fall", "Chance of ending down"],
    ["before_holdout", "holdout"].flatMap((per) => sz.per_trade[per].rows.map((r) => [
      `${r.scheme.replace("0.25 Kelly", "¼ Kelly").replace("vol target", "Volatility target").replace("fixed", "Fixed")} · ${per === "holdout" ? "since 2025-03" : "before 2025-03"}`,
      pct(r.weight, 0, false), pct(r.risk_per_trade, 2, false), pct(r.mc_p_ruin, 1, false), pct(r.mc_p_drawdown, 0, false), pct(r.mc_p_loss, 0, false)])), [1, 2, 3, 4, 5]);
  const pk = sz.portfolio;
  const carryTable = table(["Coin", "Funding, last 30 days", "Negative prints, 1 year", "Needed to cover costs", "Strategy, last 365 days", "Time in position"],
    b.carry.map((c) => [c.coin, signed(c.funding_apr_last_30d), pct(c.negative_share_last_365d, 0, false), pct(c.hurdle_apr, 1, false), signed(c.last_365d), pct(c.time_in_position, 0, false)]),
    [1, 2, 3, 4, 5]);
  const eur = table(["Capital", "Strategy, 2018–2026, per year", "after 31.4% tax", "Strategy since 2025-03, per year", "Holding BTC, 2018–2026", "Livret A"],
    Object.entries(b.euros).map(([cap, r]) => [`${Number(cap).toLocaleString("en-US")} €`, signed(r.trend_zpb_full.pre_tax, (v) => money(v, 0, true) + " €"),
      signed(r.trend_zpb_full.after_tax, (v) => money(v, 0, true) + " €"), signed(r.trend_zpb_holdout.pre_tax, (v) => money(v, 0, true) + " €"),
      signed(r.bh_btc_full.pre_tax, (v) => money(v, 0, true) + " €"), money(r.livret_a, 0) + " €"]), [1, 2, 3, 4, 5]);
  return [
    node("h1", {}, "Backtest"),
    node("p", { class: "lede" }, "Daily data, 11 coins, after the fees, spreads and slippage measured on the live order books. Parameters were fixed before the first run; nothing was tuned on these results."),
    node("div", { class: "controls" }, periodSeg),
    node("section", { class: "card" }, resultsBody),
    node("h2", {}, "Does it end with more money than holding BTC?"),
    node("p", { class: "section-intro" }, "Gap in yearly return against holding BTC. The dot is the measured gap, the bar its 90% range. A bar that crosses the zero line means the data cannot tell the two apart."),
    node("section", { class: "card" }, vsHolder),
    node("h2", {}, "Year by year"),
    node("section", { class: "card" }, yearsTable),
    node("h2", {}, "Older data: years before the rule existed"),
    node("p", { class: "section-intro" }, "The rule was designed on 2015 – March 2025. Bitstamp's BTC history goes back to 2011, so 2012 – 2014 is a second test the rule never saw: the 2013 bubble and the 2014 crash. Fees were much higher then, so results are also shown at 0.6% per trade side."),
    node("section", { class: "card" }, oldTable),
    node("h2", {}, "Could it be luck?"),
    node("p", { class: "section-intro" }, "Standard checks for a backtest that was searched or overfitted."),
    checks,
    node("h2", {}, "Costs and taxes"),
    node("section", { class: "card" }, stress),
    node("h2", {}, "Position size and risk of ruin"),
    node("p", { class: "section-intro" }, ["Taking the signals one trade at a time, over the next 100 trades. ", term("Kelly", TIPS.kelly),
      ` says to lever up ${num(pk.before_holdout.full_kelly_leverage, 0)}× on the rule's own years and ${num(pk.holdout.full_kelly_leverage, 1)}× since 2025: the edge estimate is too unstable to size on.`]),
    node("section", { class: "card" }, sizing),
    node("h2", {}, "Funding carry"),
    node("section", { class: "card" }, carryTable),
    node("h2", {}, "What it means in euros"),
    node("p", { class: "section-intro" }, "Yearly return applied to each capital size. Taxes in France: 31.4% on gains when euros leave the account; the Livret A is tax-free."),
    node("section", { class: "card" }, eur),
  ];
}

async function pageCalculator() {
  const coins = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LINK", "AVAX", "LTC", "DOT", "TRX"];
  const inputs = {};
  const input = (id, label, value, step) => {
    inputs[id] = node("input", { id, type: "number", value, step, min: "0" });
    return node("label", { class: "field" }, label, inputs[id]);
  };
  const coin = node("select", { id: "c-coin" }, coins.map((c) => node("option", { value: c }, c)));
  const out = node("div", {}, node("p", { class: "loading" }, "Calculating…"));
  const form = node("div", { class: "form-row" }, input("c-tp", "Take profit, %", "10", "0.5"), input("c-sl", "Stop loss, %", "5", "0.5"),
    input("c-win", "Your win rate, %", "38", "1"), input("c-amt", "Amount", "1000", "100"), node("label", { class: "field" }, "Coin (sets the cost)", coin));
  let timer;
  const run = async () => {
    const v = (id) => inputs[id].value;
    const q = new URLSearchParams({ tp: v("c-tp"), sl: v("c-sl"), win: v("c-win"), notional: v("c-amt"), coin: coin.value });
    try {
      const r = await fetch(`/api/calc?${q}`);
      if (!r.ok) { out.replaceChildren(node("p", { class: "bad" }, "Enter positive numbers; the win rate is between 0 and 100.")); return; }
      const c = await r.json();
      const good = c.expectancy_net > 0;
      const win = Number(v("c-win")) / 100;
      const track = node("div", { class: "be-track" },
        node("div", { class: `be-fill ${good ? "good" : "bad"}` }),
        node("div", { class: "be-mark" }, node("span", {}, `break-even ${pct(c.break_even_net, 1, false)}`)),
        node("div", { class: "be-mark you" }, node("span", {}, `you ${pct(win, 0, false)}`)));
      track.children[0].style.setProperty("width", `${Math.min(100, win * 100)}%`);
      track.children[1].style.setProperty("left", `${Math.min(100, c.break_even_net * 100)}%`);
      track.children[2].style.setProperty("left", `${Math.min(100, win * 100)}%`);
      out.replaceChildren(
        node("div", { class: "label muted" }, "Expected result per trade, after costs"),
        node("div", { class: `hero ${good ? "good" : "bad"}` }, money(c.eur_net, 2, true)),
        node("span", { class: `pill ${good ? "good" : "bad"}` }, good ? "✓ above break-even" : "✕ below break-even"),
        track,
        node("p", {}, c.plain),
        node("div", { class: "detail-grid" },
          node("div", {}, node("span", {}, "Reward to risk"), node("b", {}, `${num(c.reward_risk, 2)} : 1`)),
          node("div", {}, node("span", {}, "Loss if the stop is hit (1 R)"), node("b", {}, money(c.risk_eur))),
          node("div", {}, node("span", {}, "Round-trip cost"), node("b", {}, `${money(c.round_trip_cost_eur)} (${pct(c.round_trip_cost, 2, false)})`)),
          node("div", {}, node("span", {}, "Break-even with no costs"), node("b", {}, pct(c.break_even_gross, 1, false))),
          node("div", {}, node("span", {}, "Break-even if each win is taxed alone"), node("b", {}, pct(c.break_even_after_tax_no_offset, 1, false))),
          node("div", {}, node("span", {}, "After 31.4% tax, losses netted"), node("b", {}, money(c.eur_after_tax, 2, true))),
          node("div", {}, node("span", {}, "After tax, no loss offset"), node("b", {}, money(c.eur_after_tax_no_offset, 2, true))),
          node("div", {}, node("span", {}, "Cost per side"), node("b", {}, `${pct(c.cost_per_side, 3, false)} · ${c.cost_source}`))));
    } catch (e) { out.replaceChildren(node("p", { class: "bad" }, String(e))); }
  };
  form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  queueMicrotask(run);
  return [
    node("h1", {}, "Trade calculator"),
    node("p", { class: "lede" }, "For any trade with a take-profit and a stop-loss: the win rate you need to break even, and what a trade is worth after costs and tax."),
    node("section", { class: "card" }, form),
    node("section", { class: "card" }, out),
    node("p", { class: "note" }, "Formula: expected result = win rate × take-profit − (1 − win rate) × stop-loss − round-trip cost. Break-even win rate = (stop-loss + cost) divided by (take-profit + stop-loss)."),
  ];
}

async function pageHow() {
  const s = await get("/api/strategies");
  const prose = node("article", { class: "card prose" });
  prose.innerHTML = s.html; // generated server-side from our own template (config + report numbers); markdown HTML disabled
  const gl = node("dl", { class: "glossary" });
  for (const [k, label] of [["perYear", "Per year (CAGR)"], ["worstFall", "Worst fall (drawdown)"], ["sharpe", "Sharpe ratio"], ["unseen", "Unseen / out of sample"],
    ["r", "R (units of risk)"], ["range", "90% range"], ["slippage", "Slippage"], ["funding", "Funding rate"], ["kelly", "Kelly fraction"], ["sizing", "Volatility sizing"]]) {
    gl.append(node("dt", {}, label), node("dd", {}, TIPS[k]));
  }
  return [prose, node("h2", {}, "Glossary"), node("section", { class: "card" }, gl)];
}

async function pagePaper() {
  const p = await get("/api/paper", { fresh: true });
  if (!p.started) {
    return [
      node("h1", {}, "Paper trading"),
      node("p", { class: "lede" }, `Paper trading runs 24/7 on the VPS and fills simulated orders against the live order books. Real money is locked until ${p.required_days} days of paper results exist.`),
      node("section", { class: "card empty" }, node("h3", {}, "Not started on this machine"),
        node("ol", {},
          node("li", {}, "On the VPS: ", node("code", {}, "cd ~/edgeterm && bash deploy/install.sh")),
          node("li", {}, "To look at its journal from the Mac: ", node("code", {}, "deploy/pull-journal.sh")),
          node("li", {}, "Or run one cycle here: ", node("code", {}, "edgeterm paper --once")))),
    ];
  }
  const age = isNum(p.heartbeat_age_s) ? `${Math.round(p.heartbeat_age_s / 60)} min ago` : "never";
  const out = [
    node("h1", {}, "Paper trading"),
    node("p", { class: "lede" }, `Day ${p.days} of the ${p.required_days} required before real money can be switched on.`),
    node("div", { class: "tiles" },
      tile("Trend book", isNum(p.equity) ? money(p.equity) : "—", isNum(p.equity) ? `${pct(p.equity / p.capital - 1, 2)} since start` : null),
      tile("Invested", pct(p.invested, 1, false), null),
      tile("Kill-switch", p.halt ? "Halted" : "Armed", p.halt ? p.halt.reason : "stops trading after −5% in a UTC day", p.halt ? "bad" : "good"),
      tile("Last heartbeat", age, isNum(p.heartbeat_age_s) && p.heartbeat_age_s > 900 ? "the loop may be stopped" : "the loop is running")),
  ];
  if (p.curve.length > 1) {
    const { card, holder } = chartCard("Paper book value", null);
    queueMicrotask(() => charts.push(lineChart(holder, { series: [{ label: "Paper book", color: "--series-1", t: p.curve.map((x) => Date.parse(x.t)), v: p.curve.map((x) => x.v) }],
      y: "linear", yFmt: (v) => money(v, 0), height: 220 })));
    out.push(card);
  }
  out.push(node("h2", {}, "Positions"), node("section", { class: "card" }, p.positions.length ? table(["Coin", "Units", "Cost basis", "Opened"],
    p.positions.map((x) => [x.coin, num(x.units, 8), money(x.cost_basis), x.opened || ""]), [1, 2]) : node("p", { class: "muted" }, "No open position.")));
  out.push(node("h2", {}, "Closed positions — the math after each trade"), node("section", { class: "card" }, p.closed.length ? table(["Closed", "Coin", "Invested", "Proceeds", "Result", "Tax if cashed out"],
    p.closed.map((x) => [x.closed.slice(0, 16).replace("T", " "), x.coin, money(x.invested), money(x.proceeds), signed(x.pnl, (v) => money(v, 2, true)), money(x.tax_provision)]), [2, 3, 4, 5])
    : node("p", { class: "muted" }, "Nothing closed yet.")));
  out.push(node("h2", {}, "Fills"), node("section", { class: "card" }, table(["Time", "Book", "Side", "Coin", "Amount", "Price", "Fee", "Slippage", "Reason"],
    p.fills.map((f) => [f.time.slice(0, 16).replace("T", " "), f.book, f.side, f.coin, money(f.notional), price(f.price), money(f.fee), `${num(f.slippage_bps || 0, 1)} bp`, f.reason]), [4, 5, 6, 7])));
  out.push(node("h2", {}, "Decisions"), node("section", { class: "card" }, table(["Time", "Strategy", "Coin", "Action", "Target", "Detail"],
    p.signals.map((s) => [s.time.slice(0, 16).replace("T", " "), s.strategy === "trend_zpb" ? "trend" : s.strategy, s.coin, s.action, pct(s.target_weight, 1, false), s.detail]), [4])));
  return out;
}

// ---------- router ----------
const PAGES = { overview: pageOverview, today: pageToday, chart: pageChart, backtest: pageBacktest, calculator: pageCalculator, how: pageHow, paper: pagePaper };

async function route() {
  const [name, arg] = (location.hash.replace("#", "") || "overview").split("/");
  const page = PAGES[name] ? name : "overview";
  document.querySelectorAll("nav.tabs a").forEach((a) => {
    if (a.getAttribute("href") === `#${page}`) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  clearCharts();
  view.classList.add("stale");
  try {
    const content = await PAGES[page](arg);
    view.replaceChildren(...content);
  } catch (e) {
    view.replaceChildren(node("h1", {}, "Something went wrong"), node("p", { class: "bad" }, String(e)));
  }
  view.classList.remove("stale");
  window.scrollTo({ top: 0 });
}

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
  document.dispatchEvent(new Event("themechange"));
}
document.getElementById("theme").addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  localStorage.setItem("edgeterm-theme", next);
  applyTheme(next);
});
applyTheme(localStorage.getItem("edgeterm-theme"));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => document.dispatchEvent(new Event("themechange")));

window.addEventListener("hashchange", route);
route();
renderStatus();
