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
