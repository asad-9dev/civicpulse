/**
 * The Ontario school boards CivicPulse covers.
 *
 * This file is the source of truth. The Supabase `boards` table (backend/schema.sql) is seeded
 * from it so the database can reference boards by id, and backend/boards.py mirrors it for the
 * scraper — but nothing on the site has to reach the network to know a board's name or towns.
 *
 * Adding a board: add an entry here, mirror it in backend/boards.py, add the slug to the scrape
 * workflow's matrix, and re-run scripts/migrate-multi-board.ts to seed the row.
 */

/** Which meeting-portal software a board publishes agendas on; picks the scraper adapter. */
export type BoardPlatform = "escribe" | "civicweb" | "manual";

/**
 * Whether CivicPulse can decode this board right now.
 *   live       - agendas are being scraped and summarized
 *   supervised - the province appointed a supervisor, so trustee meetings aren't being held
 *   planned    - the board is listed, but its portal has no scraper adapter yet
 */
export type BoardStatus = "live" | "supervised" | "planned";

export interface Board {
  slug: string;
  name: string;
  /** The acronym on the header chip and in email subjects. */
  shortName: string;
  region: string;
  boardType: "public" | "catholic";
  website: string;
  /** Where agendas are published; null when the board has no public portal. */
  agendaPortal: string | null;
  platform: BoardPlatform;
  status: BoardStatus;
  /** Shown to visitors when a board has no meetings, so an empty feed explains itself. */
  statusNote?: string;
  /** Municipalities the board serves — the town filter chips for this board. */
  municipalities: string[];
}

export const BOARDS: Board[] = [
  {
    slug: "ddsb",
    name: "Durham District School Board",
    shortName: "DDSB",
    region: "Durham Region",
    boardType: "public",
    website: "https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/",
    agendaPortal: "https://calendar.ddsb.ca/meetings",
    platform: "escribe",
    status: "live",
    municipalities: ["Ajax", "Pickering", "Whitby", "Oshawa", "Uxbridge", "Brock", "Scugog"],
  },
  {
    slug: "yrdsb",
    name: "York Region District School Board",
    shortName: "YRDSB",
    region: "York Region",
    boardType: "public",
    website: "https://www2.yrdsb.ca/about-us/board-trustees/committee-meeting-dates",
    agendaPortal: "https://yrdsb.civicweb.net/Portal/MeetingSchedule.aspx",
    platform: "civicweb",
    status: "live",
    municipalities: [
      "Markham",
      "Vaughan",
      "Richmond Hill",
      "Newmarket",
      "Aurora",
      "Whitchurch-Stouffville",
      "King",
      "East Gwillimbury",
      "Georgina",
    ],
  },
  {
    slug: "tdsb",
    name: "Toronto District School Board",
    shortName: "TDSB",
    region: "Toronto",
    boardType: "public",
    website: "https://www.tdsb.on.ca/Leadership/Agendas-Minutes-Decisions",
    agendaPortal: null,
    platform: "manual",
    status: "supervised",
    statusNote:
      "The province appointed a supervisor to the TDSB in 2025. Trustee meetings are suspended, so there are no agendas to decode; the board publishes the supervisor's decisions instead.",
    municipalities: ["Toronto", "Etobicoke", "North York", "Scarborough", "York", "East York"],
  },
  {
    slug: "pdsb",
    name: "Peel District School Board",
    shortName: "PDSB",
    region: "Peel Region",
    boardType: "public",
    website: "https://www.peelschools.org/agenda-and-minutes",
    agendaPortal: null,
    platform: "manual",
    status: "supervised",
    statusNote:
      "Peel's own agenda page says regular Board of Trustees meetings are paused until further notice under direction from the Ministry of Education, so there are no agendas to decode.",
    municipalities: ["Mississauga", "Brampton", "Caledon"],
  },
];

/** The "All Ontario boards" choice, in the URL as ?board=all (or no param at all). */
export const ALL_BOARDS = "all";

export function getBoard(slug: string | null | undefined): Board | null {
  if (!slug || slug === ALL_BOARDS) return null;
  return BOARDS.find((board) => board.slug === slug) ?? null;
}

/**
 * The board a ?board= value selects, or null for every board. An unknown slug reads as "all"
 * rather than an error, so a stale or hand-edited link still shows the feed.
 */
export function resolveBoardParam(value: string | string[] | undefined): Board | null {
  return getBoard(Array.isArray(value) ? value[0] : value);
}

/** Boards with a scraper adapter, i.e. the ones that can produce meetings today. */
export function liveBoards(): Board[] {
  return BOARDS.filter((board) => board.status === "live");
}

/** Every municipality across the given boards, deduped, for the town filter. */
export function municipalitiesFor(board: Board | null): string[] {
  if (board) return board.municipalities;
  return [...new Set(BOARDS.flatMap((b) => b.municipalities))].sort((a, b) => a.localeCompare(b));
}

/** "Durham District School Board" for one board, or a phrase covering all of them. */
export function boardLabel(board: Board | null): string {
  return board ? board.name : "Ontario school boards";
}
