// A live signal can carry the records it is about, inline: { records: [{ kind, path: "A/emails/x.txt", text }] }.
// Merge them into the account's paperwork so the rest of the engine (and the source drawer) sees them like any
// other record, with no MCP call. A CSV record flagged "Row to add to ..." is appended to the existing CSV.
import type { PaperRecord, Signal } from "../types.ts";
import { parseCsv } from "./util.ts";

export function overlaySignalRecords(paperwork: Record<string, PaperRecord[]>, signals: Signal[]): Record<string, PaperRecord[]> {
  const out: Record<string, PaperRecord[]> = Object.fromEntries(Object.entries(paperwork).map(([k, v]) => [k, [...v]]));
  for (const sig of signals) {
    const recs = (sig as { records?: unknown }).records;
    if (!Array.isArray(recs)) continue;
    for (const rec of recs as { kind?: string; path?: string; note?: string; text?: unknown }[]) {
      const m = /^([A-Za-z0-9_-]+)\/(.+)$/.exec(String(rec?.path ?? ""));
      if (!m || !out[m[1]] || typeof rec.text !== "string") continue;
      const [, account, path] = m;
      const list = out[account];
      const i = list.findIndex((r) => r.path === path);
      if (i >= 0 && path.endsWith(".csv") && /row to add/i.test(String(rec.note ?? ""))) {
        const existing = list[i].text ?? "";
        const header = existing.split(/\r?\n/)[0];
        const firstCol = header.split(",")[0];
        const have = new Set(parseCsv(existing).map((r) => r[firstCol]));
        const add = rec.text.split(/\r?\n/).slice(1).filter(Boolean).filter((row) => {
          const parsed = parseCsv(`${header}\n${row}`)[0];
          return parsed && !have.has(parsed[firstCol]);
        });
        if (add.length) list[i] = { ...list[i], text: `${existing.trimEnd()}\n${add.join("\n")}\n` };
      } else if (i >= 0) {
        list[i] = { ...list[i], text: rec.text };
      } else {
        list.push({ path, kind: rec.kind ?? "record", text: rec.text });
      }
    }
  }
  return out;
}
