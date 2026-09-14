"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, RotateCcw, Search, SearchX } from "lucide-react";
import { CATEGORIES, TOWNS, type Meeting } from "@/lib/types";
import { MeetingCard } from "./MeetingCard";
import { MeetingDialog } from "./MeetingDialog";

const ALL = "All";

function FilterGroup({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const labelId = `filter-${legend.toLowerCase()}`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:items-start sm:gap-4"
    >
      <span id={labelId} className="eyebrow sm:pt-3">
        {legend}
      </span>
      <div className="flex flex-wrap gap-2">
        {[ALL, ...options].map((option) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option)}
              className={`inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] px-4 text-[15px] transition-colors duration-150 sm:h-10 ${
                selected
                  ? "border-ink bg-ink font-bold text-white"
                  : "border-rule-strong bg-white text-ink hover:border-ink"
              }`}
            >
              {selected && <Check aria-hidden size={15} strokeWidth={3} className="text-marker" />}
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function matchesQuery(meeting: Meeting, query: string): boolean {
  if (!query) return true;
  const haystack = [
    meeting.title,
    meeting.committeeName,
    meeting.category,
    meeting.studentParentImpact,
    meeting.policyChanges,
    ...meeting.townsAffected,
    ...meeting.executiveSummary,
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

export function MeetingExplorer({ meetings }: { meetings: Meeting[] }) {
  const [query, setQuery] = useState("");
  const [town, setTown] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim();
    return meetings.filter(
      (m) =>
        (town === ALL || m.townsAffected.includes(town)) &&
        (category === ALL || m.category === category) &&
        matchesQuery(m, q),
    );
  }, [meetings, query, town, category]);

  const openMeeting = meetings.find((m) => m.id === openId) ?? null;
  const isFiltered = query.trim() !== "" || town !== ALL || category !== ALL;

  // Deep link: ?meeting=<id> opens that breakdown, so a decision can be shared.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("meeting");
    if (id && meetings.some((m) => m.id === id)) setOpenId(id);
  }, [meetings]);

  const setOpen = useCallback((id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("meeting", id);
    else url.searchParams.delete("meeting");
    window.history.replaceState(null, "", url);
  }, []);

  const resetFilters = () => {
    setQuery("");
    setTown(ALL);
    setCategory(ALL);
  };

  return (
    <>
      <section aria-label="Search and filter meetings" className="page-container pt-7 lg:pt-[60px]">
        <div className="flex flex-col gap-4 rounded-[14px] border border-rule bg-white p-[18px] shadow-panel sm:gap-5 sm:rounded-2xl sm:px-7 sm:py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
            <div className="flex flex-grow flex-col gap-2">
              <label htmlFor="meeting-search" className="text-[15px] font-bold">
                Search summaries
              </label>
              <div className="flex h-[52px] items-center gap-3 rounded-[10px] border-[1.5px] border-rule-field bg-white px-4 focus-within:border-ink focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-civic">
                <Search aria-hidden size={20} strokeWidth={2} className="text-ink-soft" />
                <input
                  id="meeting-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Try “boundaries” or “bus routes”"
                  autoComplete="off"
                  className="h-full w-full bg-transparent text-[17px] text-ink placeholder:text-ink-muted focus:outline-none"
                />
              </div>
            </div>
            <p aria-live="polite" className="text-[17px] sm:min-w-[170px] sm:pb-2 sm:text-right">
              <span className="eyebrow hidden sm:block">Showing</span>
              <span className="sm:hidden">Showing </span>
              <strong>{visible.length}</strong> of {meetings.length} meetings
            </p>
          </div>

          <div className="h-px bg-rule-soft" />

          <div className="flex flex-col gap-4 sm:gap-3.5">
            <FilterGroup legend="Town" options={TOWNS} value={town} onChange={setTown} />
            <FilterGroup legend="Category" options={CATEGORIES} value={category} onChange={setCategory} />
          </div>
        </div>
      </section>

      <section id="meetings" aria-labelledby="feed-heading" className="page-container scroll-mt-6 pt-12 lg:pt-[72px]">
        <div className="mb-4 flex items-baseline justify-between border-b-2 border-ink pb-2.5 sm:mb-6 sm:pb-3.5">
          <h2 id="feed-heading" className="font-serif text-[30px] font-semibold tracking-[-0.015em] sm:text-[40px]">
            Latest decisions
          </h2>
          <span className="hidden font-mono text-[13px] uppercase tracking-[0.08em] text-ink-muted sm:inline">
            Newest first
          </span>
        </div>

        {meetings.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-[14px] border border-dashed border-rule-strong bg-white px-6 py-14 text-center">
            <CalendarClock aria-hidden size={32} strokeWidth={1.75} className="text-ink-muted" />
            <div className="flex flex-col gap-1.5">
              <p className="font-serif text-2xl font-semibold">No meetings decoded yet</p>
              <p className="max-w-md text-base text-ink-soft">
                Summaries appear here after the board posts its next agenda. Subscribe below to get them by email.
              </p>
            </div>
          </div>
        ) : visible.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 sm:gap-6 lg:grid-cols-3">
            {visible.map((meeting) => (
              <MeetingCard key={meeting.id} meeting={meeting} onOpen={setOpen} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 rounded-[14px] border border-dashed border-rule-strong bg-white px-6 py-14 text-center">
            <SearchX aria-hidden size={32} strokeWidth={1.75} className="text-ink-muted" />
            <div className="flex flex-col gap-1.5">
              <p className="font-serif text-2xl font-semibold">No decisions match those filters</p>
              <p className="max-w-md text-base text-ink-soft">
                {category !== ALL && !query.trim()
                  ? `None of the recent meetings made a ${category} decision${town !== ALL ? ` affecting ${town}` : ""}.`
                  : "Try a different word, or widen the town and category filters."}
              </p>
            </div>
            {isFiltered && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-[10px] border-[1.5px] border-ink px-4 text-[15px] font-bold transition-colors hover:bg-ink hover:text-white"
              >
                <RotateCcw aria-hidden size={16} strokeWidth={2.25} />
                Clear search and filters
              </button>
            )}
          </div>
        )}
      </section>

      <MeetingDialog meeting={openMeeting} onClose={() => setOpen(null)} />
    </>
  );
}
