import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Meeting } from "./types";

const MEETINGS_PATH = path.join(process.cwd(), "public", "data", "meetings.json");

/**
 * Reads the meetings the Python pipeline writes to public/data/meetings.json.
 * Read on every request so a fresh scrape shows up without a rebuild.
 */
export async function getMeetings(): Promise<Meeting[]> {
  const raw = await readFile(MEETINGS_PATH, "utf8");
  const meetings = JSON.parse(raw) as Meeting[];
  return meetings.sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
}
