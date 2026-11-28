// A small SVG time-series chart, built to the house data-viz rules:
// 2px lines, 10% area washes, hairline solid grid, one y-axis, crosshair + one tooltip
// listing every series, legend for >= 2 series plus sparing end labels, a table twin.
// Colors are read from CSS custom properties at draw time, so a theme switch redraws.

import { date, isNum } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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

function linearTicks(lo, hi, target = 5) {
  const step = niceStep(hi - lo || 1, target);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

function logTicks(lo, hi) {
  const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
  for (const ms of [[1, 2, 5], [1, 3], [1]]) {
    const t = [];
    for (let e = a; e <= b; e++) for (const m of ms) { const v = m * 10 ** e; if (v >= lo && v <= hi) t.push(v); }
    if (t.length <= 6) return t.length >= 2 ? t : [lo, hi];
  }
  const t = [];
  for (let e = a; e <= b; e++) { const v = 10 ** e; if (v >= lo && v <= hi) t.push(v); }
  const stride = Math.ceil(t.length / 6);
  return t.filter((_, i) => i % stride === 0);
}

function timeTicks(t0, t1, width) {
  const years = (t1 - t0) / (365.25 * 864e5);
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const out = [];
  const d = new Date(t0);
  if (years > 2.5) {
    let step = 1;
    while (years / step > maxTicks) step++;
    for (let y = d.getUTCFullYear() + 1; ; y += step) {
      const t = Date.UTC(y, 0, 1);
      if (t > t1) break;
      if (t >= t0) out.push({ t, label: String(y) });
    }
    return out;
  }
  let step = 1;
  const months = years * 12;
  while (months / step > maxTicks) step = step === 1 ? 2 : step === 2 ? 3 : step === 3 ? 6 : 12;
  for (let m = d.getUTCMonth() + 1, y = d.getUTCFullYear(); ; m += step) {
    const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1);
    if (t > t1) break;
    if (t >= t0) out.push({ t, label: date(t, "month") });
  }
  return out;
}

function bisect(ts, t) {
  let lo = 0, hi = ts.length - 1;
  if (t <= ts[0]) return 0;
  if (t >= ts[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  return t - ts[lo] < ts[hi] - t ? lo : hi;
}

// Keep the extremes when there are more points than pixels: min and max per bucket.
function downsample(ts, vs, i0, i1, buckets) {
  const n = i1 - i0 + 1;
  if (n <= buckets * 2) return Array.from({ length: n }, (_, k) => [ts[i0 + k], vs[i0 + k]]);
  const out = [];
  const size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = i0 + Math.floor(b * size), z = Math.min(i1, i0 + Math.floor((b + 1) * size) - 1);
    let lo = a, hi = a;
    for (let i = a; i <= z; i++) {
      if (!isNum(vs[i])) continue;
      if (!isNum(vs[lo]) || vs[i] < vs[lo]) lo = i;
      if (!isNum(vs[hi]) || vs[i] > vs[hi]) hi = i;
    }
    for (const i of lo <= hi ? [lo, hi] : [hi, lo]) out.push([ts[i], vs[i]]);
  }
  return out;
}

export function lineChart(root, opts) {
  const state = { opts, hover: null };
  root.replaceChildren();
  root.classList.add("chart");
  const legend = h("div", "chart-legend");
  const plot = h("div", "chart-plot");
  const tip = h("div", "chart-tip");
  tip.hidden = true;
  plot.appendChild(tip);
  const tools = h("div", "chart-tools");
  const tableBtn = h("button", "link", "Show as table");
  tableBtn.type = "button";
  tools.appendChild(tableBtn);
  const tableWrap = h("div", "chart-table");
  tableWrap.hidden = true;
  root.append(legend, plot, tools, tableWrap);

  tableBtn.addEventListener("click", () => {
    tableWrap.hidden = !tableWrap.hidden;
    tableBtn.textContent = tableWrap.hidden ? "Show as table" : "Hide table";
    if (!tableWrap.hidden) renderTable();
  });

  function visible() { return state.opts.series.filter((s) => s.visible !== false); }

  function renderLegend() {
    legend.replaceChildren();
    const series = state.opts.series;
    if (series.length < 2 && !state.opts.markers?.length) return;
    for (const s of series) {
      const b = h("button", "legend-item");
      b.type = "button";
      b.setAttribute("aria-pressed", String(s.visible !== false));
      const key = h("span", "key-line");
      key.style.setProperty("--key", css(s.color));
      b.append(key, h("span", "", s.label));
      b.addEventListener("click", () => {
        const on = visible();
        if (s.visible !== false && on.length === 1) return; // keep one series on screen
        s.visible = s.visible === false;
        draw();
      });
      legend.appendChild(b);
    }
    for (const m of state.opts.markerLegend || []) {
      const item = h("span", "legend-item static");
      const key = h("span", `key-tri ${m.shape}`);
      key.style.setProperty("--key", css(m.color));
      item.append(key, h("span", "", m.label));
      legend.appendChild(item);
    }
  }

  function renderTable() {
    const vis = visible();
    const base = vis[0];
    const rows = [];
    let lastMonth = -1;
    for (let i = 0; i < base.t.length; i++) {
      const d = new Date(base.t[i]);
      const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const stepMonths = base.t.length > 1500 ? 3 : 1;
      if (key !== lastMonth && key % stepMonths === 0) { rows.push(i); lastMonth = key; }
    }
    if (rows[rows.length - 1] !== base.t.length - 1) rows.push(base.t.length - 1);
    const table = h("table", "data");
    const head = h("tr");
    head.appendChild(h("th", "", "Date"));
    for (const s of vis) head.appendChild(h("th", "num", s.label));
    table.appendChild(h("thead")).appendChild(head);
    const body = h("tbody");
    for (const i of rows) {
      const tr = h("tr");
      tr.appendChild(h("td", "", date(base.t[i])));
      for (const s of vis) {
        const j = bisect(s.t, base.t[i]);
        tr.appendChild(h("td", "num", state.opts.yFmt(s.v[j])));
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    tableWrap.replaceChildren(table);
  }

  function draw() {
    renderLegend();
    plot.querySelectorAll("svg").forEach((n) => n.remove());
    const o = state.opts;
    const W = Math.max(plot.clientWidth, 320);
    const H = o.height || 280;
    const vis = visible();
    const ends = o.endLabels !== false && vis.length >= 2 && vis.length <= 4 && W >= 560;
    const M = { l: W < 560 ? 46 : 58, r: ends ? 132 : 12, t: 10, b: 28 };
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    let t0 = o.xDomain ? o.xDomain[0] : Infinity, t1 = o.xDomain ? o.xDomain[1] : -Infinity;
    if (!o.xDomain) for (const s of vis) { t0 = Math.min(t0, s.t[0]); t1 = Math.max(t1, s.t[s.t.length - 1]); }
    let y0 = Infinity, y1 = -Infinity;
    const ranges = vis.map((s) => {
      const i0 = bisect(s.t, t0), i1 = bisect(s.t, t1);
      for (let i = i0; i <= i1; i++) {
        const v = s.v[i];
        if (!isNum(v) || (o.y === "log" && v <= 0)) continue;
        y0 = Math.min(y0, v); y1 = Math.max(y1, v);
      }
      return [i0, i1];
    });
    if (o.yDomain) [y0, y1] = o.yDomain;
    if (o.includeZero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    if (y0 === y1) { y1 = y0 + 1; }
    const log = o.y === "log";
    const ly0 = log ? Math.log10(y0) : y0, ly1 = log ? Math.log10(y1) : y1;
    const pad = (ly1 - ly0) * 0.04;
    const Y0 = o.yDomain ? ly0 : ly0 - pad, Y1 = o.yDomain ? ly1 : ly1 + pad;
    const X = (t) => M.l + ((t - t0) / (t1 - t0 || 1)) * pw;
    const Y = (v) => M.t + (1 - ((log ? Math.log10(v) : v) - Y0) / (Y1 - Y0 || 1)) * ph;

    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
                            "aria-label": o.ariaLabel || "chart" });
    plot.insertBefore(svg, tip);
    const ink = { grid: css("--grid"), axis: css("--axis"), muted: css("--text-muted"), surface: css("--surface-1"),
                  secondary: css("--text-secondary"), primary: css("--text-primary") };

    // grid + y ticks
    const yt = log ? logTicks(10 ** Y0, 10 ** Y1) : linearTicks(Y0, Y1, Math.max(3, Math.floor(ph / 55)));
    for (const v of yt) {
      const y = Y(v);
      if (y < M.t - 1 || y > M.t + ph + 1) continue;
      el("line", { x1: M.l, x2: M.l + pw, y1: y, y2: y, stroke: ink.grid, "stroke-width": 1 }, svg);
      const tx = el("text", { x: M.l - 8, y: y + 4, "text-anchor": "end", class: "tick" }, svg);
      tx.textContent = o.yTick ? o.yTick(v) : o.yFmt(v);
    }
    // baseline / zero line
    const baseY = o.includeZero ? Y(0) : M.t + ph;
    el("line", { x1: M.l, x2: M.l + pw, y1: baseY, y2: baseY, stroke: ink.axis, "stroke-width": 1 }, svg);
    for (const { t, label } of timeTicks(t0, t1, pw)) {
      const x = X(t);
      el("line", { x1: x, x2: x, y1: M.t + ph, y2: M.t + ph + 4, stroke: ink.axis }, svg);
      const tx = el("text", { x, y: H - 8, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = label;
    }
    // shaded periods (e.g. "unseen by the rule's authors")
    for (const band of o.bands || []) {
      const a = Math.max(t0, band.from), b = Math.min(t1, band.to ?? t1);
      if (b <= a) continue;
      el("rect", { x: X(a), y: M.t, width: X(b) - X(a), height: ph, fill: css("--band"), class: "band" }, svg);
      const tx = el("text", { x: X(a) + 6, y: M.t + 14, class: "band-label" }, svg);
      tx.textContent = band.label;
    }

    // series
    vis.forEach((s, k) => {
      const [i0, i1] = ranges[k];
      const pts = downsample(s.t, s.v, i0, i1, Math.ceil(pw)).filter(([, v]) => isNum(v) && (!log || v > 0));
      if (!pts.length) return;
      const color = css(s.color);
      const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      if (s.area) {
        const ay = o.includeZero ? Y(0) : M.t + ph;
        el("path", { d: `${d}L${X(pts[pts.length - 1][0]).toFixed(1)},${ay}L${X(pts[0][0]).toFixed(1)},${ay}Z`,
                     fill: color, "fill-opacity": 0.1, stroke: "none" }, svg);
      }
      el("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round",
                   "stroke-linecap": "round" }, svg);
    });

    // markers: triangles with a 2px surface ring
    for (const m of o.markers || []) {
      if (m.t < t0 || m.t > t1 || !isNum(m.v)) continue;
      const x = X(m.t), y = Y(m.v), r = 5;
      const p = m.shape === "up" ? `M${x},${y + r + 2}l${-r},${2 * r}h${2 * r}z` : `M${x},${y - r - 2}l${-r},${-2 * r}h${2 * r}z`;
      el("path", { d: p, fill: css(m.color), stroke: ink.surface, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
    }

    // end labels, only when they do not collide
    if (ends) {
      const lab = vis.map((s, k) => {
        const i = ranges[k][1];
        let j = i; while (j > 0 && !isNum(s.v[j])) j--;
        return { s, y: Y(s.v[j]), v: s.v[j] };
      }).sort((a, b) => a.y - b.y);
      const clear = lab.every((a, i) => i === 0 || a.y - lab[i - 1].y >= 15);
      if (clear) for (const { s, y, v } of lab) {
        el("line", { x1: M.l + pw + 6, x2: M.l + pw + 18, y1: y, y2: y, stroke: css(s.color), "stroke-width": 2,
                     "stroke-linecap": "round" }, svg);
        const tx = el("text", { x: M.l + pw + 24, y: y + 4, class: "end-label" }, svg);
        tx.textContent = `${o.yFmt(v)} ${s.short || ""}`.trim();
      }
    }

    // crosshair layer
    const cross = el("line", { y1: M.t, y2: M.t + ph, stroke: ink.muted, "stroke-width": 1, visibility: "hidden" }, svg);
    const dots = vis.map((s) => el("circle", { r: 4, fill: css(s.color), stroke: ink.surface, "stroke-width": 2,
                                               visibility: "hidden" }, svg));
    const hit = el("rect", { x: M.l, y: M.t, width: pw, height: ph, fill: "transparent" }, svg);
    const base = vis[0];
    const show = (t) => {
      const i = bisect(base.t, Math.min(Math.max(t, t0), t1));
      const tt = base.t[i];
      state.hover = tt;
      const x = X(tt);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      tip.replaceChildren(h("div", "tip-date", date(tt)));
      vis.forEach((s, k) => {
        const j = bisect(s.t, tt);
        const v = s.v[j];
        if (isNum(v) && (!log || v > 0)) {
          dots[k].setAttribute("cx", x); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible");
        } else dots[k].setAttribute("visibility", "hidden");
        const row = h("div", "tip-row");
        const key = h("span", "key-line");
        key.style.setProperty("--key", css(s.color));
        row.append(key, h("strong", "", o.yFmt(v)), h("span", "tip-label", s.label));
        tip.appendChild(row);
      });
      for (const m of o.markers || []) {
        if (Math.abs(m.t - tt) < 864e5 * 0.5) tip.appendChild(h("div", "tip-note", m.label));
      }
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.setProperty("left", `${x + 14 + tw > W ? x - 14 - tw : x + 14}px`);
      tip.style.setProperty("top", `${M.t + 4}px`);
    };
    const hide = () => {
      tip.hidden = true; cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    };
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      show(t0 + ((e.clientX - r.left - M.l) / pw) * (t1 - t0));
    });
    hit.addEventListener("pointerleave", hide);
    svg.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "Escape") return hide();
      const i = bisect(base.t, state.hover ?? t1);
      const step = Math.max(1, Math.round((bisect(base.t, t1) - bisect(base.t, t0)) / 60));
      show(base.t[Math.min(base.t.length - 1, Math.max(0, i + (e.key === "ArrowRight" ? step : -step)))]);
    });
    svg.addEventListener("blur", hide);
    if (!tableWrap.hidden) renderTable();
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

// A dot-and-interval row plot: an estimate with its 90% range, against a zero line.
export function intervalPlot(root, rows, { fmt, height = 34 }) {
  root.replaceChildren();
  root.classList.add("chart");
  const plot = h("div", "chart-plot");
  root.appendChild(plot);
  const draw = () => {
    plot.replaceChildren();
    const W = Math.max(plot.clientWidth, 300);
    const compactRows = W < 760;
    const rowH = compactRows ? 56 : height;
    const M = compactRows ? { l: 8, r: 8, t: 8, b: 24 } : { l: 250, r: 230, t: 8, b: 24 };
    const H = M.t + M.b + rows.length * rowH;
    let lo = 0, hi = 0;
    for (const r of rows) { lo = Math.min(lo, r.ci[0], r.value); hi = Math.max(hi, r.ci[1], r.value); }
    const pad = (hi - lo) * 0.05;
    lo -= pad; hi += pad;
    const X = (v) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
                            "aria-label": "estimate and 90% range for each strategy" });
    plot.appendChild(svg);
    for (const v of linearTicks(lo, hi, 5)) {
      el("line", { x1: X(v), x2: X(v), y1: M.t, y2: H - M.b, stroke: css("--grid") }, svg);
      const tx = el("text", { x: X(v), y: H - 6, "text-anchor": "middle", class: "tick" }, svg);
      tx.textContent = fmt(v);
    }
    el("line", { x1: X(0), x2: X(0), y1: M.t, y2: H - M.b, stroke: css("--axis"), "stroke-width": 1.5 }, svg);
    rows.forEach((r, i) => {
      const y = M.t + i * rowH + rowH / 2 + (compactRows ? 8 : 0);
      const name = el("text", compactRows ? { x: M.l, y: y - 14, class: "row-label" } : { x: 0, y: y + 4, class: "row-label" }, svg);
      name.textContent = r.label;
      const c = css(r.color);
      el("line", { x1: X(r.ci[0]), x2: X(r.ci[1]), y1: y, y2: y, stroke: c, "stroke-width": 2, "stroke-linecap": "round",
                   "stroke-opacity": 0.55 }, svg);
      el("circle", { cx: X(r.value), cy: y, r: 5, fill: c, stroke: css("--surface-1"), "stroke-width": 2 }, svg);
      const val = el("text", compactRows ? { x: W - M.r, y: y + 22, "text-anchor": "end", class: "row-value" }
                                          : { x: W - M.r + 12, y: y + 4, class: "row-value" }, svg);
      val.textContent = r.note;
    });
  };
  const ro = new ResizeObserver(draw);
  ro.observe(plot);
  document.addEventListener("themechange", draw);
  draw();
}
