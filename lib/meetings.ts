import { readFile } from "node:fs/promises";
import path from "node:path";
import { BOARDS, type Board } from "./boards";
import type { Meeting } from "./types";

/**
 * Decoded meetings, as the Python pipeline writes them.
 *
 * One file per board (public/data/boards/ddsb.json, .../yrdsb.json, ...) rather than one shared
 * file, so each board's scrape job writes its own file and two jobs finishing at once can't
 * collide on the same commit. Files are read on every request, so a fresh scrape shows up
 * without a rebuild.
 */

const BOARDS_DIR = path.join(process.cwd(), "public", "data", "boards");

function boardFile(slug: string): string {
  return path.join(BOARDS_DIR, `${slug}.json`);
}

/** One board's meetings, or [] when it has no file yet (nothing decoded, or no adapter). */
async function readBoardFile(board: Board): Promise<Meeting[]> {
  let raw: string;
  try {
    raw = await readFile(boardFile(board.slug), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const meetings = JSON.parse(raw) as Meeting[];
  // The file is the pipeline's output and shouldn't disagree with its own name, but the slug is
  // what every filter keys on, so fill it in rather than trusting it to be there.
  return meetings.map((meeting) => ({ ...meeting, boardSlug: meeting.boardSlug || board.slug }));
}

/**
 * Decoded meetings, newest first: one board's when given a board, every board's when given null.
 */
export async function getMeetings(board: Board | null = null): Promise<Meeting[]> {
  const files = await Promise.all((board ? [board] : BOARDS).map(readBoardFile));
  return files.flat().sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
}

/** How many meetings each board has decoded, for the board switcher's counts. */
export async function countMeetingsByBoard(): Promise<Record<string, number>> {
  const counts = await Promise.all(
    BOARDS.map(async (board) => [board.slug, (await readBoardFile(board)).length] as const),
  );
  return Object.fromEntries(counts);
}
