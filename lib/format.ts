const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-09-08" -> "Sep 8, 2026" (parsed as UTC so it never shifts a day). */
export function formatMeetingDate(isoDate: string): string {
  return dateFormatter.format(new Date(`${isoDate}T00:00:00Z`));
}

export type UrgencyLevel = "high" | "medium" | "low";

export function urgencyLevel(score: number): UrgencyLevel {
  if (score >= 4) return "high";
  if (score === 3) return "medium";
  return "low";
}
