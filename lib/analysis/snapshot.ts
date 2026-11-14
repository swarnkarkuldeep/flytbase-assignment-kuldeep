// Node-only: build a Bundle from ./snapshot (used by tests and scripts, never by the app).
import fs from "node:fs";
import path from "node:path";
import type { Bundle } from "../data.ts";
import { normalizeSignals } from "../plan.ts";
import { overlaySignalRecords } from "./inline.ts";
import { mergeDrops } from "./drops.ts";

export function bundleFromSnapshot(dir = "snapshot"): Bundle {
  const rd = (f: string) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : null);
  const base = rd("get_my_accounts.json");
  // accounts released later: get_new_account.<id>.json
  const drops = fs.readdirSync(dir).filter((f) => /^get_new_account\.[^.]+\.json$/.test(f)).map((f) => ({ data: rd(f), at: "snapshot" }));
  const accounts = base && drops.length ? mergeDrops(base, drops) : base;
  const paperwork: Bundle["paperwork"] = {};
  for (const a of accounts?.accounts ?? []) paperwork[a.id] = rd(`get_all_paperwork.${a.id}.json`)?.records ?? [];
  const files: Record<string, unknown> = {};
  for (const f of fs.readdirSync(dir)) {
    const m = /^file\.(.+)\.json$/.exec(f);
    if (m) files[m[1]] = rd(f);
  }
  const sig = rd("get_signals.json");
  const env = <T,>(data: T | null) => (data ? { at: "snapshot", data } : null);
  return {
    whoami: env(rd("whoami.json")),
    accounts: env(accounts),
    team: rd("get_flytbase_team.json")?.people ?? [],
    signals: sig ? normalizeSignals(sig) : [],
    signalsAt: null,
    paperwork: overlaySignalRecords(paperwork, sig ? normalizeSignals(sig) : []),
    files,
    notes: null,
    index: {},
  };
}
