// Resolve a source id (a chip in the UI) to the raw record it points at.
// If an id cannot be resolved here, the analysis has invented it: a test walks every id the engine emits.
import type { Bundle } from "./data.ts";
import { signalViewKey } from "./analysis/detect.ts";
import { MORNING_NOTES } from "./hints.ts";
import { parseCsv } from "./analysis/util.ts";
import { overlaySignalRecords } from "./analysis/inline.ts";

export interface Resolved {
  id: string;
  kind: "fact" | "file" | "opportunity" | "offer" | "stakeholder" | "record" | "row" | "signal" | "account" | "export" | "note";
  title: string;
  /** the raw thing: JSON or text */
  content: unknown;
  /** set when the source exists but has not been fetched yet */
  pending?: boolean;
}

export function resolveSource(b: Bundle, id: string): Resolved | null {
  const exp = b.accounts?.data;
  if (id === "notes:morning") return { id, kind: "note", title: "Your morning notes (hints, not evidence)", content: MORNING_NOTES };
  if (id === "export:exported_at" && exp) return { id, kind: "export", title: "Discovery export timestamp", content: { exported_at: exp.exported_at, minute: exp.minute, world_closed: exp.world_closed } };
  if (id.startsWith("signal:")) {
    const key = id.slice(7);
    const sig = b.signals.find((s) => signalViewKey(s) === key);
    return sig ? { id, kind: "signal", title: `Live event ${key}`, content: sig } : null;
  }
  if (exp) {
    for (const a of exp.accounts) {
      if (a.id === id) return { id, kind: "account", title: a.name, content: { id: a.id, name: a.name, official_story: a.official_story, stakeholders: a.stakeholders, deadlines: a.deadlines } };
      const fact = a.facts.find((f) => f.id === id);
      if (fact) return { id, kind: "fact", title: `${fact.said_by} (${fact.status})`, content: fact };
      const opp = a.opportunities.find((o) => o.id === id);
      if (opp) return { id, kind: "opportunity", title: opp.title, content: opp };
      const offer = (a.offers ?? []).find((o) => o.id === id);
      if (offer) return { id, kind: "offer", title: offer.title, content: offer };
      const st = a.stakeholders.find((s) => s.id === id);
      if (st) return { id, kind: "stakeholder", title: `${st.name}, ${st.role}`, content: st };
    }
    const ref = exp.files.find((f) => f.id === id);
    if (ref) return b.files[id] !== undefined
      ? { id, kind: "file", title: ref.title, content: b.files[id] }
      : { id, kind: "file", title: ref.title, content: ref, pending: true };
  }
  const m = /^([A-Za-z0-9]+):([^#]+)(?:#(.+))?$/.exec(id);
  const pw = m ? overlaySignalRecords(b.paperwork, b.signals) : b.paperwork;
  if (m && pw[m[1]]) {
    const [, account, path, anchor] = m;
    const rec = pw[account].find((r) => r.path === path);
    if (!rec) return null;
    const whole = { id, kind: "record" as const, title: `${account}: ${path}`, content: rec.text ?? rec.data };
    if (!anchor) return whole;
    const data: any = rec.data ?? (rec.text && /^\s*[{[]/.test(rec.text) ? safeJson(rec.text) : undefined);
    const row = pickRow(path, anchor, data, rec.text);
    return { id, kind: "row", title: `${account}: ${path} → ${anchor}`, content: row ?? whole.content };
  }
  return null;
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };

function pickRow(path: string, anchor: string, data: any, text?: string): unknown {
  if (path === "tickets.json") return data?.tickets?.find((t: any) => t.id === anchor);
  if (path === "calls_index.json") return data?.calls?.find((c: any) => c.date === anchor);
  if (path === "mail_log.json") return data?.mail?.filter((x: any) => x.thread === anchor);
  if (path === "invoices.json") return data?.invoices?.find((i: any) => i.number === anchor);
  if (path === "deal_history.json") return [...(data?.history ?? []), ...(data?.on_file_as_open_at_handover ?? [])].filter((h: any) => String(h.what).toLowerCase().startsWith(anchor.toLowerCase().slice(0, 12)));
  if (path === "requests.csv" && text) {
    const rows = parseCsv(text);
    return rows.find((r) => r.request_id === anchor || `${r.opened}:${r.from}` === anchor);
  }
  return undefined;
}
