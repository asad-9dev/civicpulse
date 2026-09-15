"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, CircleCheck, LoaderCircle } from "lucide-react";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; emailsEnabled: boolean }
  | { kind: "error"; message: string };

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
    if (!input.checkValidity()) {
      setStatus({ kind: "error", message: "Enter an email address like name@example.com." });
      input.focus();
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; emailsEnabled?: boolean };
      if (!res.ok) {
        setStatus({ kind: "error", message: data.error ?? "Something went wrong. Please try again." });
        return;
      }
      setStatus({ kind: "success", emailsEnabled: data.emailsEnabled === true });
      setEmail("");
    } catch {
      setStatus({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  const submitting = status.kind === "submitting";
  const error = status.kind === "error" ? status.message : null;

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

      <div id="subscribe-status" role="status" aria-live="polite" className="min-h-6 text-[15px]">
        {status.kind === "success" && (
          <div className="flex items-start gap-3 rounded-[10px] border border-marker/40 bg-white/10 px-4 py-3">
            <CircleCheck aria-hidden size={22} strokeWidth={2.25} className="mt-0.5 shrink-0 text-marker" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[17px] font-bold text-white">You&apos;re subscribed!</p>
              <p className="text-[15px] text-night-text">
                {status.emailsEnabled
                  ? "Check your inbox for a welcome email with what to expect."
                  : "Look out for the next board meeting summary in your inbox."}
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
