# Account CRM

A live CRM for two customer accounts (drone-in-a-box docks). It reads one MCP API, and for each account answers five questions, with **every number citing the id of the record it came from**:

1. **What is the book worth?** Closed, backed-by-a-document, and unbacked money, kept apart. There is no single headline total.
2. **Who holds the power?** For each deal: who decides, pays, uses and could block, and where each person stands with us.
3. **What do you do first?** Three ranked moves, each with an owner, a due date inside every relevant deadline, and the deal it moves.
4. **What is about to go wrong?** Deadlines at risk, people going cold, stuck deals, unanswered asks, and the date each one turns bad.
5. **What do you still not know?** The gaps the plan rests on, why each matters, and who could fill it.

It is for a Customer Success Manager who inherits two accounts and needs to act on Monday. It picks up new events by itself and writes its top next steps and risks back to the MCP as notes.

Every figure is computed by plain rules in TypeScript. No model writes any of it.

## How it works

```
Browser ──every ~20s──> /api/sync ──> Redis lock ──> at most ONE MCP call per 61s ──> Redis
Browser <──────────────  /api/state <── Redis only (never calls the MCP) <── rules engine
Browser ── click a source tag ──> /api/source?id=… ──> the raw record or file
```

The MCP allows **one call per minute per token, writes included**, and a serverless function has no memory. So everything fetched is stored in Redis, and the browser only asks the server to make "the next queued call", which the server does if 61 seconds have passed.

**The sync queue** (`lib/plan.ts`, `lib/sync.ts`)

- Order: `whoami`, `get_data_format`, `get_my_accounts`, `get_all_paperwork` for each account, `get_flytbase_team`, `get_signals`. Then one `get_file` per file, then `list_notes`. After that it alternates `get_signals` and `whoami` forever.
- A Redis lock (`SET NX` with expiry) stops two polls double-calling. The call time is recorded **before** the call, so a crash or failed call still counts against the rate limit.
- `whoami` reports how many signals exist; if that differs from what is stored, `get_signals` jumps the queue.
- A live event looks like `{ id, account, dated, title, summary, records: [{ path: "A/emails/…", text }] }`. The records it carries are merged straight into the paperwork (`lib/analysis/inline.ts`), so no MCP call is needed to read them. If an event mentions a record that is not inline, that fetch is queued; a record that turns out not to exist is asked for once, not retried. An event about docks that stopped flying also queues a refresh of that account's usage data. The analysis then re-runs on its own, so Q3 and Q4 update with no reload or code change.
- **"Today"** is worked out per account: the later of the real clock and the latest live event about that account, because the scenario dates its events ahead of the real clock. Each account has its own timeline, so one account's event never ages another's deadlines. The page says so whenever an account's clock has moved.
- **Accounts released mid-build.** `whoami` lists a new account (`new_accounts`, and the pack). `get_my_accounts` never will, so its export comes from `get_new_account` (same shape) and its files from `get_new_account_file`; the queue fetches these on its own and merges the account in (`lib/analysis/drops.ts`). The page analyses whatever is ready and shows an account that is still arriving as "fetching", rather than blocking on it. An account's own deadlines carry a game-clock `minute`, which is turned into a real date (derived, with the rule shown).
- A jammed queue cannot starve live events: after two non-poll calls, a poll goes next.
- Failures: a job that fails three times is skipped for 15 minutes.

**Write-back** (`lib/notes.ts`)

After the analysis runs, each account's top three next steps (`kind: "next_step"`) and top three risks (`kind: "risk"`) are queued as `write_note` calls in the same rate-limited queue. Every note carries a `[crm:ref:…]` tag and the ids it rests on.

- Nothing is written twice: notes already in `list_notes`, or recorded as written, are skipped.
- A write that errors is never retried blindly (it may have landed). The queue re-reads `list_notes` first and only redoes the write if it is still missing.
- Planning runs when data changes and on a 5-minute timer. A note already waiting in the queue is never planned twice.
- **Kill switch.** Notes cannot be deleted from the MCP, so write-back can be paused without a redeploy: set the Redis key `aq:flag:writeback` to `off` (or set `AQ_WRITE_NOTES=0`). While paused, queued writes are dropped and the page says so. Delete the key, or set it to `on`, to resume.

## How it decides (the rules engine, `lib/analysis/`)

| Question | Rule, in short |
|---|---|
| Book | **Closed**: stage agreed or cleared, or an offer that is won. **Backed, not yet won**: the amount appears in a contract, invoice, profile or deal history we hold. **Unbacked**: open offers, projections whose amount is in no hard record, and claims. Spreadsheet gaps are computed, not copied. |
| Power | There is no decider or payer field in the data, so each seat is **derived** from roles, facts, the contract signatory and invoicing terms, labelled `derived` or `stated`, and shown with its fact ids. Where nobody is on file it says so. |
| First moves | `score = urgency × value × promise`. Urgency comes from the tightest dated deadline, or how long something we owe has waited (capped below a hard deadline). Value counts backed value fully and unbacked value at 10%, capped. Promise is 2 if we owe it on something we sold, 1.5 if we owe a reply, else 1. Due dates sit at least 7 days inside any deadline. |
| Risks | Unanswered inbound email, tickets with no owner, call follow-ups marked not done, idle docks (from `usage_weekly.csv`, `flights.csv`), usage by force (from the flight log file), contacts with no contact for 60 days, single-threaded relationships, and the renewal clock. Relative dates ("in five months") are turned into dates, labelled `derived`, with the rule shown. |
| Gaps | What the profile says is not on file, deciders and payers nobody named, deadlines with no date, records that disagree, facts resting on someone's word, and a named person who could fill each one. |

Your own notes about an account are kept separate (`lib/hints.ts`). They appear only under Q5, labelled "no record behind it", and never feed a number, rank or date.

**Source ids.** Every item carries ids: facts, files, deals, offers and people by their own id (`km_usage_1`, `a_renewal`), records by path (`A:calls/2026-10-20_check_in.txt`), rows inside a record by anchor (`A:tickets.json#FB-10412`), and live events as `signal:<key>`. A test walks every id the engine emits and fails if one cannot be resolved to a real record, which is how invented ids are caught.

## Run it

Needs Node 22.18 or newer (the tests run TypeScript directly).

```bash
npm install
cp .env.example .env.local      # then fill it in
```

| Variable | What it is |
|---|---|
| `AQ_TOKEN` | Your MCP bearer token. Server side only. |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `AQ_DRY=1` | Optional. Make no MCP calls (read what is already stored). |
| `AQ_WRITE_NOTES=0` | Optional. Do not write notes back. |

```bash
# optional: save the first seven calls locally (takes about 7 minutes; the MCP is rate limited)
node scripts/fetch.mjs

# load a local snapshot into Redis so a fresh deployment starts with data and spends no calls
npm run seed

npm run dev          # http://localhost:3000
npm test             # unit and end-to-end tests (some need the local snapshot and skip without it)
npm run typecheck
npm run build
```

With no Redis variables set, the app uses an in-memory store and preloads `./snapshot` if it exists, so local development does not spend MCP calls.

### Deploy on Vercel

1. Import this repository in Vercel.
2. Add the three environment variables above.
3. Run `npm run seed` once locally (it only needs the two Upstash variables) so the deployment starts with data.
4. Open the site. The first visitor's browser starts the polling.

## No token in the code

The token is read from `process.env.AQ_TOKEN` in one server-only file (`lib/mcp.ts`). It never reaches browser code, is never logged, and is not stored in Redis or returned by any route. `.env*` is git-ignored (only `.env.example` with empty values is tracked), as is the local `snapshot/` folder. A test asserts that the token never appears in stored data or in the sync status.

## Layout

```
app/            UI (Next.js App Router) and the three API routes: sync, state, source
lib/mcp.ts      the only code that calls the MCP
lib/plan.ts     pure queue planning: job order, signal and whoami reactions
lib/sync.ts     the rate-limited runner: lock, one call per 61s, write-back hooks
lib/store.ts    Upstash Redis, with an in-memory fallback for local dev
lib/analysis/   the rules engine: book, power, moves, risks, gaps (+ detectors)
lib/notes.ts    write-back planning and dedupe
lib/sources.ts  resolves a source id to its raw record
scripts/        fetch.mjs (local snapshot), seed-redis.mjs, probe-all.ts (print the analysis)
tests/          planner, sync queue, analysis invariants, write-back
```

## What it does not do yet

- A live event with no `account` field is matched to an account by name or by the people it mentions, and shown as "not tied to an account" if that fails. The parser keeps the raw payload and reads any other shape tolerantly, but it was built around the real format above.
- Dates in an event's text are found by pattern ("5 December", "in January"). A month with no day is counted from the 1st and labelled derived.
- Dock-level usage cannot be tied to a force or plant, because the install lists are not on file. The engine says so instead of guessing.
- `get_feature_requests` and `get_release_notes` are not fetched, to save calls.
- Notes written to the MCP cannot be deleted from here.

The data in this project is fictional (a game scenario). Nothing in it is a real FlytBase fact, figure or commitment.
