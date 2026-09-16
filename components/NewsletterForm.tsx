"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, CircleCheck, LoaderCircle } from "lucide-react";
import type { Board } from "@/lib/boards";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; emailsEnabled: boolean; boards: string[] }
  | { kind: "error"; message: string };

/** "DDSB", "DDSB and YRDSB", "DDSB, YRDSB and TDSB". */
function listBoards(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function NewsletterForm({ boards, defaultBoard }: { boards: Board[]; defaultBoard: Board | null }) {
  const [email, setEmail] = useState("");
  // Whoever is reading one board's feed most likely wants that board's emails; everyone else
  // gets every board, which is what a subscriber got before boards existed.
  const [chosen, setChosen] = useState<string[]>(defaultBoard ? [defaultBoard.slug] : boards.map((b) => b.slug));
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Switching boards in the header re-renders this form with a new default, but state set on the
  // first mount would survive and keep offering the old boards. Follow the header instead.
  const defaultSlug = defaultBoard?.slug;
  useEffect(() => {
    setChosen(defaultSlug ? [defaultSlug] : boards.map((b) => b.slug));
    // boards is a constant list from the server, so only the board choice re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSlug]);

  function toggleBoard(slug: string) {
    setChosen((current) =>
      current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug],
    );
    if (status.kind === "error") setStatus({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
    if (!input.checkValidity()) {
      setStatus({ kind: "error", message: "Enter an email address like name@example.com." });
      input.focus();
      return;
    }
    if (chosen.length === 0) {
      setStatus({ kind: "error", message: "Pick at least one school board." });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, boards: chosen }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; emailsEnabled?: boolean };
      if (!res.ok) {
        setStatus({ kind: "error", message: data.error ?? "Something went wrong. Please try again." });
        return;
      }
      const names = boards.filter((b) => chosen.includes(b.slug)).map((b) => b.shortName);
      setStatus({ kind: "success", emailsEnabled: data.emailsEnabled === true, boards: names });
      setEmail("");
    } catch {
      setStatus({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  const submitting = status.kind === "submitting";
  const error = status.kind === "error" ? status.message : null;
  const allChosen = chosen.length === boards.length;

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-2.5">
      <label htmlFor="subscribe-email" className="text-[15px] font-bold">
        Email address
      </label>
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <input
          id="subscribe-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status.kind === "error") setStatus({ kind: "idle" });
          }}
          placeholder="you@example.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "subscribe-status" : "subscribe-hint"}
          className={`h-14 min-w-0 flex-grow rounded-[10px] border-2 bg-white px-[18px] text-[17px] text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-marker ${
            error ? "border-[#FF8A80]" : "border-transparent"
          }`}
        />
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-marker px-[26px] text-[17px] font-bold text-ink transition-colors hover:bg-white focus-visible:outline-marker disabled:cursor-wait disabled:opacity-70"
        >
          {submitting ? (
            <>
              <LoaderCircle aria-hidden size={18} strokeWidth={2.25} className="animate-spin" />
              Subscribing…
            </>
          ) : (
            <>
              Subscribe
              <ArrowRight aria-hidden size={18} strokeWidth={2.25} />
            </>
          )}
        </button>
      </div>

      <fieldset className="mt-1.5 flex flex-col gap-2.5">
        <legend className="mb-2.5 text-[15px] font-bold">
          Boards to follow
          <span className="ml-2 font-normal text-night-muted">
            {allChosen ? "all Ontario boards" : `${chosen.length} of ${boards.length}`}
          </span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {boards.map((board) => {
            const checked = chosen.includes(board.slug);
            return (
              <label
                key={board.slug}
                className={`inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] px-4 text-[15px] transition-colors sm:h-10 ${
                  checked
                    ? "border-marker bg-marker font-bold text-ink"
                    : "border-white/35 text-white hover:border-white"
                }`}
              >
                <input
                  type="checkbox"
                  name="boards"
                  value={board.slug}
                  checked={checked}
                  onChange={() => toggleBoard(board.slug)}
                  className="size-4 accent-ink focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-marker"
                />
                {board.shortName}
                <span className="sr-only">
                  : {board.name}
                  {board.status !== "live" ? " (meetings currently paused)" : ""}
                </span>
                {board.status !== "live" && (
                  <span aria-hidden className={`text-[13px] ${checked ? "text-ink/70" : "text-night-muted"}`}>
                    paused
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div id="subscribe-status" role="status" aria-live="polite" className="min-h-6 text-[15px]">
        {status.kind === "success" && (
          <div className="flex items-start gap-3 rounded-[10px] border border-marker/40 bg-white/10 px-4 py-3">
            <CircleCheck aria-hidden size={22} strokeWidth={2.25} className="mt-0.5 shrink-0 text-marker" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[17px] font-bold text-white">You&apos;re subscribed!</p>
              <p className="text-[15px] text-night-text">
                {status.emailsEnabled
                  ? `Check your inbox for a welcome email with what to expect from ${listBoards(status.boards)}.`
                  : `Look out for the next ${listBoards(status.boards)} meeting summary in your inbox.`}
              </p>
            </div>
          </div>
        )}
        {error && <p className="font-bold text-[#FFB4AB]">{error}</p>}
      </div>
      <p id="subscribe-hint" className="text-sm text-night-muted">
        No spam. Unsubscribe in one click. We never share your email.
      </p>
    </form>
  );
}
