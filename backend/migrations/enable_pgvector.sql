-- ---------------------------------------------------------------------------------------------
-- Semantic search over decoded agendas (pgvector).
--
-- Run once in the Supabase SQL Editor, or with backend/migrations/enable_pgvector.py when a
-- direct Postgres connection string is available. Every statement is guarded, so re-running
-- this file changes nothing.
--
-- Vectors are 768-dimensional because that is what the ingestion asks Gemini for
-- (gemini-embedding-001 with outputDimensionality 768). Changing the dimension here means
-- changing it in backend/embeddings.py and re-embedding everything.
-- ---------------------------------------------------------------------------------------------

create extension if not exists vector;

-- One row per decoded agenda. Mirrors a record in public/data/boards/<board>.json: the JSON
-- file stays the thing the site renders, and this is the searchable copy of the full text.
create table if not exists public.documents (
  id           text        primary key,          -- the meeting id, e.g. ddsb-2026-09-09-...
  board_id     bigint      not null references public.boards (id) on delete cascade,
  title        text        not null,
  meeting_date date        not null,
  url          text,                             -- the original agenda on the board's site
  created_at   timestamptz not null default now()
);

create index if not exists documents_board_id_idx on public.documents (board_id);
create index if not exists documents_meeting_date_idx on public.documents (meeting_date desc);

alter table public.documents enable row level security;

-- The agenda split into passages, each with its embedding. board_id is denormalised from
-- documents so a board-filtered search never has to join before narrowing.
create table if not exists public.document_chunks (
  id          bigint generated always as identity primary key,
  document_id text        not null references public.documents (id) on delete cascade,
  board_id    bigint      not null references public.boards (id) on delete cascade,
  chunk_index integer     not null,
  content     text        not null,
  embedding   vector(768),
  created_at  timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists document_chunks_board_id_idx on public.document_chunks (board_id);

-- HNSW rather than IVFFlat: it needs no training pass, so it works from the first row, which
-- matters while the corpus is small and growing.
create index if not exists document_chunks_embedding_idx
  on public.document_chunks using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks enable row level security;

-- Nearest passages to a query embedding, optionally within one board.
--
-- filter_board_id is bigint, not uuid: boards.id is a bigint identity column, and the whole
-- point of the filter is to compare against it.
--
-- The <=> operator is cosine distance (0 = identical), so similarity is 1 - distance and the
-- threshold reads the way a caller expects: higher means stricter.
create or replace function public.match_document_chunks(
  query_embedding vector(768),
  match_threshold float   default 0.5,
  match_count     int     default 10,
  filter_board_id bigint  default null
)
returns table (
  id           bigint,
  document_id  text,
  board_id     bigint,
  chunk_index  integer,
  content      text,
  similarity   float,
  title        text,
  meeting_date date,
  url          text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.document_id,
    c.board_id,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    d.title,
    d.meeting_date,
    d.url
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where c.embedding is not null
    and (filter_board_id is null or c.board_id = filter_board_id)
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

-- Agenda text is public, but it is served through the app's own route, so only the server key
-- may call this.
revoke all on function public.match_document_chunks(vector, float, int, bigint) from public, anon, authenticated;
grant execute on function public.match_document_chunks(vector, float, int, bigint) to service_role;
