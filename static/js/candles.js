// A 4H candlestick chart for one paper position (the F5 page), in the same SVG idiom as edgeterm's
// lineChart: colors read from CSS custom properties at draw time, crosshair + one tooltip, redraw on
// resize and theme change. Draws the candles, the candle in progress, the entry dot, the exit line,
// the backtest dip levels, the live price and the forced-exit time, with labels on the right edge.

const SVG = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function niceStep(span, target) {
  const raw = span / Math.max(target, 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
const pad2 = (n) => String(n).padStart(2, "0");
const dayLabel = (t) => { const d = new Date(t); return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`; };
const stamp = (t) => { const d = new Date(t); return `${dayLabel(t)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };

// opts: { bars: {t,o,h,l,c,exit}, live: {t,o,h,l,c} | null, step, xEnd, entry: {t, v}, exitNext,
//         levels: [{label, v, color, dash}], price, horizon, yFmt, height, ariaLabel, labels: {...} }
export function candleChart(root, opts) {
  const state = { opts };
  root.replaceChildren();
  root.classList.add("chart");
  const plot = h("div", "chart-plot");
  const tip = h("div", "chart-tip");
  tip.hidden = true;
  plot.appendChild(tip);
  root.append(plot);

  function candles() {
    const b = state.opts.bars;
    const out = b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], exit: b.exit[i], live: false }));
    if (state.opts.live) out.push({ ...state.opts.live, exit: state.opts.exitNext, live: true });
    return out.filter((k) => isNum(k.o) && isNum(k.h) && isNum(k.l) && isNum(k.c));
  }

  function draw() {
    plot.querySelectorAll("svg").forEach((n) => n.remove());
    const o = state.opts;
    const ks = candles();
    if (!ks.length) return;
    const W = Math.max(plot.clientWidth, 300);
    const H = o.height || 260;
    const wide = W >= 520;
    // right-edge labels first: their length sets the right margin (monospace, ~7.6 px a character)
    const L = o.labels || {};
    const lab = [];
    if (isNum(o.price)) lab.push({ v: o.price, text: `${L.price || "PRIX"} ${o.yFmt(o.price)}`, color: "--text-primary", box: true });
    if (isNum(o.exitNext)) lab.push({ v: o.exitNext, text: `${L.exit || "OBJECTIF"} ${o.yFmt(o.exitNext)}`, color: "--series-2" });
    if (isNum(o.entry?.v)) lab.push({ v: o.entry.v, text: `${L.entry || "ACHAT"} ${o.yFmt(o.entry.v)}`, color: "--amber" });
    for (const lv of o.levels || []) if (isNum(lv.v)) lab.push({ v: lv.v, text: `${wide ? lv.label : lv.short || lv.label} ${o.yFmt(lv.v)}`, color: lv.color });
    const longest = Math.max(8, ...lab.map((a) => a.text.length));
    const M = { l: 6, r: Math.min(Math.round(W * 0.42), Math.ceil(longest * 7.6) + 16), t: 8, b: 24 };
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    const step = o.step;
    const t0 = ks[0].t, t1 = Math.max(o.xEnd || 0, ks[ks.length - 1].t + step);
    const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * pw;

    let y0 = Infinity, y1 = -Infinity;
    const take = (v) => { if (isNum(v) && v > 0) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); } };
    for (const k of ks) { take(k.l); take(k.h); }
    take(o.entry?.v); take(o.exitNext); take(o.price);
    for (const lv of o.levels || []) take(lv.v);
    if (!isFinite(y0)) return;
    const padY = (y1 - y0) * 0.05 || y1 * 0.01;
    const Y0 = y0 - padY, Y1 = y1 + padY;
    const Y = (v) => M.t + (1 - (v - Y0) / (Y1 - Y0 || 1)) * ph;

    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
                            "aria-label": o.ariaLabel || "graphique" });
    plot.insertBefore(svg, tip);
    const ink = { grid: css("--grid"), axis: css("--axis"), muted: css("--text-muted"), surface: css("--surface-1"),
                  good: css("--good"), bad: css("--bad"), amber: css("--amber"), exit: css("--series-2"),
                  text: css("--text-primary"), band: css("--band") };

    // grid, price ticks on the right
    const stepY = niceStep(Y1 - Y0, Math.max(3, Math.floor(ph / 48)));
    for (let v = Math.ceil(Y0 / stepY) * stepY; v <= Y1; v += stepY) {
      el("line", { x1: M.l, x2: M.l + pw, y1: Y(v), y2: Y(v), stroke: ink.grid, "stroke-width": 1 }, svg);
    }
    el("line", { x1: M.l, x2: M.l + pw, y1: M.t + ph, y2: M.t + ph, stroke: ink.axis, "stroke-width": 1 }, svg);
    // day ticks (00:00 UTC)
    const dayMs = 864e5;
    const every = Math.max(1, Math.ceil((t1 - t0) / dayMs / Math.max(2, Math.floor(pw / 64))));
    for (let t = Math.ceil(t0 / dayMs) * dayMs, i = 0; t <= t1; t += dayMs, i++) {
      if (i % every) continue;
      el("line", { x1: X(t), x2: X(t), y1: M.t, y2: M.t + ph, stroke: ink.grid, "stroke-width": 1 }, svg);
      const tx = el("text", { x: X(t), y: H - 7, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = dayLabel(t);
    }
    // the time still to come, up to the forced exit
    const nowT = Date.now();
    if (nowT < t1) {
      const a = Math.max(t0, nowT);
      el("rect", { x: X(a), y: M.t, width: Math.max(0, X(t1) - X(a)), height: ph, fill: ink.band }, svg);
    }
    if (isNum(o.horizon) && o.horizon >= t0 && o.horizon <= t1) {
      el("line", { x1: X(o.horizon), x2: X(o.horizon), y1: M.t, y2: M.t + ph, stroke: ink.muted, "stroke-width": 1,
                   "stroke-dasharray": "4 3" }, svg);
      const tx = el("text", { x: X(o.horizon) - 4, y: M.t + 12, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = o.labels?.horizon || "vente forcée";
    }

    const fromX = isNum(o.entry?.t) ? X(o.entry.t) : M.l;
    // backtest dip levels and the entry price, from the entry to the forced exit
    for (const lv of o.levels || []) {
      if (!isNum(lv.v)) continue;
      el("line", { x1: fromX, x2: M.l + pw, y1: Y(lv.v), y2: Y(lv.v), stroke: css(lv.color), "stroke-width": 1.5,
                   "stroke-dasharray": lv.dash || "5 4" }, svg);
    }
    if (isNum(o.entry?.v)) {
      el("line", { x1: fromX, x2: M.l + pw, y1: Y(o.entry.v), y2: Y(o.entry.v), stroke: ink.amber, "stroke-width": 1,
                   "stroke-dasharray": "2 3" }, svg);
    }
    // exit line over the bars, then the level for the bar in progress up to the forced exit
    const ex = ks.filter((k) => isNum(k.exit) && !k.live);
    if (ex.length > 1) {
      const d = ex.map((k, i) => `${i ? "L" : "M"}${X(k.t + step / 2).toFixed(1)},${Y(k.exit).toFixed(1)}`).join("");
      el("path", { d, fill: "none", stroke: ink.exit, "stroke-width": 1.5, "stroke-linejoin": "round" }, svg);
    }
    if (isNum(o.exitNext)) {
      const last = ks[ks.length - 1];
      el("line", { x1: X(last.t), x2: M.l + pw, y1: Y(o.exitNext), y2: Y(o.exitNext), stroke: ink.exit, "stroke-width": 1.5,
                   "stroke-dasharray": "6 3" }, svg);
    }
    // candles
    const bw = Math.max(1.5, Math.min(14, ((step / (t1 - t0)) * pw) * 0.64));
    for (const k of ks) {
      const x = X(k.t + step / 2);
      const up = k.c >= k.o;
      const col = k.live ? ink.amber : up ? ink.good : ink.bad;
      el("line", { x1: x, x2: x, y1: Y(k.h), y2: Y(k.l), stroke: col, "stroke-width": 1 }, svg);
      const top = Y(Math.max(k.o, k.c)), bot = Y(Math.min(k.o, k.c));
      el("rect", { x: x - bw / 2, y: top, width: bw, height: Math.max(1, bot - top),
                   fill: k.live ? "none" : col, stroke: col, "stroke-width": k.live ? 1.5 : 0,
                   "stroke-dasharray": k.live ? "2 2" : "none" }, svg);
    }
    // live price
    if (isNum(o.price)) {
      el("line", { x1: M.l, x2: M.l + pw, y1: Y(o.price), y2: Y(o.price), stroke: ink.text, "stroke-width": 1,
                   "stroke-opacity": 0.55 }, svg);
    }
    // entry dot
    if (isNum(o.entry?.t) && isNum(o.entry?.v)) {
      el("circle", { cx: X(o.entry.t + step / 2), cy: Y(o.entry.v), r: 5.5, fill: ink.amber, stroke: ink.surface,
                     "stroke-width": 2 }, svg);
    }

    // right-edge labels, nudged apart so none overlap
    lab.forEach((a) => { a.y = Y(a.v); a.color = css(a.color); });
    lab.sort((a, b) => a.y - b.y);
    const gap = 13;
    for (let i = 1; i < lab.length; i++) if (lab[i].y - lab[i - 1].y < gap) lab[i].y = lab[i - 1].y + gap;
    const over = lab.length ? lab[lab.length - 1].y - (M.t + ph) : 0;
    if (over > 0) for (let i = lab.length - 1; i >= 0; i--) {
      lab[i].y -= over;
      if (i > 0 && lab[i].y - lab[i - 1].y < gap) lab[i - 1].y = lab[i].y - gap; else break;
    }
    const lx = M.l + pw + 6;
    for (const a of lab) {
      el("line", { x1: M.l + pw, x2: lx, y1: Y(a.v), y2: a.y, stroke: a.color, "stroke-width": 1 }, svg);
      if (a.box) el("rect", { x: lx, y: a.y - 8, width: M.r - 8, height: 15, fill: a.color, "fill-opacity": 0.16 }, svg);
      const tx = el("text", { x: lx + 3, y: a.y + 4, class: "end-label" }, svg);
      tx.style.setProperty("fill", a.color);   // the stylesheet's .end-label fill would win over an attribute
      tx.textContent = a.text;
    }

    // crosshair + tooltip with the candle under the pointer
    const cross = el("line", { y1: M.t, y2: M.t + ph, stroke: ink.muted, "stroke-width": 1, visibility: "hidden" }, svg);
    const hit = el("rect", { x: M.l, y: M.t, width: pw, height: ph, fill: "transparent" }, svg);
    const show = (t) => {
      let k = ks[0];
      for (const c of ks) if (Math.abs(c.t + step / 2 - t) < Math.abs(k.t + step / 2 - t)) k = c;
      const x = X(k.t + step / 2);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      tip.replaceChildren(h("div", "tip-date", `${stamp(k.t)} UTC${k.live ? " · en cours" : ""}`));
      const row = (label, v) => { const r = h("div", "tip-row"); r.append(h("strong", "", o.yFmt(v)), h("span", "tip-label", label)); tip.appendChild(r); };
      row("ouverture", k.o); row("plus haut", k.h); row("plus bas", k.l); row(k.live ? "dernier" : "clôture", k.c);
      if (isNum(k.exit)) row(L.exitTip || "objectif", k.exit);
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.setProperty("left", `${x + 14 + tw > W ? x - 14 - tw : x + 14}px`);
      tip.style.setProperty("top", `${M.t + 4}px`);
    };
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      show(t0 + ((e.clientX - r.left - M.l) / pw) * (t1 - t0));
    });
    hit.addEventListener("pointerleave", hide);
    svg.addEventListener("blur", hide);
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(plot);
  const onTheme = () => draw();
  document.addEventListener("themechange", onTheme);
  draw();
  return {
    update(next) { state.opts = { ...state.opts, ...next }; draw(); },
    destroy() { ro.disconnect(); document.removeEventListener("themechange", onTheme); },
  };
}
