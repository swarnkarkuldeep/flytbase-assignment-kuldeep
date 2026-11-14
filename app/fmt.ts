// Tiny pure formatters shared by the UI.
export const DAY_MS = 86_400_000;
const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€", USD: "$" };

export const money = (n: number, cur: string) => `${SYMBOL[cur] ?? cur + " "}${Math.round(n).toLocaleString("en-GB")}`;

/** whole days from `from` (ISO time) to `to` (YYYY-MM-DD) */
export function daysFrom(from: string, to: string): number {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / DAY_MS);
}

export function ago(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Insp. Karen Mbeki" -> "KM" */
export function initials(name: string): string {
  const w = name.replace(/\(.*?\)/g, "").replace(/^(Insp\.|Dr\.|Mr\.|Ms\.)\s*/i, "").trim().split(/\s+/);
  return ((w[0]?.[0] ?? "?") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}

/** relationship as a standing level 1..4 */
export const LEVEL: Record<string, number> = { guarded: 1, neutral: 2, warm: 3, ally: 4 };

/** "who" strings look like "Name (Role)"; split them */
export function splitWho(who: string): { name: string; role: string | null } {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(who);
  return m ? { name: m[1], role: m[2] } : { name: who, role: null };
}
