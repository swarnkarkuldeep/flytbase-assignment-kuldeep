// Small pure helpers shared by the analysis rules.

export const DAY = 86_400_000;

/** Parse YYYY-MM-DD (UTC midnight). */
export const ymd = (s: string) => new Date(`${s}T00:00:00Z`);
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY);

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "14 July 2026", "3 September 2026" -> Date. Null if not a full date. */
export function parseLongDate(s: string): Date | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  return new Date(Date.UTC(+m[3], mi, +m[1]));
}

/**
 * Find a date inside free text (e.g. a signal). Accepts ISO, "5 December 2026", and "5 Dec" / "18 Nov"
 * without a year (year taken from `ref`, rolling forward if that would be more than 60 days in the past).
 */
export function findDateInText(text: string, ref: Date): Date | null {
  const isoM = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoM) return ymd(isoM[0]);
  const full = parseLongDate(text);
  if (full) return full;
  const m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.exec(text);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  let d = new Date(Date.UTC(ref.getUTCFullYear(), mi, +m[1]));
  if (daysBetween(d, ref) > 60) d = new Date(Date.UTC(ref.getUTCFullYear() + 1, mi, +m[1]));
  return d;
}

/** Tiny CSV parser: handles quoted fields with commas and "" escapes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== "")) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };
export function money(n: number, cur: string): string {
  const s = SYMBOL[cur] ?? `${cur} `;
  return `${s}${Math.round(n).toLocaleString("en-GB")}`;
}

/** Possessive-free person name match: does `text` mention this stakeholder? */
export const mentions = (text: string, name: string) => {
  const n = name.replace(/^Insp\.\s*/i, "").toLowerCase();
  return text.toLowerCase().includes(n) || text.toLowerCase().includes(n.split(" ").pop()!.toLowerCase());
};

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
