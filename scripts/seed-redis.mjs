// Push ./snapshot into Upstash so production starts with data and does not spend the
// token's one-call-a-minute budget on re-fetching it. Run once: node scripts/seed-redis.mjs
// Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (env or .env.local). Does not need AQ_TOKEN.
import fs from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

try { process.loadEnvFile(".env.local"); } catch {}
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) { console.error("Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local"); process.exit(1); }
const redis = new Redis({ url, token });

const dir = path.resolve("snapshot");
const MAP = {
  "whoami.json": "whoami",
  "get_data_format.json": "format",
  "get_my_accounts.json": "accounts",
  "get_all_paperwork.A.json": "paperwork:A",
  "get_all_paperwork.B.json": "paperwork:B",
  "get_flytbase_team.json": "team",
  "get_signals.json": "signals",
};
// get_file results saved as snapshot/file.<id>.json are picked up too.
for (const f of fs.readdirSync(dir)) { const m = /^file\.(.+)\.json$/.exec(f); if (m) MAP[f] = `file:${m[1]}`; }

if (!force()) {
  const existing = await redis.get("aq:index");
  if (existing && Object.keys(existing).length) {
    console.log("Redis already has data (aq:index). Re-run with --force to overwrite.");
    process.exit(0);
  }
}
const index = {};
for (const [file, key] of Object.entries(MAP)) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) { console.log(`skip ${file} (missing)`); continue; }
  const at = fs.statSync(p).mtime.toISOString();
  await redis.set(`aq:data:${key}`, { at, data: JSON.parse(fs.readFileSync(p, "utf8")) });
  index[key] = at;
  console.log(`seeded ${key}`);
}
await redis.set("aq:index", index);
console.log("done. keys:", Object.keys(index).join(", "));

function force() { return process.argv.includes("--force"); }
