"use client";

import { useEffect, useRef, useState } from "react";

/** One passage from /api/search. */
export interface SemanticHit {
  meetingId: string;
  boardSlug: string | null;
  title: string;
  meetingDate: string;
  agendaUrl: string | null;
  chunkIndex: number;
  similarity: number;
  excerpt: string;
}

export type SemanticState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; query: string; hits: SemanticHit[] }
  | { status: "error"; query: string; message: string };

/** Shorter queries embed poorly and aren't worth a Gemini call. */
export const MIN_SEMANTIC_QUERY = 3;
/** Wait for typing to pause: every request is a Gemini embedding call. */
const DEBOUNCE_MS = 450;
/** Enough passages that grouping them by meeting still leaves a few meetings to show. */
const RESULT_LIMIT = 12;

/**
 * Search the full agendas by meaning, through /api/search.
 *
 * Three things a plain fetch-on-change would get wrong:
 *  - it waits for typing to pause, since each request costs an embedding call;
 *  - it aborts the previous request when the query changes, so a slow answer to an old query
 *    can never land after, and overwrite, the answer to the current one;
 *  - it remembers answers for the session, so going back to a query costs nothing.
 */
export function useSemanticSearch(query: string, boardSlug: string | null, enabled: boolean): SemanticState {
  const [state, setState] = useState<SemanticState>({ status: "idle" });
  const cache = useRef(new Map<string, SemanticHit[]>());

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < MIN_SEMANTIC_QUERY) {
      setState({ status: "idle" });
      return;
    }

    const key = `${boardSlug ?? "all"}|${q.toLowerCase()}`;
    const cached = cache.current.get(key);
    if (cached) {
      setState({ status: "done", query: q, hits: cached });
      return;
    }

    // Show the skeleton straight away, so the pause before the request doesn't read as nothing
    // happening.
    setState({ status: "loading" });
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const url = new URL("/api/search", window.location.origin);
      url.searchParams.set("q", q);
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (boardSlug) url.searchParams.set("board", boardSlug);

      try {
        const response = await fetch(url, { signal: controller.signal });
        const body = (await response.json().catch(() => ({}))) as { results?: SemanticHit[]; error?: string };
        if (!response.ok) {
          setState({ status: "error", query: q, message: body.error ?? `Search failed (${response.status})` });
          return;
        }
        const hits = Array.isArray(body.results) ? body.results : [];
        cache.current.set(key, hits);
        setState({ status: "done", query: q, hits });
      } catch (error) {
        if (controller.signal.aborted) return; // superseded by a newer query
        setState({ status: "error", query: q, message: error instanceof Error ? error.message : "Search failed" });
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, boardSlug, enabled]);

  return state;
}

export interface MeetingGroup {
  meetingId: string;
  boardSlug: string | null;
  title: string;
  meetingDate: string;
  agendaUrl: string | null;
  /** The closest passage's similarity: what the meeting is ranked and badged by. */
  best: number;
  /** Matching passages, closest first. */
  passages: SemanticHit[];
}

/**
 * One entry per meeting rather than per passage.
 *
 * A single long agenda often supplies several of the closest passages; listed separately they
 * read as the same result three times.
 */
export function groupByMeeting(hits: SemanticHit[]): MeetingGroup[] {
  const groups = new Map<string, MeetingGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.meetingId);
    if (group) {
      group.passages.push(hit);
      group.best = Math.max(group.best, hit.similarity);
    } else {
      groups.set(hit.meetingId, {
        meetingId: hit.meetingId,
        boardSlug: hit.boardSlug,
        title: hit.title,
        meetingDate: hit.meetingDate,
        agendaUrl: hit.agendaUrl,
        best: hit.similarity,
        passages: [hit],
      });
    }
  }
  for (const group of groups.values()) group.passages.sort((a, b) => b.similarity - a.similarity);
  return [...groups.values()].sort((a, b) => b.best - a.best);
}

export type SnippetPart = { text: string; match: boolean };

/**
 * A short excerpt of a passage, centred on the first query word it contains, split into
 * matched and unmatched runs so the words can be highlighted.
 *
 * A semantic match often shares no literal word with the query (a search for "bus routes" finds
 * "student transportation"), in which case the excerpt is simply the passage's opening.
 */
export function snippet(passage: string, query: string, length = 260): SnippetPart[] {
  const text = passage.replace(/\s+/g, " ").trim();
  const terms = [...new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length >= 3))];

  let start = 0;
  const lower = text.toLowerCase();
  const firstHit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (firstHit !== undefined && firstHit > length / 3) {
    // Back up to a word boundary so the excerpt doesn't open mid-word.
    start = text.lastIndexOf(" ", firstHit - Math.floor(length / 3)) + 1;
  }
  let end = Math.min(text.length, start + length);
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;

  const excerpt = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  if (terms.length === 0) return [{ text: excerpt, match: false }];

  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return excerpt
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}
