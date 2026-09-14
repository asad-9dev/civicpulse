export const TOWNS = ["Ajax", "Pickering", "Whitby", "Oshawa", "Uxbridge"] as const;
export const CATEGORIES = ["Boundary Review", "Transport", "Policy", "Budget"] as const;

export type Town = (typeof TOWNS)[number];
export type Category = (typeof CATEGORIES)[number];

/** One decoded trustee meeting — the shape of public/data/meetings.json. */
export interface Meeting {
  id: string;
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
}
