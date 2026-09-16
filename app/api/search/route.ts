import { NextResponse } from "next/server";
import { getBoard } from "@/lib/boards";
import { boardIdForSlug, boardIds } from "@/lib/db/boards";
import { isSchemaMissing, type ChunkMatch } from "@/lib/db/types";
import { embedQuery } from "@/lib/embeddings";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Search the full text of decoded agendas by meaning.
 *
 * The cards on the home page are searched in the browser by matching words, which only finds
 * the wording a summary happens to use. This searches the agendas themselves: the query is
 * embedded with the same model the passages were, and Postgres returns the closest ones.
 *
 *   GET /api/search?q=school+closures
 *   GET /api/search?q=bus+routes&board=ddsb   limit to one board
 *   GET /api/search?q=budget&threshold=0.6&limit=5
 *
 * The Gemini key stays on the server, so the browser never sees it.
 */

const MAX_QUERY_LENGTH = 400;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
/** Cosine similarity below this is noise rather than a weak match. */
const DEFAULT_THRESHOLD = 0.35;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function number(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  if (!query) return badRequest('Add a search phrase, e.g. /api/search?q=school+closures');
  if (query.length > MAX_QUERY_LENGTH) return badRequest(`Keep the search under ${MAX_QUERY_LENGTH} characters.`);

  const boardSlug = params.get("board")?.trim() || null;
  if (boardSlug && !getBoard(boardSlug)) return badRequest(`No board called ${JSON.stringify(boardSlug)}.`);

  const limit = number(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const threshold = number(params.get("threshold"), DEFAULT_THRESHOLD, 0, 1);

  const supabase = getSupabaseAdmin();
  if ("problem" in supabase) {
    console.error(`[search] Supabase is misconfigured: ${supabase.problem}`);
    return NextResponse.json({ error: "Search isn't configured." }, { status: 503 });
  }
  const db = supabase.client;

  const embedded = await embedQuery(query, AbortSignal.timeout(20_000));
  if ("problem" in embedded) {
    console.error(`[search] Could not embed the query: ${embedded.problem}`);
    return NextResponse.json({ error: "Search isn't available right now." }, { status: 503 });
  }

  // A board filter is applied inside the database, so a narrowed search reads fewer rows
  // rather than fetching everything and discarding most of it.
  const filterBoardId = boardSlug ? await boardIdForSlug(db, boardSlug) : null;
  if (boardSlug && filterBoardId === null) {
    console.error(`[search] ${boardSlug} has no row in the boards table`);
    return NextResponse.json({ error: "That board isn't searchable yet." }, { status: 503 });
  }

  const { data, error } = await db.rpc("match_document_chunks", {
    query_embedding: embedded.embedding,
    match_threshold: threshold,
    match_count: limit,
    filter_board_id: filterBoardId,
  });

  if (error) {
    if (isSchemaMissing(error)) {
      console.error("[search] The search tables don't exist yet. Run backend/migrations/enable_pgvector.sql.");
      return NextResponse.json({ error: "Search isn't set up yet." }, { status: 503 });
    }
    console.error("[search] Query failed:", error.message);
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }

  const matches = (data ?? []) as ChunkMatch[];
  // Results can span boards, and a row only carries the numeric id; the site keys on the slug.
  const slugById = new Map([...(await boardIds(db)).entries()].map(([slug, id]) => [id, slug]));
  return NextResponse.json({
    query,
    board: boardSlug,
    count: matches.length,
    results: matches.map((match) => ({
      meetingId: match.document_id,
      boardSlug: slugById.get(match.board_id) ?? null,
      title: match.title,
      meetingDate: match.meeting_date,
      agendaUrl: match.url,
      // Where in the agenda the passage came from, so a caller can show them in order.
      chunkIndex: match.chunk_index,
      similarity: Number(match.similarity.toFixed(4)),
      excerpt: match.content,
    })),
  });
}

export async function POST(request: Request) {
  // Same search, for callers that would rather send a body than a query string.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Send JSON like {"q": "school closures"}.');
  }
  const { q, board, limit, threshold } = (body ?? {}) as Record<string, unknown>;
  const url = new URL(request.url);
  if (typeof q === "string") url.searchParams.set("q", q);
  if (typeof board === "string") url.searchParams.set("board", board);
  if (typeof limit === "number") url.searchParams.set("limit", String(limit));
  if (typeof threshold === "number") url.searchParams.set("threshold", String(threshold));
  return GET(new Request(url, { headers: request.headers }));
}
