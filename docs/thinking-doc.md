# Account CRM: what it does, how it decides, what it does not do yet

Live CRM: https://flytbase-assignment-kuldeep.vercel.app · Code: https://github.com/swarnkarkuldeep/flytbase-assignment-kuldeep

## What it does, and for whom

It is the page a Customer Success Manager opens on Monday after inheriting accounts they have never worked. For each account it answers five questions: what is the book worth, who holds the power, what do I do first, what is about to go wrong, and what do I still not know. Every number carries the id of the record it came from, and one click opens the raw record.

It reads the MCP on its own, one call a minute, so new events appear without a reload or a code change. During the build it picked up three live events and a whole third account released mid-build, and re-ranked each time. It writes its top next steps and risks back as notes.

## How it decides

Plain rules in code. No model runs when the page loads.

- **Backed and unbacked money stay apart.** Closed means won or agreed. "Backed, not yet won" means the amount is written in a contract we hold, so a £350,000 renewal is backed but not closed. Unbacked means open offers, projections and claims. A champion's claim never becomes a total: Aldermoor's €1.2M saving is checked against its own spreadsheet, whose rows sum to €1,053,400 with nothing booked by finance.
- **Moves are ranked by urgency × value × promise.** Urgency comes from the tightest dated deadline, or how long something we owe has waited. Value counts backed money fully and unbacked money at 10%, capped. Promise is 2 if we owe it on something we sold, 1.5 if we owe a reply. Each move has an owner and a due date at least 7 days inside every deadline, with the reasoning shown.
- **Risks carry the date they turn bad.** A reply goes bad after 7 days, a contact goes cold after 60, a renewal needs starting 60 days before the term ends. Worked-out dates ("in January", a game-clock minute) are labelled derived, with the rule beside them.
- **Power is derived, never invented.** No record says who decides or pays, so each seat is built from roles, facts and the contract, and marked derived or stated. Where nobody is on file it says unknown, and Q5 names who could fill it.
- **Each account has its own "today"**, so one account's event does not age another's deadlines.

## What it does not do yet

- It cannot tie an idle dock to a force or plant, because the install lists are not on file. It says so.
- Dates inside event text are found by pattern; a month with no day is counted from the 1st.
- It parses the text of only a few files. The rest are cited as sources but not read.
- Feature requests and release notes are unused. The page is public and read-only.
- Notes cannot be deleted from the MCP, so write-back has a pause switch.

## How I used AI

I built it with Claude Code and made the judgement calls. The data is the source of truth, so my morning notes appear only under Q5 as unconfirmed. Currency comes from the profile, and the renewal counts as backed, not closed.

The rules engine decides; the AI does not invent. Nothing on the page is generated at run time, and a test fails if any source id does not resolve to a real record. 54 tests cover the queue, the rules, the live events and the write-back.

Claude made mistakes that I caught. It first showed £905,000 as "backed", mixing £555,000 closed with a renewal not yet won, so Closed became its own number. It also let write-back start on its own after deploy; I paused it before any note was written.
