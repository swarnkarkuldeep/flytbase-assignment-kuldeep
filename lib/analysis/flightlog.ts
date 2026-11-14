// Cleans the force-by-month usage file (messy: force names and month formats vary, rows are re-sent).
import { parseCsv } from "./util.ts";

export interface ForceMonth {
  force: string;
  month: string; // YYYY-MM
  docksInstalled: number | null;
  docksLive: number | null;
  liveMissions: number | null;
  trainingFlights: number | null;
  notes: string;
}

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseMonth(s: string): string | null {
  s = s.trim();
  let m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^([A-Za-z]{3})[a-z]*[ \-](\d{2,4})$/.exec(s);
  if (m) {
    const mi = MON.indexOf(m[1].toLowerCase());
    if (mi >= 0) return `${m[2].length === 2 ? "20" + m[2] : m[2]}-${String(mi + 1).padStart(2, "0")}`;
  }
  return null;
}

/** Canonical force for a raw label, by the first four letters of the canonical name. */
export function canonicalForce(raw: string, forces: string[]): string | null {
  const r = raw.trim().toLowerCase();
  for (const f of forces) if (r.startsWith(f.toLowerCase().slice(0, 4))) return f;
  return null;
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export interface FlightLogResult {
  rows: ForceMonth[];
  /** rows dropped, with why, so nothing disappears silently */
  dropped: { raw: string; reason: string }[];
}

export function cleanForceMonthLog(csvText: string, forces: string[]): FlightLogResult {
  const dropped: FlightLogResult["dropped"] = [];
  const parsed: ForceMonth[] = [];
  for (const r of parseCsv(csvText)) {
    const force = canonicalForce(r.force ?? "", forces);
    const month = parseMonth(r.month ?? "");
    const raw = JSON.stringify(r);
    if (!force || !month) { dropped.push({ raw, reason: "unrecognised force or month" }); continue; }
    parsed.push({
      force, month,
      docksInstalled: num(r.docks_installed ?? ""), docksLive: num(r.docks_with_live_flights ?? ""),
      liveMissions: num(r.live_missions ?? ""), trainingFlights: num(r.training_flights ?? ""),
      notes: r.notes ?? "",
    });
  }
  const byKey = new Map<string, ForceMonth[]>();
  for (const p of parsed) byKey.set(`${p.force}|${p.month}`, [...(byKey.get(`${p.force}|${p.month}`) ?? []), p]);
  const rows: ForceMonth[] = [];
  for (const group of byKey.values()) {
    const complete = group.filter((g) => g.docksLive !== null);
    const keep = complete.length ? complete : group;
    for (const g of group) if (!keep.includes(g)) dropped.push({ raw: JSON.stringify(g), reason: "re-sent row with blank counts" });
    const seen = new Set<string>();
    for (const g of keep) {
      const k = JSON.stringify([g.docksInstalled, g.docksLive, g.liveMissions, g.trainingFlights]);
      if (seen.has(k)) { dropped.push({ raw: JSON.stringify(g), reason: "identical duplicate row" }); continue; }
      seen.add(k);
      rows.push(g);
    }
  }
  rows.sort((a, b) => (a.force === b.force ? a.month.localeCompare(b.month) : a.force.localeCompare(b.force)));
  return { rows, dropped };
}
