// Number and date formatting, one place, so every page writes numbers the same way.

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export function pct(x, digits = 1, signed = true) {
  if (!isNum(x)) return "—";
  const s = (x * 100).toFixed(digits) + "%";
  return signed && x > 0 ? "+" + s : s.replace("-", "−");
}

export function num(x, digits = 2, signed = false) {
  if (!isNum(x)) return "—";
  const s = x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (signed && x > 0 ? "+" : "") + s.replace("-", "−");
}

export function money(x, digits = 2, signed = false) {
  return num(x, digits, signed);
}

export function price(x) {
  if (!isNum(x)) return "—";
  if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (x >= 1) return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x.toFixed(4);
}

export function compact(x) {
  if (!isNum(x)) return "—";
  const a = Math.abs(x);
  if (a >= 1e6) return (x / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (x / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
  if (a >= 1) return x.toFixed(a >= 10 ? 0 : 1);
  return x.toPrecision(2);
}

export function multiple(x) {
  if (!isNum(x)) return "—";
  return "×" + (x >= 100 ? compact(x) : x >= 10 ? x.toFixed(0) : x.toFixed(x >= 1 ? 1 : 2));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(t, style = "day") {
  const d = new Date(t);
  if (style === "year") return String(d.getUTCFullYear());
  if (style === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Signed values carry meaning through a class (good/bad), never through color alone:
// the sign and the words around the number say the same thing.
export function tone(x, goodIfPositive = true) {
  if (!isNum(x) || x === 0) return "neutral";
  return (x > 0) === goodIfPositive ? "good" : "bad";
}
