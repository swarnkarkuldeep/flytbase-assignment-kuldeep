// Server-only. The token comes from the environment and is never logged or sent to the browser.
const MCP = process.env.AQ_MCP_URL ?? "https://questathon.aihackerscollective.com/api/public/mcp"; // override only for tests

export class RateLimitError extends Error {}

export async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.AQ_TOKEN;
  if (!token) throw new Error("AQ_TOKEN is not set");
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  const raw = await res.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`HTTP ${res.status}: unparseable MCP response`);
    body = JSON.parse(line.slice(5));
  }
  const { result, error } = body;
  if (error || result?.isError) {
    const msg: string = error?.message ?? result?.content?.[0]?.text ?? "unknown MCP error";
    if (res.status === 429 || /rate|too many|limit/i.test(msg)) throw new RateLimitError(msg);
    throw new Error(msg);
  }
  const text = result.content[0].text;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
