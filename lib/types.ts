export const CATEGORIES = ["Boundary Review", "Transport", "Policy", "Budget"] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * One decoded trustee meeting — the shape of the per-board files in public/data/boards/.
 *
 * The towns a meeting can affect depend on its board, so they're plain strings here and the
 * filter chips come from the board's municipalities (lib/boards.ts).
 */
export interface Meeting {
  id: string;
  /** Which board held the meeting; matches Board.slug in lib/boards.ts. */
  boardSlug: string;
  /** ISO date, e.g. "2026-09-08". */
  meetingDate: string;
  committeeName: string;
  title: string;
  /** 1 (low) to 5 (act now). */
  urgencyScore: number;
  townsAffected: string[];
  category: Category;
  executiveSummary: string[];
  studentParentImpact: string;
  policyChanges: string;
  originalPdfUrl: string;
  /** Which summarizer wrote this record: "gemini", "claude" or "built-in". */
  summarySource?: string;
}
