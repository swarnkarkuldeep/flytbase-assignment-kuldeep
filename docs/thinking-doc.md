# Account CRM: what it does, how it decides, what it does not do yet

Live CRM: https://flytbase-assignment-kuldeep.vercel.app · Code: https://github.com/swarnkarkuldeep/flytbase-assignment-kuldeep

## What it does, and for whom

It is the page a Customer Success Manager opens on Monday after inheriting accounts they have never worked. For each account it answers five questions, and every number carries the id of the record it came from. One click opens the raw record.

1. What is the book worth? 2. Who holds the power? 3. What do I do first? 4. What is about to go wrong? 5. What do I still not know?

It reads the MCP on its own, one call a minute, so new events appear without a reload or a code change. During the build it picked up three live events (a champion leaving, an urgent customer request, three docks that stopped flying) and a whole third account released mid-build, and re-ranked each time. It writes its top next steps and risks back as notes.

## How it decides

Plain rules in code. No model is called when the page loads.

- **Backed and unbacked money stay apart.** Closed means won or agreed. "Backed, not yet won" means the amount is written in a contract or record we hold, so a £350,000 renewal in the contract is shown as backed but not closed. Unbacked means open offers, projections and claims. A champion's claim never becomes a total: Aldermoor's €1.2M saving is checked against its own spreadsheet (the rows sum to €1,053,400, no guard contract is reduced, nothing is booked by finance).
- **Moves are ranked by urgency × value × promise.** Urgency comes from the tightest dated deadline, or how long something we owe has waited. Value counts backed money fully and unbacked money at 10%, capped. Promise is 2 if we owe it on something we sold, 1.5 if we owe a reply, else 1. Each move has an owner and a due date at least 7 days inside every relevant deadline. The reasoning is shown.
- **Risks carry the date they turn bad.** A reply goes bad 7 days after it arrived, a contact goes cold after 60 days, a renewal needs starting 60 days before the term ends. When a date is worked out ("in five months", "in January", a game-clock minute) it is labelled derived, with the rule beside it.
- **Power is derived, never invented.** No record says who decides or pays, so each seat is built from roles, facts, the contract signatory and invoicing terms, marked derived or stated. Where nobody is on file it says "unknown" and Q5 names who could fill it.
- **Each account has its own "today"**, so one account's event does not age another's deadlines.

## What it does not do yet

- It does not know which dock sits at which force or plant, so idle docks cannot be tied to a site. It says so.
- Dates inside event text are found by pattern. A month with no day is counted from the 1st.
- It reads the text of only a few files (the flight log, the ROI sheet, the ticket history). Other files are cited as sources but not parsed.
- Feature requests and release notes are not used.
- An event with no account field is matched by name or people, and flagged if that fails.
- The page is public and read-only. Notes cannot be deleted from the MCP, so write-back has a pause switch.

## How I used AI

I built it with Claude Code, and I made the judgement calls. The data is the source of truth, so my morning notes are hints: anything not in the data appears only under Q5 as unconfirmed. Currency comes from the profile (£ and €, never $). The renewal counts as backed, not closed.

The rules engine decides; the AI does not invent. Claude wrote the code, but nothing on the page is generated at run time. A test walks every source id the engine emits and fails if one does not resolve to a real record. 54 tests cover the queue, the rules, the live events and the write-back.

Claude also made mistakes that I caught. It first showed £905,000 as "backed", which mixed closed deals (£555,000) with a renewal not yet won, so I made Closed its own number. It also let write-back start on its own after deploy; I paused it before any note was written.
