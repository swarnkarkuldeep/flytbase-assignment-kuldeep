// An account released after the morning comes from get_new_account, "in the same shape as get_my_accounts".
// Merge it into the discovery export so nothing downstream needs to know where an account came from.
import type { Export } from "../types.ts";

export function mergeDrops(base: Export, drops: { data: unknown; at: string }[]): Export {
  const seen = new Set(base.accounts.map((a) => a.id));
  const accounts = [...base.accounts];
  const files = [...base.files];
  for (const { data, at } of drops) {
    const d = data as (Partial<Export> & { id?: string }) | null;
    if (!d) continue;
    const list = Array.isArray(d.accounts) ? d.accounts : d.id ? [d as unknown as Export["accounts"][number]] : [];
    for (const a of list) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      // keep the clock of the export it came in: its `minute` fields only make sense against that
      accounts.push({ ...a, export_meta: { exported_at: d.exported_at ?? at, minute: d.minute ?? base.minute } });
      for (const f of d.files ?? []) files.push({ ...f, account: f.account ?? a.id });
    }
  }
  return { ...base, accounts, files };
}
