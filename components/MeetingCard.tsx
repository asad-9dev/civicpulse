import { ArrowRight } from "lucide-react";
import type { Meeting } from "@/lib/types";
import { CategoryLabel, DateBadge, TownTag, UrgencyBadge } from "./Badges";

export function SummaryList({ items, size = "card" }: { items: string[]; size?: "card" | "dialog" }) {
  const text = size === "dialog" ? "text-[17px] leading-[1.55]" : "text-base leading-normal";
  const box = size === "dialog" ? "size-7" : "size-[26px]";
  return (
    <ol className="flex flex-col gap-3">
      {items.map((item, i) => (
        <li key={i} className={`grid grid-cols-[auto_minmax(0,1fr)] gap-2.5 text-ink-body ${text}`}>
          <span
            aria-hidden
            className={`flex ${box} items-center justify-center rounded-md bg-ink font-mono text-[13px] font-semibold text-marker`}
          >
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function MeetingCard({ meeting, onOpen }: { meeting: Meeting; onOpen: (id: string) => void }) {
  return (
    // The whole card is a pointer target; the button is the keyboard and screen-reader target.
    <article
      onClick={(event) => {
        // Focus the card's button first so focus returns to it when the dialog closes.
        event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
        onOpen(meeting.id);
      }}
      className="group flex cursor-pointer flex-col gap-[18px] rounded-[14px] border border-rule bg-white p-5 shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-rule-strong hover:shadow-panel sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateBadge isoDate={meeting.meetingDate} />
        <UrgencyBadge score={meeting.urgencyScore} />
      </div>

      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-[0.06em] text-ink-muted">{meeting.committeeName}</p>
        <h3 className="text-pretty font-serif text-2xl font-semibold leading-[1.18] tracking-[-0.01em] sm:text-[25px]">
          {meeting.title}
        </h3>
        {/* Two-line preview of "What this means for students & parents"; the full text is in the
            breakdown. Built-in summaries only have placeholder text there, so they skip it. */}
        {meeting.summarySource !== "built-in" && meeting.studentParentImpact && (
          <p className="line-clamp-2 text-[15px] leading-relaxed text-ink-soft">{meeting.studentParentImpact}</p>
        )}
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label="Towns affected">
        {meeting.townsAffected.map((town) => (
          <li key={town}>
            <TownTag town={town} />
          </li>
        ))}
      </ul>

      <div className="flex-grow border-t border-rule-soft pt-[18px]">
        <h4 className="sr-only">Executive summary</h4>
        <SummaryList items={meeting.executiveSummary} />
      </div>

      <div className="flex flex-col gap-3 border-t border-rule-soft pt-[18px] sm:flex-row sm:items-center sm:justify-between">
        <CategoryLabel category={meeting.category} />
        <button
          type="button"
          onClick={() => onOpen(meeting.id)}
          aria-haspopup="dialog"
          className="inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-ink px-4 text-[15px] font-bold transition-colors duration-150 group-hover:bg-ink group-hover:text-white sm:h-11"
        >
          View full breakdown
          <span className="sr-only">: {meeting.title}</span>
          <ArrowRight aria-hidden size={17} strokeWidth={2.25} />
        </button>
      </div>
    </article>
  );
}
