import { bundleFromSnapshot } from "../lib/analysis/snapshot.ts";
import { analyse } from "../lib/analysis/index.ts";
const b = bundleFromSnapshot();
if (process.env.SIGNAL) b.signals = [JSON.parse(process.env.SIGNAL)];
if (process.env.SIGNALS_FILE) b.signals = JSON.parse((await import("node:fs")).readFileSync(process.env.SIGNALS_FILE, "utf8"));
const a = analyse(b, new Date(process.env.NOW ?? "2026-11-14T10:00:00Z"));
console.log("ready", a.ready, a.missing);
const only = process.env.ONLY;
for (const acc of a.accounts) {
  if (only && acc.id !== only) continue;
  console.log(`\n================ ${acc.id} ${acc.name}  [${acc.facts.map((f) => f.label + ": " + f.value).join(" | ")}]`);
  console.log("\n-- Q4 risks");
  for (const r of acc.q4) console.log(`${r.overdue ? "OVERDUE" : "       "} sev${r.severity.toFixed(0)} ${r.turnsBadOn?.date ?? "no date "} ${r.turnsBadOn?.derived ? "(derived)" : "         "} ${r.title.slice(0, 100)}`);
  console.log("\n-- Q5 gaps");
  for (const g of acc.q5) console.log(`[${g.kind}] ${g.title.slice(0, 110)}\n      ask: ${g.whoCouldFill.map((w) => w.who.split(" (")[0]).join(", ") || "(nobody identified)"}`);
}
console.log("\nsignals:", a.signals.length);
if (process.env.MOVES) for (const acc of a.accounts) { if (only && acc.id !== only) continue; console.log(`\n== ${acc.id} clock ${acc.clock.world} shifted=${acc.clock.shifted}`); for (const m of acc.q3.top) console.log(`#${m.rank} ${m.score.total} ${m.title}\n    due ${m.due} | deals: ${m.dealTitles.join("; ")} | inside: ${m.insideDeadlines.map((d) => d.label + " " + d.date).join(" | ")}\n    sources: ${m.sources.slice(0, 6).join(", ")}`); }
