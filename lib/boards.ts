import config from "@/data/boards_config.json";

/**
 * The Ontario school boards CivicPulse knows about.
 *
 * The data itself lives in data/boards_config.json, which backend/boards.py reads too — one file
 * rather than a TypeScript list and a Python list that drift apart across 72 boards. The names,
 * regions, types and websites come from the Ontario Ministry of Education's board contact list;
 * portal_type and seed_url were found by crawling each board's own site.
 *
 * Adding or correcting a board is an edit to that JSON file; nothing here needs to change.
 */

/** Which meeting-portal software a board publishes agendas on; picks the scraper adapter. */
export type BoardPlatform = "escribe" | "civicweb" | "boarddocs" | "generic_pdf" | "unknown";

/**
 * Whether CivicPulse can decode this board right now.
 *   live       - a portal was found and an adapter can read it
 *   supervised - the province appointed a supervisor, so trustee meetings aren't being held
 *   planned    - registered, but no portal found yet or no adapter for the one it uses
 */
export type BoardStatus = "live" | "supervised" | "planned";

export interface Board {
  slug: string;
  name: string;
  /** The acronym on the header chip and in email subjects. */
  shortName: string;
  region: string;
  boardType: "public" | "catholic";
  language: "english" | "french";
  website: string;
  /** Where agendas are published; null when no portal has been found. */
  agendaPortal: string | null;
  platform: BoardPlatform;
  status: BoardStatus;
  /** Shown to visitors when a board has no meetings, so an empty feed explains itself. */
  statusNote?: string;
  /** Municipalities the board serves — the town filter chips. Empty when not yet mapped. */
  municipalities: string[];
}

interface RawBoard {
  slug: string;
  name: string;
  short_name: string;
  region: string;
  board_type: string;
  language: string;
  website: string;
  portal_type: string | null;
  seed_url: string | null;
  status: string;
  status_note?: string;
  municipalities?: string[];
}

const PLATFORMS = new Set<BoardPlatform>(["escribe", "civicweb", "boarddocs", "generic_pdf", "unknown"]);
const STATUSES = new Set<BoardStatus>(["live", "supervised", "planned"]);

function toBoard(raw: RawBoard): Board {
  const platform = (raw.portal_type ?? "unknown") as BoardPlatform;
  const status = raw.status as BoardStatus;
  return {
    slug: raw.slug,
    name: raw.name,
    shortName: raw.short_name,
    region: raw.region,
    boardType: raw.board_type === "catholic" ? "catholic" : "public",
    language: raw.language === "french" ? "french" : "english",
    website: raw.website,
    agendaPortal: raw.seed_url,
    platform: PLATFORMS.has(platform) ? platform : "unknown",
    status: STATUSES.has(status) ? status : "planned",
    statusNote: raw.status_note,
    municipalities: raw.municipalities ?? [],
  };
}

export const BOARDS: Board[] = (config.boards as RawBoard[]).map(toBoard);

/** Where the registry came from, shown on the boards page so the list can be checked. */
export const BOARDS_SOURCE: { source: string; generated: string } = {
  source: config.source,
  generated: config.generated,
};

const BY_SLUG = new Map(BOARDS.map((board) => [board.slug, board]));

/** The "All Ontario boards" choice, in the URL as ?board=all (or no param at all). */
export const ALL_BOARDS = "all";

export function getBoard(slug: string | null | undefined): Board | null {
  if (!slug || slug === ALL_BOARDS) return null;
  return BY_SLUG.get(slug) ?? null;
}

/**
 * The board a ?board= value selects, or null for every board. An unknown slug reads as "all"
 * rather than an error, so a stale or hand-edited link still shows the feed.
 */
export function resolveBoardParam(value: string | string[] | undefined): Board | null {
  return getBoard(Array.isArray(value) ? value[0] : value);
}

/** Boards being decoded today, i.e. the ones that can produce meetings. */
export function liveBoards(): Board[] {
  return BOARDS.filter((board) => board.status === "live");
}

/**
 * Every municipality across the given boards, deduped, for the town filter. Empty when the
 * boards in view have no municipalities mapped, and the filter hides itself.
 */
export function municipalitiesFor(board: Board | null): string[] {
  if (board) return board.municipalities;
  return [...new Set(BOARDS.flatMap((b) => b.municipalities))].sort((a, b) => a.localeCompare(b));
}

/** "Durham District School Board" for one board, or a phrase covering all of them. */
export function boardLabel(board: Board | null): string {
  return board ? board.name : "Ontario school boards";
}
