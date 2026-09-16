"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Landmark, PauseCircle, Search } from "lucide-react";
import { ALL_BOARDS, type Board } from "@/lib/boards";

/**
 * Which school board the feed is showing. The choice lives in the URL (?board=ddsb, or no
 * param for every board), so it survives a reload and can be linked to or bookmarked.
 *
 * With 72 boards a plain list is unusable, so this is a combobox: type to narrow, and the
 * boards being decoded are grouped above the ones that aren't. That means owning the keyboard
 * behaviour a <select> gives for free: arrows, Home/End, Escape, Enter and focus return.
 */

interface Option {
  slug: string;
  label: string;
  detail: string;
  count: number;
  paused: boolean;
  /** Matched against what the person types. */
  haystack: string;
}

type Group = { heading: string; options: Option[] };

function toOption(board: Board, counts: Record<string, number>): Option {
  return {
    slug: board.slug,
    label: board.name,
    detail: board.region,
    count: counts[board.slug] ?? 0,
    paused: board.status !== "live",
    haystack: `${board.name} ${board.shortName} ${board.region} ${board.slug}`.toLowerCase(),
  };
}

function buildGroups(boards: Board[], counts: Record<string, number>, query: string): Group[] {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const everything: Option = {
    slug: ALL_BOARDS,
    label: "All Ontario boards",
    detail: `${boards.length} boards`,
    count: total,
    paused: false,
    haystack: "all ontario boards everything",
  };

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (option: Option) => terms.every((term) => option.haystack.includes(term));

  const decoded = boards.filter((b) => b.status === "live").map((b) => toOption(b, counts));
  const paused = boards.filter((b) => b.status === "supervised").map((b) => toOption(b, counts));
  const rest = boards.filter((b) => b.status === "planned").map((b) => toOption(b, counts));

  return [
    { heading: "", options: [everything].filter(matches) },
    { heading: "Decoded now", options: decoded.filter(matches) },
    { heading: "Meetings paused", options: paused.filter(matches) },
    { heading: "Not decoded yet", options: rest.filter(matches) },
  ].filter((group) => group.options.length > 0);
}

export function BoardSelector({
  boards,
  active,
  counts,
}: {
  boards: Board[];
  /** null means every board. */
  active: Board | null;
  /** Decoded meetings per board slug, for the count beside each option. */
  counts: Record<string, number>;
}) {
  const router = useRouter();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => buildGroups(boards, counts, query), [boards, counts, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const activeSlug = active?.slug ?? ALL_BOARDS;

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setQuery("");
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const choose = useCallback(
    (slug: string) => {
      close();
      // Switching boards drops ?meeting=, since an open breakdown belongs to the board it came from.
      router.push(slug === ALL_BOARDS ? "/" : `/?board=${slug}`, { scroll: false });
    },
    [close, router],
  );

  // Open with the current choice focused and the search box ready to type into.
  useEffect(() => {
    if (!open) return;
    const index = flat.findIndex((option) => option.slug === activeSlug);
    setFocused(index === -1 ? 0 : index);
    inputRef.current?.focus();
    // Only on open: re-running as the query changes would fight the keyboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Narrowing the list can leave the highlight past its end.
  useEffect(() => {
    setFocused((current) => (current >= flat.length ? 0 : current));
  }, [flat.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  // Keep the highlighted option in view while arrowing through 72 boards.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector(`#${CSS.escape(`${listId}-${focused}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [focused, open, listId]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = flat.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(focused + 1, last),
      ArrowUp: Math.max(focused - 1, 0),
      Home: 0,
      End: last,
    };
    if (event.key in moves && last >= 0) {
      event.preventDefault();
      setFocused(moves[event.key]);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (flat[focused]) choose(flat[focused].slug);
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  };

  let index = -1;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`School board: ${active ? active.name : "all Ontario boards"}. Change board`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] border-ink px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-white sm:text-[12px]"
      >
        {active ? active.shortName : "Ontario"}
        <ChevronDown aria-hidden size={14} strokeWidth={2.5} className={open ? "rotate-180" : undefined} />
      </button>

      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          className="absolute left-0 z-40 mt-2 w-[300px] rounded-xl border border-rule-strong bg-white p-1.5 shadow-modal sm:w-[340px]"
        >
          <div className="flex h-11 items-center gap-2 rounded-lg border-[1.5px] border-rule-field px-3 focus-within:border-ink">
            <Search aria-hidden size={16} strokeWidth={2} className="shrink-0 text-ink-soft" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={flat[focused] ? `${listId}-${focused}` : undefined}
              aria-label="Search school boards"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search 72 boards…"
              className="h-full w-full bg-transparent text-[15px] text-ink placeholder:text-ink-muted focus:outline-none"
            />
          </div>

          <ul id={listId} role="listbox" aria-label="School board" className="mt-1.5 max-h-[52vh] overflow-y-auto overscroll-contain">
            {flat.length === 0 && (
              <li className="px-2.5 py-6 text-center text-[15px] text-ink-soft">No board matches “{query}”.</li>
            )}
            {groups.map((group) => (
              <li key={group.heading || "current"}>
                {group.heading && (
                  <p className="eyebrow px-2.5 pb-1 pt-3" role="presentation">
                    {group.heading}
                  </p>
                )}
                <ul role="group" aria-label={group.heading || undefined}>
                  {group.options.map((option) => {
                    index += 1;
                    const position = index;
                    const selected = option.slug === activeSlug;
                    return (
                      <li
                        key={option.slug}
                        id={`${listId}-${position}`}
                        role="option"
                        aria-selected={selected}
                        onClick={() => choose(option.slug)}
                        onMouseEnter={() => setFocused(position)}
                        className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 ${
                          position === focused ? "bg-chip" : ""
                        }`}
                      >
                        <span aria-hidden className="flex w-[18px] shrink-0 justify-center text-civic">
                          {selected ? <Check size={17} strokeWidth={3} /> : null}
                        </span>
                        <span className="flex min-w-0 flex-grow flex-col">
                          <span className="truncate text-[15px] font-bold leading-tight">{option.label}</span>
                          <span className="flex items-center gap-1.5 truncate text-[13px] text-ink-soft">
                            {option.paused && <PauseCircle aria-hidden size={13} strokeWidth={2.25} className="shrink-0" />}
                            {option.paused ? "Meetings paused" : option.detail}
                          </span>
                        </span>
                        {option.count > 0 && (
                          <span className="shrink-0 font-mono text-[12px] text-ink-muted">{option.count}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The board name beside the CivicPulse wordmark, with no switcher (used in the footer). */
export function BoardMark({ board }: { board: Board | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border-[1.5px] border-ink px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-tight tracking-[0.1em] sm:text-[11px]">
      <Landmark aria-hidden size={11} strokeWidth={2.5} />
      {board ? board.shortName : "ONTARIO"}
    </span>
  );
}
