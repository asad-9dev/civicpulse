"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ExternalLink, Info, PauseCircle, RotateCcw, Search, SearchX, Sparkles } from "lucide-react";
import { getBoard, municipalitiesFor, type Board } from "@/lib/boards";
import { CATEGORIES, type Meeting } from "@/lib/types";
import { MIN_SEMANTIC_QUERY, groupByMeeting, useSemanticSearch } from "@/lib/useSemanticSearch";
import { MeetingCard } from "./MeetingCard";
import { MeetingDialog } from "./MeetingDialog";
import { SemanticResults, SemanticSkeleton } from "./SemanticResults";

type SearchMode = "keyword" | "semantic";

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

/**
 * Keyword search filters the summaries already on the page; AI search reads the full agendas
 * through /api/search. Native radio inputs, styled as a segmented control, so arrow keys and
 * screen readers work without any code for them.
 */
function ModeToggle({ mode, onChange }: { mode: SearchMode; onChange: (mode: SearchMode) => void }) {
  const options: { value: SearchMode; label: string; hint: string }[] = [
    { value: "keyword", label: "Keyword", hint: "Match words in the summaries" },
    { value: "semantic", label: "AI search", hint: "Find meaning in the full agendas" },
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">Search mode</legend>
      <div className="inline-flex w-full rounded-[10px] border-[1.5px] border-rule-field bg-paper p-1 sm:w-auto">
        {options.map((option) => {
          const checked = mode === option.value;
          return (
            <label
              key={option.value}
              title={option.hint}
              className={`relative flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] px-3.5 sm:h-10 text-[15px] transition-colors duration-150 focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-civic sm:flex-none ${
                checked ? "bg-ink font-bold text-white shadow-card" : "text-ink-soft hover:text-ink"
              }`}
            >
              <input
                type="radio"
                name="search-mode"
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.value === "semantic" ? (
                <Sparkles aria-hidden size={15} strokeWidth={2.25} className={checked ? "text-marker" : undefined} />
              ) : (
                <Search aria-hidden size={15} strokeWidth={2.25} />
              )}
              {option.label}
              <span className="sr-only">: {option.hint}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function matchesQuery(meeting: Meeting, query: string): boolean {
  if (!query) return true;
  const board = getBoard(meeting.boardSlug);
  const haystack = [
    meeting.title,
    meeting.committeeName,
    meeting.category,
    meeting.studentParentImpact,
    meeting.policyChanges,
    // So "york" or "yrdsb" finds a board's meetings while every board is showing.
    board?.name ?? "",
    board?.shortName ?? "",
    board?.region ?? "",
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

export function MeetingExplorer({ meetings, board }: { meetings: Meeting[]; board: Board | null }) {
  const [query, setQuery] = useState("");
  const [town, setTown] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>("keyword");

  const towns = useMemo(() => municipalitiesFor(board), [board]);

  const semantic = useSemanticSearch(query, board?.slug ?? null, mode === "semantic");
  const semanticQueryReady = mode === "semantic" && query.trim().length >= MIN_SEMANTIC_QUERY;
  const groups = useMemo(() => (semantic.status === "done" ? groupByMeeting(semantic.hits) : []), [semantic]);
  // AI search falls back to keyword matching when it can't answer or finds nothing close enough,
  // so a search never ends on an empty page when the summaries do mention the words.
  const semanticFailed = semanticQueryReady && semantic.status === "error";
  const semanticEmpty = semanticQueryReady && semantic.status === "done" && groups.length === 0;
  const showingSemantic = semanticQueryReady && semantic.status === "done" && groups.length > 0;
  const feedIds = useMemo(() => new Set(meetings.map((m) => m.id)), [meetings]);

  // The town and category chips are hidden in AI mode, so a fallback must not apply filters the
  // reader can no longer see.
  const keywordOnly = useMemo(() => {
    const q = query.trim();
    return meetings.filter((m) => matchesQuery(m, q));
  }, [meetings, query]);

  // Switching boards leaves a town selected that the new board doesn't serve, which would hide
  // every meeting. Start each board with its towns unfiltered.
  useEffect(() => {
    setTown(ALL);
  }, [board?.slug]);

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
  const fallbackList = mode === "semantic" ? keywordOnly : visible;

  // Deep link: ?meeting=<id> opens that breakdown, so a decision can be shared. Meeting ids
  // gained a board prefix in the multi-board expansion, so links sent in earlier emails
  // ("2026-09-10-seac") are matched against the prefixed id too.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("meeting");
    if (!id) return;
    const match = meetings.find((m) => m.id === id) ?? meetings.find((m) => m.id.endsWith(`-${id}`));
    if (match) setOpenId(match.id);
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
          <ModeToggle mode={mode} onChange={setMode} />

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
            <div className="flex flex-grow flex-col gap-2">
              <label htmlFor="meeting-search" className="text-[15px] font-bold">
                {mode === "semantic" ? "Search the full agendas" : "Search summaries"}
              </label>
              <div className="flex h-[52px] items-center gap-3 rounded-[10px] border-[1.5px] border-rule-field bg-white px-4 focus-within:border-ink focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-civic">
                <Search aria-hidden size={20} strokeWidth={2} className="text-ink-soft" />
                <input
                  id="meeting-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    mode === "semantic" ? "Describe a topic, e.g. “changes to bus routes”" : "Try “boundaries” or “bus routes”"
                  }
                  aria-describedby={mode === "semantic" ? "semantic-hint" : undefined}
                  autoComplete="off"
                  className="h-full w-full bg-transparent text-[17px] text-ink placeholder:text-ink-muted focus:outline-none"
                />
              </div>
            </div>
            <p aria-live="polite" className="text-[17px] sm:min-w-[170px] sm:pb-2 sm:text-right">
              {semanticQueryReady && semantic.status === "loading" ? (
                <>
                  <span className="eyebrow hidden sm:block">AI search</span>
                  Searching agendas…
                </>
              ) : showingSemantic ? (
                <>
                  <span className="eyebrow hidden sm:block">AI search</span>
                  <strong>{groups.length}</strong> meeting{groups.length === 1 ? "" : "s"} matched
                </>
              ) : (
                <>
                  <span className="eyebrow hidden sm:block">Showing</span>
                  <span className="sm:hidden">Showing </span>
                  <strong>{fallbackList.length}</strong> of {meetings.length} meetings
                </>
              )}
            </p>
          </div>

          {mode === "semantic" ? (
            <p id="semantic-hint" className="flex items-start gap-2 text-sm leading-relaxed text-ink-soft">
              <Info aria-hidden size={16} strokeWidth={2.25} className="mt-0.5 shrink-0" />
              <span>
                AI search reads the full text of each agenda, not just the summary, and finds passages about your topic
                even when they use different words
                {board ? ` — within the ${board.shortName} only` : ""}.
              </span>
            </p>
          ) : (
            <>
              <div className="h-px bg-rule-soft" />

              <div className="flex flex-col gap-4 sm:gap-3.5">
                {towns.length > 0 && <FilterGroup legend="Town" options={towns} value={town} onChange={setTown} />}
                <FilterGroup legend="Category" options={CATEGORIES} value={category} onChange={setCategory} />
              </div>
            </>
          )}
        </div>
      </section>

      <section id="meetings" aria-labelledby="feed-heading" className="page-container scroll-mt-6 pt-12 lg:pt-[72px]">
        <div className="mb-4 flex items-baseline justify-between border-b-2 border-ink pb-2.5 sm:mb-6 sm:pb-3.5">
          <h2 id="feed-heading" className="font-serif text-[30px] font-semibold tracking-[-0.015em] sm:text-[40px]">
            {semanticQueryReady && !semanticFailed && !semanticEmpty ? "Closest matches" : "Latest decisions"}
          </h2>
          <span className="hidden font-mono text-[13px] uppercase tracking-[0.08em] text-ink-muted sm:inline">
            {semanticQueryReady && !semanticFailed && !semanticEmpty ? "Most relevant first" : "Newest first"}
          </span>
        </div>

        {meetings.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-[14px] border border-dashed border-rule-strong bg-white px-6 py-14 text-center">
            {board?.statusNote ? (
              <PauseCircle aria-hidden size={32} strokeWidth={1.75} className="text-ink-muted" />
            ) : (
              <CalendarClock aria-hidden size={32} strokeWidth={1.75} className="text-ink-muted" />
            )}
            <div className="flex flex-col gap-1.5">
              <p className="font-serif text-2xl font-semibold">
                {board?.statusNote ? `${board.shortName} trustee meetings are paused` : "No meetings decoded yet"}
              </p>
              <p className="max-w-lg text-base text-ink-soft">
                {board?.statusNote ??
                  "Summaries appear here after the board posts its next agenda. Subscribe below to get them by email."}
              </p>
            </div>
            {board && (
              <a
                href={board.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 text-[15px] font-bold text-civic hover:text-ink"
              >
                Check {board.shortName} directly
                <ExternalLink aria-hidden size={16} strokeWidth={2.25} />
              </a>
            )}
          </div>
        ) : semanticQueryReady && semantic.status === "loading" ? (
          <div aria-busy="true">
            <p role="status" className="sr-only">
              Searching the full agendas…
            </p>
            <SemanticSkeleton />
          </div>
        ) : showingSemantic ? (
          <SemanticResults groups={groups} query={query.trim()} feedIds={feedIds} onOpen={setOpen} />
        ) : fallbackList.length > 0 ? (
          <div className="flex flex-col gap-4 sm:gap-6">
            {(semanticFailed || semanticEmpty) && (
              <p
                role="status"
                className="flex items-start gap-2.5 rounded-[10px] border border-rule-strong bg-white px-4 py-3 text-[15px] leading-relaxed text-ink-soft"
              >
                <Info aria-hidden size={18} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ink" />
                <span>
                  {semanticFailed
                    ? "AI search isn't available right now, so these are keyword matches from the summaries instead."
                    : `No passage in the full agendas was a close match for “${query.trim()}”. These summaries mention it instead.`}
                </span>
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 sm:gap-6 lg:grid-cols-3">
              {fallbackList.map((meeting) => (
                <MeetingCard key={meeting.id} meeting={meeting} onOpen={setOpen} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 rounded-[14px] border border-dashed border-rule-strong bg-white px-6 py-14 text-center">
            <SearchX aria-hidden size={32} strokeWidth={1.75} className="text-ink-muted" />
            <div className="flex flex-col gap-1.5">
              <p className="font-serif text-2xl font-semibold">
                {semanticFailed || semanticEmpty ? `Nothing found for “${query.trim()}”` : "No decisions match those filters"}
              </p>
              <p className="max-w-md text-base text-ink-soft">
                {semanticFailed
                  ? "AI search isn't available right now, and no summary mentions those words. Try again in a moment."
                  : semanticEmpty
                  ? "Neither the full agendas nor the summaries had a close match. Try describing the topic differently."
                  : category !== ALL && !query.trim()
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
