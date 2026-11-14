// Redis-backed store (Upstash) with an in-memory fallback for local dev.
// Serverless has no memory between requests, so everything that matters lives here.
import { Redis } from "@upstash/redis";

export interface Store {
  kind: "upstash" | "memory";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  /** SET NX with expiry. Returns an owner token if acquired, else null. */
  lock(key: string, ttlSec: number): Promise<string | null>;
  unlock(key: string, token: string): Promise<void>;
}

const P = "aq:";

class UpstashStore implements Store {
  kind = "upstash" as const;
  r: Redis;
  constructor(r: Redis) {
    this.r = r;
  }
  async get<T>(key: string) {
    return (await this.r.get<T>(P + key)) ?? null;
  }
  async set(key: string, value: unknown) {
    await this.r.set(P + key, value);
  }
  async keys(prefix: string) {
    const out: string[] = [];
    let cursor: string | number = 0;
    do {
      const res: [string | number, string[]] = await this.r.scan(cursor, { match: `${P}${prefix}*`, count: 200 });
      out.push(...res[1].map((k) => k.slice(P.length)));
      cursor = res[0];
    } while (String(cursor) !== "0");
    return out;
  }
  async lock(key: string, ttlSec: number) {
    const token = crypto.randomUUID();
    const ok = await this.r.set(P + key, token, { nx: true, ex: ttlSec });
    return ok === "OK" ? token : null;
  }
  async unlock(key: string, token: string) {
    if ((await this.r.get<string>(P + key)) === token) await this.r.del(P + key);
  }
}

export class MemoryStore implements Store {
  kind = "memory" as const;
  data = new Map<string, unknown>();
  locks = new Map<string, { token: string; exp: number }>();
  async get<T>(key: string) {
    return (this.data.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async keys(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
  async lock(key: string, ttlSec: number) {
    const cur = this.locks.get(key);
    if (cur && cur.exp > Date.now()) return null;
    const token = crypto.randomUUID();
    this.locks.set(key, { token, exp: Date.now() + ttlSec * 1000 });
    return token;
  }
  async unlock(key: string, token: string) {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
  }
}

const g = globalThis as unknown as { __aqStore?: Store; __aqSeeded?: boolean };

export async function getStore(): Promise<Store> {
  if (g.__aqStore) return g.__aqStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    g.__aqStore = new UpstashStore(new Redis({ url, token }));
  } else {
    g.__aqStore = new MemoryStore();
    await seedMemoryFromSnapshot(g.__aqStore);
  }
  return g.__aqStore;
}

/** Local dev only: preload the memory store from ./snapshot so no MCP calls are burned. */
async function seedMemoryFromSnapshot(store: Store) {
  if (g.__aqSeeded) return;
  g.__aqSeeded = true;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "snapshot");
    if (!fs.existsSync(dir)) return;
    const map: Record<string, string> = {
      "whoami.json": "whoami",
      "get_data_format.json": "format",
      "get_my_accounts.json": "accounts",
      "get_all_paperwork.A.json": "paperwork:A",
      "get_all_paperwork.B.json": "paperwork:B",
      "get_flytbase_team.json": "team",
      "get_signals.json": "signals",
    };
    const index: Record<string, string> = {};
    for (const [file, key] of Object.entries(map)) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      const at = fs.statSync(p).mtime.toISOString();
      await store.set(`data:${key}`, { at, data: JSON.parse(fs.readFileSync(p, "utf8")) });
      index[key] = at;
    }
    for (const f of fs.readdirSync(dir)) {
      const m = /^file.(.+).json$/.exec(f);
      if (!m) continue;
      const at = fs.statSync(path.join(dir, f)).mtime.toISOString();
      await store.set(`data:file:${m[1]}`, { at, data: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
      index[`file:${m[1]}`] = at;
    }
    await store.set("index", index);
  } catch {
    /* snapshot is optional */
  }
}
