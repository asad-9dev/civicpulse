# CivicPulse

**Ontario trustee decisions, decoded.** CivicPulse turns 100+ page school board trustee meeting
agendas into three-point summaries that students and parents can read in a minute.

> CivicPulse is an independent project, not affiliated with or endorsed by any school board.
> The per-board files in `public/data/boards/` start empty and are filled with real meetings by
> the pipeline (see [Automation](#automation-github-actions)). Until the first run, the site
> shows a "No meetings decoded yet" message.

## Boards

All 72 Ontario district school boards are registered in **`data/boards_config.json`** — the
single file the website (`lib/boards.ts`) and the pipeline (`backend/boards.py`) both read, so
the two can't disagree about 72 boards.

Names, regions, types and websites come from the Ontario Ministry of Education's board contact
list. `portal_type` and `seed_url` were found by crawling each board's own site: most publish
agendas through meeting-portal software, and which one decides whether a scraper can read it.

Each board carries a `status`:

| Status | Meaning |
| --- | --- |
| `live` | A portal was found and an adapter reads it — the board is scraped daily |
| `supervised` | The province appointed a supervisor, so no trustee meetings are being held |
| `planned` | Registered and listed on the site, but no portal found yet, or no adapter for the one it uses |

Every board appears in the site's board switcher whatever its status, so someone looking for
their board finds it and an explanation, rather than nothing.

### Being decoded now

| Board | Slug | Portal |
| --- | --- | --- |
| Durham District School Board | `ddsb` | eSCRIBE — calendar.ddsb.ca |
| Greater Essex County District School Board | `gecdsb` | eSCRIBE — calendar.publicboard.ca |
| Kawartha Pine Ridge District School Board | `kprdsb` | eSCRIBE — events.kprschools.ca |
| York Region District School Board | `yrdsb` | CivicWeb — yrdsb.civicweb.net |

Three boards are registered but have no meetings to decode: **TDSB**, **TCDSB** and **PDSB** are
all under provincial supervision, with trustee meetings suspended. The remaining 65 are
`planned` — see [Why a board isn't decoded yet](#why-a-board-isnt-decoded-yet).

### Adapters

Discovery lives in `backend/adapters/`, one module per portal family, all returning the same
record so the rest of the pipeline treats every board identically:

| Adapter | Portal | Notes |
| --- | --- | --- |
| `escribe.py` | eSCRIBE | Reads the meeting table; the Agenda column links straight to the PDF. Covers both escribemeetings.com and boards hosting eSCRIBE on their own domain |
| `civicweb.py` | CivicWeb | Schedule page lists several months; each meeting's page carries the agenda, added by its own script after load |
| `boarddocs.py` | BoardDocs | Lists meetings from a JSON endpoint. Agendas are HTML, not PDF |
| `generic_pdf.py` | none | Fallback: crawl a board's meetings page for linked agenda PDFs |

### Why a board isn't decoded yet

The crawl that built the registry found a portal for 10 of 72 boards. The rest came back empty
for ordinary reasons: most board sites render their navigation in JavaScript and bury the
agenda link several pages deep, and some sites refuse automated requests entirely. A board being
`planned` means **nobody has mapped its portal yet**, not that it publishes nothing.

Two further boards are `planned` despite having a portal, because the adapters can't read them
yet: **SMCDSB** and **TVDSB** are on a newer eSCRIBE that renders its meeting list in the browser
instead of serving HTML, and **UCDSB**'s BoardDocs keeps the agenda in a pane the scraper can't
reach. Their `status_note` says so, and the site shows that to visitors.

### Adding or fixing a board

1. Edit its entry in `data/boards_config.json`: set `portal_type`, `seed_url`, and `status` to
   `live`. Nothing in `lib/boards.ts` or `backend/boards.py` needs to change.
2. Check it: `python backend/scrape_agendas.py --board <slug> --limit 1 --summarizer dummy`
3. Copy the registry into Postgres: `python backend/seed_boards.py`
4. That's it — the daily workflow reads the registry and picks up every `live` board, so it
   needs no edit.

Adding `municipalities` to a board is optional but worth doing: with them, the town filter chips
appear for that board and summaries are constrained to real place names. Without them, the
summarizer names whatever towns the agenda mentions.

## View the app locally

Requires Node.js 18.17+ (tested on Node 24).

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The front end reads the per-board files in
`public/data/boards/`, so no Python or API key is needed just to view the app. The board
switcher in the header writes its choice to the URL (`/?board=yrdsb`, or no parameter for every
board), so any view can be linked to.

### Newsletter sign-ups (Supabase)

Sign-ups are stored in a Supabase table. To enable them:

1. In the Supabase dashboard, open **SQL Editor**, paste `backend/schema.sql` and run it. It
   creates `subscribers` (`id`, `email` unique, `created_at`) with Row Level Security on and no
   policies, so the public key can't read the list, along with the board tables below. Every
   statement is guarded, so running the whole file again is safe and is how you pick up later
   schema changes.
2. Copy `.env.example` to `.env.local` and set `SUPABASE_SERVICE_ROLE_KEY` to the project's
   **secret** key (Project Settings → API Keys). It's used only on the server. Never commit it,
   and never give it a `NEXT_PUBLIC_` prefix.
3. For the deployed site, add the same two variables in Vercel (Project → Settings →
   Environment Variables), then redeploy.

Without these variables the form still works but replies that sign-ups aren't open yet.

### The database, table by table

`backend/schema.sql` is the whole schema. The secret key can read and write rows but cannot
create tables, so this file has to be run once from the SQL Editor (or with `psql` against the
project's connection string) — there is no way to apply it from the app.

| Table | What it holds |
| --- | --- |
| `subscribers` | One row per email address |
| `subscriber_boards` | Which boards a subscriber follows. **No rows means every board**, so anyone who signed up before boards existed keeps getting everything |
| `boards` | One row per board, seeded from `lib/boards.ts`. The site reads board names from code, not from here, so a page render never waits on the database; the table exists to give each board an id the other tables reference |
| `digest_log` | Which meetings have been emailed, and for which board. A meeting is claimed here before sending, so two overlapping runs can't email it twice |

There is also one function, `subscribers_for_board(filter_board_id, after_id, page_size)`, which
returns the subscribers who follow a board — those who chose it plus those who follow every
board — so the filtering happens in the database rather than in the digest route. It is
`security definer` and granted only to `service_role`, since it reads the subscriber list.

Until the file has been run, the app degrades instead of failing: sign-ups still work, board
choices simply aren't recorded, and every subscriber gets every board's digest.

### Semantic search over agendas (pgvector)

The cards on the home page are filtered in the browser by matching words, which only finds the
wording a summary happens to use. `/api/search` searches the agendas themselves by meaning.

Setup, once:

1. Paste `backend/migrations/enable_pgvector.sql` into the Supabase SQL Editor and run it, or
   run `python backend/migrations/enable_pgvector.py` with `SUPABASE_DB_URL` set. It enables the
   `vector` extension and creates `documents`, `document_chunks` and `match_document_chunks`.
   Check it with `python backend/migrations/enable_pgvector.py --check`.
2. Set `GEMINI_API_KEY` for the web app as well as the pipeline — in `.env.local`, and in Vercel
   for the deployed site. The key stays on the server; the browser never sees it.
3. Run the pipeline with `--embed` to fill the index:
   `python backend/run_all.py --all --write-public --embed`

How it works: the pipeline already extracts an agenda's full text on the way to a three-point
summary, and `--embed` keeps it. The text is split into overlapping ~500-token passages
(`backend/embeddings.py`) and each is embedded with `gemini-embedding-001` at 768 dimensions,
matching the `vector(768)` columns. A search embeds the phrase the same way — as a query rather
than a document — and Postgres returns the nearest passages by cosine distance.

```bash
curl "http://localhost:3000/api/search?q=school+closures&board=ddsb&limit=5"
```

`board` narrows the search inside the database rather than filtering afterwards. `threshold`
(0-1, default 0.35) sets how close a passage has to be.

Two things worth knowing. `filter_board_id` is a **bigint**, not a UUID: `boards.id` is a bigint
identity column and the filter compares against it. And embedding is best-effort — if the key,
the tables or the network are missing, the run logs it and the summaries still publish, because
search is a bonus on top of them.

### Welcome emails and unsubscribing

Each new subscriber gets a welcome email: what CivicPulse will send (one short email after each
trustee meeting: the decisions, towns affected, deadlines to have your say, and the original
agenda), how often, and an unsubscribe link. Re-submitting an address that's already on the list
doesn't send a second one. Emails go out over SMTP, so any provider works. Set these in
`.env.local` and in Vercel, as plain values:

| Variable | Gmail | Resend |
| --- | --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` | `smtp.resend.com` |
| `SMTP_PORT` | `465` | `465` |
| `SMTP_USER` | your Gmail address | `resend` |
| `SMTP_PASS` | a 16-character [app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification) | your `re_...` API key |
| `EMAIL_FROM` | `CivicPulse <you@gmail.com>` | `CivicPulse <alerts@yourdomain>` (a domain verified in Resend) |

Also set `SITE_URL=https://ddsb-civicpulse.vercel.app` so email links always point at the public
site. If SMTP isn't configured, sign-ups still save and the email is skipped, with a log line.

Every email carries an unsubscribe link to `/unsubscribe`, a page with a confirm button, so link
scanners that open URLs can't unsubscribe anyone. It also sets `List-Unsubscribe` and
`List-Unsubscribe-Post` headers, so Gmail and Apple Mail show their built-in one-click
unsubscribe. Links are signed per subscriber (id + HMAC of the email). They carry no email
address, and they stop working if the Supabase secret key is rotated, unless `UNSUBSCRIBE_SECRET`
is set. Unsubscribing deletes the row.

### Meeting summary emails (digest)

When new meetings reach the site, subscribers get one email covering the ones from boards they
follow, most urgent first: board, date, committee, title, urgency, towns, the three key points,
and links to the full breakdown and the original agenda. Nothing is sent on days without new
meetings, and nobody is emailed about a board they don't follow.

An email about one board is headed with that board's acronym and says it isn't affiliated with
that board; an email spanning several is headed `ONTARIO` and names each board on its own item.

How it runs:

1. The daily GitHub workflow (11:00 UTC) adds new meetings to the per-board files, and Vercel
   redeploys.
2. Vercel Cron (`vercel.json`) calls `/api/digest` every day at 14:00 UTC with
   `Authorization: Bearer $CRON_SECRET`.
3. The route picks meetings from the last 45 days that aren't in the Supabase `digest_log` table.
   It claims them there, then emails each subscriber separately, with their own unsubscribe link
   and only the boards they follow, and records how many people received each meeting. The claim
   means a meeting is never emailed twice. If every attempt fails (for example, a bad SMTP
   password), the claim is released and the next run retries; a meeting that simply has no
   followers yet stays recorded, the same way a new subscriber doesn't get older meetings.

Setup: run `backend/schema.sql` in Supabase (it creates `digest_log`), and set `CRON_SECRET` to a
long random string in `.env.local` and in Vercel.

Trigger or test it by hand with the same header:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://ddsb-civicpulse.vercel.app/api/digest?dryRun=1"
```

`?dryRun=1` reports which boards and meetings would go out and to how many subscribers, without
sending. `?previewTo=you@example.com` sends the digest to that one address without marking
anything as sent. `?board=yrdsb` limits the run to one board, which is the quickest way to check
a newly added one. A call with no query string sends the real digest.

Gmail allows roughly 500 emails a day, and a run stops sending after about 50 seconds (Vercel's
Hobby time limit is 60), which is enough for about a hundred subscribers. Past that, switch to a
bulk email provider.

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload on port 3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |

### What you can do in the app

- **Search** every summary (titles, bullets, impact, policy text), instantly, in the browser.
- **Filter** by town (Ajax, Pickering, Whitby, Oshawa, Uxbridge) and category (Boundary Review,
  Transport, Policy, Budget).
- **Open a card** for the full breakdown: executive summary, what it means for students and
  parents, policy changes, and a link to the original agenda. Each breakdown has a shareable URL
  (`/?meeting=<id>`).
- **Subscribe** to meeting alerts. The form posts to `/api/subscribe`, which validates the email
  and saves it to the Supabase `subscribers` table.

## How it fits together

```mermaid
flowchart LR
  subgraph pipeline ["Python pipeline: backend/scrape_agendas.py --board <slug>"]
    A[Board meeting calendar<br/>eSCRIBE or CivicWeb] -->|Playwright, headless Chromium| B[Agenda PDFs<br/>backend/agendas/board/]
    B -->|pdfplumber| C[Agenda text<br/>100+ pages]
    C -->|Gemini, structured JSON| D[Meeting record]
  end
  D -->|--write-public| E[(public/data/boards/board.json)]
  E -->|read on every request| F[Next.js page<br/>server component]
  F --> G[BoardSelector<br/>?board=slug]
  F --> H[MeetingExplorer<br/>search, filters, modal]
  I[Newsletter form] -->|POST /api/subscribe| J[(Supabase: subscribers<br/>+ subscriber_boards)]
  J --> K[Daily digest<br/>only the boards you follow]
```

The JSON file is the contract between the two halves. The Python pipeline writes records in
exactly the shape the front end reads (`lib/types.ts` → `Meeting`). An illustrative record:

```jsonc
{
  "id": "ddsb-2026-09-08-committee-of-the-whole-standing", // board + date + committee: one per meeting
  "boardSlug": "ddsb",                     // which board held it; see lib/boards.ts
  "meetingDate": "2026-09-08",
  "committeeName": "Committee of the Whole - Standing",
  "title": "Draft boundaries set for the new Seaton elementary school",
  "urgencyScore": 5,                       // 1 (FYI) … 5 (act now); 4–5 red, 3 amber, 1–2 green
  "townsAffected": ["Pickering", "Ajax"],
  "category": "Boundary Review",           // Boundary Review | Transport | Policy | Budget
  "executiveSummary": ["…", "…", "…"],     // exactly 3 bullets
  "studentParentImpact": "…",
  "policyChanges": "…",
  "originalPdfUrl": "https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/"
}
```

Because `app/page.tsx` re-reads the board files on each request, a fresh pipeline run shows up
on the next page load with no rebuild.

The `id` carries the board slug because boards reuse committee names: DDSB and YRDSB both run a
"Special Education Advisory Committee", and they meet on the same evenings often enough that an
unprefixed id would collide in `digest_log` and stop one board's meeting from ever being
emailed.

There is one file per board rather than one shared file so that each board's scrape job writes
its own file, and two jobs finishing at once can't overwrite each other.

## The Python backend

Two entry points:

- **`backend/run_all.py`** scrapes many boards in one batch — `--all`, `--portal escribe` or
  `--board <slug>` — a couple at a time (`--concurrency`, default 2) to stay inside Gemini's
  per-minute free-tier limit. Each board runs as its own process, so one board's crash or hung
  browser can't touch the others. Every outcome is recorded in `data/ingest_status.json`:
  `--status` prints the last run, `--retry-failed` re-runs just the boards that broke, and
  `--resume` picks up a batch that was interrupted.
- **`backend/scrape_agendas.py`** does one board, and is what the batch runner shells out to.

`backend/scrape_agendas.py` scrapes one board per run (`--board <slug>`) in five steps:

1. **Discover**: opens the board's calendar in headless Chromium with Playwright. There is one
   adapter per portal type, picked from the board's `platform`:
   - `discover_escribe` (eSCRIBE, e.g. `calendar.ddsb.ca/meetings`) waits for the meeting table,
     then reads each row's date, meeting name and the link in the **Agenda** column, found by its
     header text rather than its position. That link is the agenda PDF itself. `--months-back N`
     follows the calendar's "‹" link to include earlier months.
   - `discover_civicweb` (CivicWeb, e.g. `yrdsb.civicweb.net`) reads the schedule page, which
     already covers several months, and drops private sessions. It then opens each meeting's own
     page and waits for the **Agenda Package** link (or **Agenda**), which the page adds with its
     own script a moment after load — reading any earlier finds nothing. A meeting whose agenda
     isn't posted yet times out quickly and is skipped.

   A board whose `platform` is `manual` has no adapter; the run says so and exits without
   failing, since a board under provincial supervision holds no meetings to scrape.
2. **Download**: saves each PDF to `backend/agendas/<board>/` through the same browser context,
   named like `2026-09-09-committee-of-the-whole-standing-1b62b947.pdf`. Files already on disk are
   reused. The suffix is the portal's document id, so a reposted, revised agenda is fetched again.
3. **Extract**: pulls the text with `pdfplumber`, keeping `--- page N ---` markers.
   `simulate_pdfplumber_extraction()` is the dummy stand-in used by `--offline`.
4. **Summarize**: one of three summarizers, all producing the same record shape:
   `summarize_with_gemini()` (Google Gemini, free tier; what the daily workflow uses),
   `summarize_with_claude()` (Claude, paid), or `summarize_dummy()` (built-in keyword parser,
   free and offline). The AI summarizers share one prompt: plain language, no facts beyond the
   agenda, and past tense for meetings that have already happened, since an agenda never says
   what was decided.
5. **Publish**: writes `backend/output/<board>.generated.json`; with `--write-public` it
   upserts the records (by `id`) into `public/data/boards/<board>.json`.

### Set up

Python 3.10 or newer (the `anthropic` SDK requires it).

```bash
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
python -m playwright install chromium
```

The last command is a one-time download of the headless Chromium build Playwright drives.

### Run

```bash
# No network, no browser, no API key: simulated agenda + dummy summarizer
python backend/scrape_agendas.py --board ddsb --offline

# Live calendar: download the latest agendas to backend/agendas/<board>/ (dummy summaries)
python backend/scrape_agendas.py --board yrdsb --limit 3

# Go back three months, summarize with Gemini, and publish to the app
python backend/scrape_agendas.py --board ddsb --months-back 3 --limit 10 --summarizer gemini --write-public

# Re-summarize a PDF that's already downloaded
python backend/scrape_agendas.py --board ddsb --pdf backend/agendas/ddsb/<file>.pdf --summarizer claude
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--offline` | off | Skip the browser and network; use the simulated agenda text |
| `--pdf FILE` | none | Summarize local PDF(s) instead of scraping (repeatable) |
| `--summarizer {dummy,gemini,claude}` | `dummy` | `gemini`: free tier, falls back to built-in; `claude`: paid |
| `--limit N` | `3` | Max agendas to process from the calendar, newest first |
| `--months-back N` | `1` | Start the calendar listing N months before the current month |
| `--headed` | off | Show the browser window (useful when the calendar's markup changes) |
| `--out PATH` | `backend/output/<board>.generated.json` | Where results are written |
| `--board <slug>` | `ddsb` | Which board to scrape: `ddsb`, `yrdsb`, `tdsb`, `pdsb` (see `backend/boards.py`) |
| `--write-public` | off | Upsert results into `public/data/boards/<board>.json`, skipping agendas already published |
| `--refresh` | off | With `--write-public`, re-summarize agendas even if they're already published |

Each meeting has one record, keyed by date and committee. Re-running the pipeline updates that
record rather than adding a duplicate. When the board reposts a revised agenda, its new
document link triggers a fresh summary.

The calendar lists every upcoming meeting, but agendas are only posted a few days before each
one, so most rows have no Agenda link yet and are skipped.

The built-in summarizer only reads the agenda's order of business: it lists up to three
substantive items and guesses a category. The AI summarizers write real summaries.

**Gemini.** Put a Google AI Studio key in `backend/.env` as `GEMINI_API_KEY` (and in the
`GEMINI_API_KEY` GitHub secret for the workflow). It tries `gemini-3.6-flash`, then
`gemini-3.5-flash`, then `gemini-3.5-flash-lite` (override with `GEMINI_MODELS`). Each model
has its own free-tier quota. Per-minute rate limits are waited out and retried. When every
model is out of quota or unavailable, that meeting gets the built-in summary instead, and the
next run upgrades it (records carry a `summarySource` field). Nothing is charged unless you add
billing to the Google project. On the free tier, Google may use requests to improve its products;
only public agenda text is sent.

**Claude credentials.** `--summarizer claude` uses the SDK's default credential lookup: set
`ANTHROPIC_API_KEY` in `backend/.env` (copy `backend/.env.example`), or sign in once with
`ant auth login`. Requests stream (long agendas don't time out) and opt into the API's
server-side fallback, so a declined request is retried on another model automatically.

### If the calendar changes

The scraper depends on three things in the calendar's markup, all in `discover_agendas()` and
`READ_MEETING_ROWS_JS`:

- meeting rows with `td[headers="c1"]` (date) and `td[headers="c2"]` (meeting link)
- an attachment column whose header reads **Agenda**
- a "‹" link for the previous month

If a run reports that the calendar didn't render, or finds no agendas where you can see some
in a browser, re-run with `--headed` to watch what the page does and update those selectors.

### Automation (GitHub Actions)

`.github/workflows/scrape.yml` runs the pipeline every day at 11:00 UTC (6:00 AM EST, 7:00 AM
during daylight time), and on demand from the repo's **Actions** tab (**Run workflow**). A newly
posted agenda is on the site within a day; on days without one, nothing changes. It installs
Python 3.11, the requirements and Chromium, then runs:

```bash
python backend/scrape_agendas.py --board <slug> --months-back 1 --limit 10 --summarizer gemini --write-public
```

It summarizes with Gemini using the `GEMINI_API_KEY` repository secret. A **Check Gemini key**
step runs first. If the key is missing or rejected, that step turns red with a warning, but the
run continues. Meetings then get the built-in summary, the run shows a "Gemini fallback" warning,
and a later run upgrades them. When you start a run by hand, tick **refresh** to re-summarize
meetings that are already on the site, for example after changing the prompt.

The workflow runs `backend/run_all.py --all`, which reads `data/boards_config.json` and scrapes
whichever boards are marked `live`, two at a time. Adding a board is a registry edit; the
workflow needs no change. Each run writes which boards succeeded to the run's summary page.
If `public/data/boards/<board>.json` changed, it commits the file as `github-actions[bot]` and pushes
it. The downloaded PDFs are kept as a run artifact for 14 days.

Before the first run:

1. Add the `GEMINI_API_KEY` secret under **Settings → Secrets and variables → Actions**.
2. Check that **Settings → Actions → General → Workflow permissions** allows read and write
   access, or the push is rejected.
3. Connect the Vercel project to the repository (Vercel → Project → Settings → Git), so each
   bot commit redeploys the site.

To use Claude instead, add an `ANTHROPIC_API_KEY` repository secret, pass it to the scrape step
as an environment variable, and change `--summarizer gemini` to `claude`.

GitHub pauses scheduled workflows in public repos after 60 days without repository activity. The
bot's commits count as activity, but a long break with no new meetings (like summer) can pause
it. If that happens, re-enable it from the **Actions** tab.

## Project structure

```
app/
  layout.tsx              fonts (Newsreader, Atkinson Hyperlegible, IBM Plex Mono), metadata
  page.tsx                header, hero, feed, newsletter band, footer (server component)
  globals.css             Tailwind layers, dialog and bottom-sheet styles, reduced-motion
  api/subscribe/route.ts  validates emails, inserts them into Supabase, sends the welcome email
  api/unsubscribe/route.ts  verifies a signed link and removes the subscriber (POST only)
  api/digest/route.ts     daily cron: emails subscribers a digest of newly decoded meetings
  unsubscribe/page.tsx    unsubscribe confirmation page
components/
  MeetingExplorer.tsx     search, town/category chips, results count, feed, empty state
  MeetingCard.tsx         feed card
  MeetingDialog.tsx       full breakdown (native <dialog>; bottom sheet on phones)
  Badges.tsx              date, urgency (color + icon + words), town and category labels
  HeroIllustration.tsx    agenda-page graphic
  NewsletterForm.tsx      email sign-up with loading, success and error states
lib/                      board registry, types, date/urgency helpers, meeting loader,
                          Supabase admin client, welcome email (SMTP), signed unsubscribe links
middleware.ts             returns 404 for the old /data/subscribers.json path
public/data/boards/       one JSON file per board (written by the pipeline)
backend/                  scrape_agendas.py, boards.py, requirements.txt, .env.example
  agendas/                downloaded agenda PDFs (git-ignored)
design/                   Claude Design canvas source (.dc.html artboards)
```

## Notes

- **Subscriber privacy.** Emails are stored in Supabase behind Row Level Security, and only the
  server holds the secret key. The API gives the same response for new and existing emails, so
  it can't be used to check who has signed up.
- **Not yet built:** double opt-in confirmation, per-town email preferences, and rate limiting on
  the sign-up endpoint.
- **Accessibility.** WCAG AA contrast, visible focus rings, keyboard-operable filters and
  dialog, 44px touch targets on phones, and `prefers-reduced-motion` support.
