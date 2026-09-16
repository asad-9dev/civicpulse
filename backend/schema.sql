-- CivicPulse newsletter subscribers.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste this file > Run.

create table if not exists public.subscribers (
  id          bigint generated always as identity primary key,
  email       text        not null unique check (char_length(email) <= 254),
  created_at  timestamptz not null default now()
);

-- Enforces one row per email even if the table was created earlier without the UNIQUE
-- constraint (create table if not exists skips an existing table). Safe to re-run.
create unique index if not exists subscribers_email_key on public.subscribers (email);

-- Row Level Security with no policies: the public (anon/publishable) key can neither read nor
-- write this table, so the subscriber list can't be pulled from the browser. The Next.js API
-- route uses the secret key on the server, which bypasses RLS.
alter table public.subscribers enable row level security;

-- Which meetings have already gone out in a digest email (app/api/digest/route.ts).
-- A run claims a meeting by inserting its row before sending, so overlapping runs can't
-- email the same meeting twice.
create table if not exists public.digest_log (
  meeting_id  text        primary key,            -- the id in public/data/meetings.json
  claimed_at  timestamptz not null default now(),
  sent_at     timestamptz,                        -- null while a run is still sending
  recipients  integer,
  failures    integer
);

alter table public.digest_log enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Multi-board expansion (see lib/boards.ts and backend/boards.py).
--
-- Re-runnable: every statement is guarded, so pasting this whole file again changes nothing.
-- scripts/migrate-multi-board.ts seeds and verifies the boards rows once these objects exist.
-- ---------------------------------------------------------------------------------------------

-- The Ontario school boards CivicPulse covers. Rows are seeded from lib/boards.ts, which stays
-- the source of truth: the site reads board names from code, not from here, so a page render
-- never waits on the database. This table exists so other tables can reference a board by id.
create table if not exists public.boards (
  id            bigint generated always as identity primary key,
  slug          text        not null unique,   -- matches Board.slug in lib/boards.ts
  name          text        not null,
  short_name    text        not null,
  region        text        not null,
  board_type    text        not null default 'public',
  province      text        not null default 'ON',
  website       text,
  agenda_portal text,                          -- null when the board has no public portal
  platform      text        not null default 'manual',   -- escribe | civicweb | manual
  status        text        not null default 'planned',  -- live | supervised | planned
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.boards enable row level security;

-- Board names aren't secret, but nothing needs to read them from the browser either: the site
-- gets them from lib/boards.ts. RLS on with no policies keeps the anon key out, like the rest.

-- Which board a digest covered, so the same meeting id can exist for two boards and so a
-- board's send history can be read on its own. Existing rows are backfilled to DDSB by
-- scripts/migrate-multi-board.ts (every meeting sent before the expansion was a DDSB one).
alter table public.digest_log add column if not exists board_id bigint references public.boards (id);

create index if not exists digest_log_board_id_idx on public.digest_log (board_id);

-- Which boards a subscriber follows. No rows for a subscriber means "every board", so everyone
-- who signed up before the expansion keeps getting what they signed up for.
create table if not exists public.subscriber_boards (
  subscriber_id bigint      not null references public.subscribers (id) on delete cascade,
  board_id      bigint      not null references public.boards (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (subscriber_id, board_id)
);

alter table public.subscriber_boards enable row level security;

-- Board-filtered recipient lookup for app/api/digest/route.ts: given a board, the subscribers
-- who follow it, which is those who picked it plus those who follow everything. Keyset paging
-- (after_id) rather than OFFSET, so a long list doesn't get slower page by page.
--
-- filter_board_id is optional: null returns every subscriber, which is what the digest wants
-- when it has meetings from several boards to send in one email.
create or replace function public.subscribers_for_board(
  filter_board_id bigint default null,
  after_id        bigint default 0,
  page_size       integer default 1000
)
returns table (id bigint, email text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.email
  from public.subscribers s
  where s.id > after_id
    and (
      filter_board_id is null
      or not exists (select 1 from public.subscriber_boards sb where sb.subscriber_id = s.id)
      or exists (
        select 1 from public.subscriber_boards sb
        where sb.subscriber_id = s.id and sb.board_id = filter_board_id
      )
    )
  order by s.id
  limit least(greatest(page_size, 1), 1000);
$$;

-- The function reads the subscriber list, so it must not be callable with the browser's key.
revoke all on function public.subscribers_for_board(bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.subscribers_for_board(bigint, bigint, integer) to service_role;

-- Seed the boards CivicPulse covers. Keep in sync with lib/boards.ts (and backend/boards.py);
-- on conflict the row is refreshed, so re-running this file fixes any drift.
insert into public.boards (slug, name, short_name, region, board_type, website, agenda_portal, platform, status)
values
  ('ddsb',  'Durham District School Board',      'DDSB',  'Durham Region', 'public',
   'https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/',
   'https://calendar.ddsb.ca/meetings',                    'escribe',  'live'),
  ('yrdsb', 'York Region District School Board', 'YRDSB', 'York Region',   'public',
   'https://www2.yrdsb.ca/about-us/board-trustees/committee-meeting-dates',
   'https://yrdsb.civicweb.net/Portal/MeetingSchedule.aspx', 'civicweb', 'live'),
  ('tdsb',  'Toronto District School Board',     'TDSB',  'Toronto',       'public',
   'https://www.tdsb.on.ca/Leadership/Agendas-Minutes-Decisions',
   null,                                                   'manual',   'supervised'),
  ('pdsb',  'Peel District School Board',        'PDSB',  'Peel Region',   'public',
   'https://www.peelschools.org/agenda-and-minutes',
   null,                                                   'manual',   'supervised')
on conflict (slug) do update set
  name          = excluded.name,
  short_name    = excluded.short_name,
  region        = excluded.region,
  board_type    = excluded.board_type,
  website       = excluded.website,
  agenda_portal = excluded.agenda_portal,
  platform      = excluded.platform,
  status        = excluded.status,
  updated_at    = now();

-- Every digest sent before the expansion covered a DDSB meeting.
update public.digest_log
set board_id = (select id from public.boards where slug = 'ddsb')
where board_id is null;
