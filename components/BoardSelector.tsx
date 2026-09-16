"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Landmark, PauseCircle } from "lucide-react";
import { ALL_BOARDS, type Board } from "@/lib/boards";

/**
 * Which school board the feed is showing. The choice lives in the URL (?board=ddsb, or no
 * param for every board), so it survives a reload and can be linked to or bookmarked.
 *
 * A listbox rather than a <select> because each option carries a region, a meeting count and
 * sometimes a "paused" marker, which a native option can't show. That means owning the keyboard
 * behaviour a <select> gives for free: arrows, Home/End, Escape, Enter and focus return.
 */

interface Option {
  slug: string;
  label: string;
  detail: string;
  count: number;
  paused: boolean;
}

function optionsFor(boards: Board[], counts: Record<string, number>, total: number): Option[] {
  return [
    { slug: ALL_BOARDS, label: "All Ontario boards", detail: `${boards.length} boards`, count: total, paused: false },
    ...boards.map((board) => ({
      slug: board.slug,
      label: board.name,
      detail: board.region,
      count: counts[board.slug] ?? 0,
      paused: board.status !== "live",
    })),
  ];
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
  const [focused, setFocused] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const options = optionsFor(boards, counts, total);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.slug === (active?.slug ?? ALL_BOARDS)),
  );

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
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

  // Open the list with the current choice focused, and move real focus into it for screen readers.
  useEffect(() => {
    if (!open) return;
    setFocused(activeIndex);
    listRef.current?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!listRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  const onListKeyDown = (event: React.KeyboardEvent) => {
    const last = options.length - 1;
    const keys: Record<string, number> = {
      ArrowDown: Math.min(focused + 1, last),
      ArrowUp: Math.max(focused - 1, 0),
      Home: 0,
      End: last,
    };
    if (event.key in keys) {
      event.preventDefault();
      setFocused(keys[event.key]);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(options[focused].slug);
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`School board: ${active ? active.name : "all Ontario boards"}. Change board`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="School board"
          aria-activedescendant={`${listId}-${focused}`}
          onKeyDown={onListKeyDown}
          className="absolute left-0 z-40 mt-2 max-h-[70vh] w-[286px] overflow-y-auto overscroll-contain rounded-xl border border-rule-strong bg-white p-1.5 shadow-modal focus:outline-none sm:w-[320px]"
        >
          {options.map((option, index) => {
            const selected = option.slug === (active?.slug ?? ALL_BOARDS);
            return (
              <li
                key={option.slug}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected}
                onClick={() => choose(option.slug)}
                onMouseEnter={() => setFocused(index)}
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 ${
                  index === focused ? "bg-chip" : ""
                }`}
              >
                <span aria-hidden className="flex w-[18px] justify-center text-civic">
                  {selected ? <Check size={17} strokeWidth={3} /> : null}
                </span>
                <span className="flex min-w-0 flex-grow flex-col">
                  <span className="truncate text-[15px] font-bold leading-tight">{option.label}</span>
                  <span className="flex items-center gap-1.5 text-[13px] text-ink-soft">
                    {option.paused && <PauseCircle aria-hidden size={13} strokeWidth={2.25} />}
                    {option.paused ? "Meetings paused" : option.detail}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[12px] text-ink-muted">{option.count}</span>
              </li>
            );
          })}
        </ul>
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
