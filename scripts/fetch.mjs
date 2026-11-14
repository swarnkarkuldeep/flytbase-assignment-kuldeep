// Local snapshot fetcher. One MCP call per 61s (token is rate-limited to 1/min, writes included).
// Usage: node scripts/fetch.mjs [--force] [tool ...]
//   no tool args  -> run the default plan below, skipping anything already in ./snapshot
//   --force       -> re-fetch even if the snapshot file exists
// Token is read from AQ_TOKEN (env or .env.local). It is never printed.
import fs from "node:fs";
import path from "node:path";

try { process.loadEnvFile(".env.local"); } catch { /* fall back to real env */ }
const TOKEN = process.env.AQ_TOKEN;
if (!TOKEN) { console.error("AQ_TOKEN missing. Put it in .env.local (AQ_TOKEN=...)."); process.exit(1); }

const MCP = "https://questathon.aihackerscollective.com/api/public/mcp";
const OUT = path.resolve("snapshot");
fs.mkdirSync(OUT, { recursive: true });

async function callTool(name, args = {}) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { // SSE framing fallback: "data: {...}"
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`HTTP ${res.status}: unparseable response: ${text.slice(0, 200)}`);
    body = JSON.parse(line.slice(5));
  }
  const { result, error } = body;
  if (error || result?.isError) throw new Error(error?.message ?? result.content?.[0]?.text ?? "unknown MCP error");
  const t = result.content[0].text;
  try { return JSON.parse(t); } catch { return t; }
}

const PLAN = [
  ["whoami", {}],
  ["get_data_format", {}],
  ["get_my_accounts", {}],
  ["get_all_paperwork", { account: "A" }],
  ["get_all_paperwork", { account: "B" }],
  ["get_flytbase_team", {}],
  ["get_signals", {}],
];

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const only = argv.filter((a) => !a.startsWith("--"));
const plan = only.length ? PLAN.filter(([n]) => only.includes(n)) : PLAN;

const fileFor = (name, args) => path.join(OUT, `${name}${args.account ? "." + args.account : ""}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
for (const [name, args] of plan) {
  const file = fileFor(name, args);
  if (!force && fs.existsSync(file)) { console.log(`skip ${path.basename(file)} (exists)`); continue; }
  if (calls > 0) { console.log("waiting 61s (rate limit)..."); await sleep(61_000); }
  console.log(`call ${name} ${JSON.stringify(args)}`);
  let data;
  try { data = await callTool(name, args); }
  catch (e) {
    if (/fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(String(e.message) + String(e.cause))) {
      console.log("network error, retrying in 5s");
      await sleep(5000);
      data = await callTool(name, args);
    } else if (/rate|too many|429|limit/i.test(String(e.message))) {
      console.log(`rate-limited (${e.message}); waiting 65s and retrying once`);
      await sleep(65_000);
      data = await callTool(name, args);
    } else throw e;
  }
  calls++;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`saved ${path.relative(process.cwd(), file)} (${fs.statSync(file).size} bytes)`);
}
console.log("done");
