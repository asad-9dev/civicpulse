import type { SupabaseClient } from "@supabase/supabase-js";
import { BOARDS, getBoard, type Board } from "@/lib/boards";
import { getMeetings } from "@/lib/meetings";
import type { Meeting } from "@/lib/types";
import { isSchemaMissing, type BoardRow, type Database } from "./types";

/**
 * Board lookups against Supabase.
 *
 * lib/boards.ts stays the source of truth for what a board *is* — its name, region and towns —
 * so nothing that renders a page has to wait on the database. What lives here is the part only
 * the database knows: the numeric board id that digest_log and subscriber_boards reference.
 *
 * Every function degrades instead of throwing when the multi-board migration hasn't been applied
 * yet (backend/schema.sql), so the site keeps working while the schema change is pending.
 *
 * Server-only: it reads meetings off the filesystem and is called with the secret Supabase key.
 * Never import it from a client component.
 */

export type Db = SupabaseClient<Database>;

/** Slug -> numeric id, cached for the life of the server process (board ids never change). */
let idCache: Map<string, number> | null = null;

/**
 * Every board the database knows, newest schema first. Returns null when the boards table
 * isn't there yet, which callers read as "the migration is still pending".
 */
export async function fetchBoardRows(db: Db): Promise<BoardRow[] | null> {
  const { data, error } = await db.from("boards").select("*").order("name");
  if (error) {
    if (isSchemaMissing(error)) return null;
    throw error;
  }
  return data ?? [];
}

/** The boards that are switched on, as the registry describes them. Falls back to the registry. */
export async function fetchActiveBoards(db: Db): Promise<Board[]> {
  const rows = await fetchBoardRows(db);
  if (!rows) return BOARDS;
  const active = rows.filter((row) => row.is_active);
  // A row the registry doesn't describe can't be rendered (no towns, no short name), so the
  // registry decides what's shown and the table decides what's on.
  return BOARDS.filter((board) => active.some((row) => row.slug === board.slug));
}

/** Slug -> board id for every board in the table, or an empty map before the migration. */
export async function boardIds(db: Db): Promise<Map<string, number>> {
  if (idCache) return idCache;
  const rows = await fetchBoardRows(db);
  // "The table isn't there yet" is never cached: once the migration is applied the next call
  // should find the boards, rather than wait for this server instance to be replaced.
  if (rows === null) return new Map();
  idCache = new Map(rows.map((row) => [row.slug, row.id]));
  return idCache;
}

/** The numeric id for a slug, or null when the board or the table is missing. */
export async function boardIdForSlug(db: Db, slug: string | null | undefined): Promise<number | null> {
  if (!slug) return null;
  return (await boardIds(db)).get(slug) ?? null;
}

export interface SubscriberRecipient {
  id: number;
  email: string;
}

/**
 * One page of subscribers who should get a board's digest: those who picked it, plus those who
 * follow every board (no rows in subscriber_boards). Pass a null board to reach everyone.
 *
 * Uses the subscribers_for_board function so the filtering happens in the database; if that
 * function isn't there yet, falls back to an unfiltered page, which is what the digest did
 * before the expansion.
 */
export async function subscribersForBoard(
  db: Db,
  filterBoardId: number | null,
  afterId: number,
  pageSize = 1000,
): Promise<SubscriberRecipient[]> {
  const { data, error } = await db.rpc("subscribers_for_board", {
    filter_board_id: filterBoardId,
    after_id: afterId,
    page_size: pageSize,
  });
  if (!error) return (data ?? []) as SubscriberRecipient[];
  if (!isSchemaMissing(error)) throw error;

  const fallback = await db
    .from("subscribers")
    .select("id, email")
    .gt("id", afterId)
    .order("id")
    .limit(pageSize);
  if (fallback.error) throw fallback.error;
  return fallback.data ?? [];
}

/**
 * Record which boards a subscriber follows. An empty list means every board, which is stored
 * as no rows at all — so a subscriber who never chooses keeps getting everything.
 *
 * Best-effort: a sign-up must not fail because the preference couldn't be saved, so this
 * reports a problem instead of throwing.
 */
export async function setSubscriberBoards(
  db: Db,
  subscriberId: number,
  slugs: string[],
): Promise<{ saved: true } | { saved: false; reason: string }> {
  const wanted = slugs.map((slug) => getBoard(slug)).filter((board): board is Board => board !== null);
  if (wanted.length === 0 || wanted.length === BOARDS.length) return { saved: true };

  const ids = await boardIds(db);
  const rows = wanted
    .map((board) => ids.get(board.slug))
    .filter((id): id is number => id !== undefined)
    .map((board_id) => ({ subscriber_id: subscriberId, board_id }));
  if (rows.length === 0) return { saved: false, reason: "no board ids (migration pending?)" };

  const { error } = await db.from("subscriber_boards").upsert(rows, { onConflict: "subscriber_id,board_id" });
  if (error) return { saved: false, reason: error.message };
  return { saved: true };
}

/** The boards a subscriber follows, or every board when they haven't chosen. */
export async function boardsForSubscriber(db: Db, subscriberId: number): Promise<Board[]> {
  const { data, error } = await db.from("subscriber_boards").select("board_id").eq("subscriber_id", subscriberId);
  if (error) {
    if (isSchemaMissing(error)) return BOARDS;
    throw error;
  }
  if (!data || data.length === 0) return BOARDS;
  const ids = await boardIds(db);
  const followed = new Set(data.map((row) => row.board_id));
  return BOARDS.filter((board) => {
    const id = ids.get(board.slug);
    return id !== undefined && followed.has(id);
  });
}

// ----------------------------------------------------------------------------------------------
// Decoded meetings by board
//
// Meetings aren't in Postgres: the pipeline writes one JSON file per board under
// public/data/boards/, which the site reads on every request (lib/meetings.ts). These wrappers
// give board-scoped reads the same shape as the table helpers above.
// ----------------------------------------------------------------------------------------------

/** Every decoded meeting for one board, newest first. */
export async function meetingsByBoardSlug(slug: string): Promise<Meeting[]> {
  return getMeetings(getBoard(slug));
}

/** Every decoded meeting for one board by its numeric id; empty when the id is unknown. */
export async function meetingsByBoardId(db: Db, boardId: number): Promise<Meeting[]> {
  const ids = await boardIds(db);
  const slug = [...ids.entries()].find(([, id]) => id === boardId)?.[0];
  return slug ? meetingsByBoardSlug(slug) : [];
}
