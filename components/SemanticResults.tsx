import { ArrowRight, ExternalLink, Sparkles } from "lucide-react";
import { snippet, type MeetingGroup } from "@/lib/useSemanticSearch";
import { BoardTag, DateBadge } from "./Badges";

/** How many matching passages to quote under each meeting before it gets long. */
const PASSAGES_SHOWN = 2;

/**
 * Similarity as a percentage, with a band for the badge colour.
 *
 * The number is the cosine similarity itself, not rescaled to look more impressive: the search
 * only returns passages at 60% or above, so a 68% match is a genuinely close one.
 */
function matchLevel(similarity: number): { label: string; className: string } {
  const percent = Math.round(similarity * 100);
  if (similarity >= 0.7) {
    return { label: `${percent}% match`, className: "border-ink bg-ink text-white" };
  }
  if (similarity >= 0.65) {
    return { label: `${percent}% match`, className: "border-civic bg-white text-civic" };
  }
  return { label: `${percent}% match`, className: "border-rule-strong bg-white text-ink-soft" };
}

export function SemanticSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4 sm:gap-5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex animate-pulse flex-col gap-4 rounded-[14px] border border-rule bg-white p-5 shadow-card sm:p-6"
          style={{ animationDelay: `${i * 120}ms` }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <div className="h-[30px] w-28 rounded-md bg-chip" />
              <div className="h-[22px] w-14 self-center rounded bg-chip" />
            </div>
            <div className="h-7 w-24 rounded-full bg-chip" />
          </div>
          <div className="h-6 w-3/4 rounded bg-chip" />
          <div className="flex flex-col gap-2">
            <div className="h-4 w-full rounded bg-chip" />
            <div className="h-4 w-11/12 rounded bg-chip" />
            <div className="h-4 w-2/3 rounded bg-chip" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Excerpt({ passage, query }: { passage: string; query: string }) {
  return (
    <blockquote className="border-l-[3px] border-marker pl-3.5 text-[15px] leading-relaxed text-ink-body">
      {snippet(passage, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-sm bg-marker/60 px-0.5 text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </blockquote>
  );
}

export function SemanticResults({
  groups,
  query,
  feedIds,
  onOpen,
}: {
  groups: MeetingGroup[];
  query: string;
  /** Meetings present in the feed below, which can open their full breakdown. */
  feedIds: Set<string>;
  onOpen: (id: string) => void;
}) {
  return (
    <ol className="flex flex-col gap-4 sm:gap-5">
      {groups.map((group) => {
        const level = matchLevel(group.best);
        const extra = group.passages.length - PASSAGES_SHOWN;
        return (
          <li key={group.meetingId}>
            <article className="flex flex-col gap-4 rounded-[14px] border border-rule bg-white p-5 shadow-card sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <DateBadge isoDate={group.meetingDate} />
                  {group.boardSlug && <BoardTag slug={group.boardSlug} />}
                </div>
                <span
                  className={`inline-flex h-7 items-center gap-1.5 rounded-full border-[1.5px] px-2.5 font-mono text-[12px] font-semibold ${level.className}`}
                >
                  <Sparkles aria-hidden size={13} strokeWidth={2.25} />
                  {level.label}
                </span>
              </div>

              <h3 className="text-pretty font-serif text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] sm:text-2xl">
                {group.title}
              </h3>

              <div className="flex flex-col gap-3">
                <p className="eyebrow">
                  {group.passages.length === 1 ? "Matching passage" : `Matching passages · ${group.passages.length}`}
                </p>
                {group.passages.slice(0, PASSAGES_SHOWN).map((passage) => (
                  <Excerpt key={passage.chunkIndex} passage={passage.excerpt} query={query} />
                ))}
                {extra > 0 && (
                  <p className="text-sm text-ink-muted">
                    +{extra} more matching passage{extra === 1 ? "" : "s"} in this agenda
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2.5 border-t border-rule-soft pt-4 sm:flex-row sm:items-center sm:justify-between">
                {group.agendaUrl ? (
                  <a
                    href={group.agendaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-2 text-[15px] font-bold text-civic hover:text-ink"
                  >
                    Read the original agenda
                    <ExternalLink aria-hidden size={16} strokeWidth={2.25} />
                    <span className="sr-only">: {group.title} (opens in a new tab)</span>
                  </a>
                ) : (
                  <span />
                )}
                {feedIds.has(group.meetingId) && (
                  <button
                    type="button"
                    onClick={() => onOpen(group.meetingId)}
                    aria-haspopup="dialog"
                    className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-[10px] border-[1.5px] border-ink px-4 text-[15px] font-bold transition-colors hover:bg-ink hover:text-white"
                  >
                    View the 3-point breakdown
                    <span className="sr-only">: {group.title}</span>
                    <ArrowRight aria-hidden size={17} strokeWidth={2.25} />
                  </button>
                )}
              </div>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
