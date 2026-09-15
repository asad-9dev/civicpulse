import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, CircleCheck, MailX } from "lucide-react";

export const metadata: Metadata = {
  title: "Unsubscribe · DDSB CivicPulse",
  robots: { index: false, follow: false },
};

type SearchParams = { [key: string]: string | string[] | undefined };

function param(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function Shell({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <main className="page-container flex min-h-dvh items-center justify-center py-16">
      <div className="flex w-full max-w-[520px] flex-col gap-5 rounded-2xl border border-rule bg-white p-7 shadow-panel sm:p-9">
        <Link href="/" className="flex items-center gap-2.5 self-start">
          <span className="font-serif text-xl font-bold">CivicPulse</span>
          <span className="rounded border-[1.5px] border-ink px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-tight tracking-[0.1em]">
            DDSB
          </span>
        </Link>
        <div className="flex items-start gap-3">
          {icon}
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

const homeLink =
  "inline-flex h-12 items-center justify-center rounded-[10px] border-[1.5px] border-ink px-5 text-[15px] font-bold transition-colors hover:bg-ink hover:text-white";

export default function UnsubscribePage({ searchParams }: { searchParams: SearchParams }) {
  const status = param(searchParams.status);
  const id = param(searchParams.id);
  const token = param(searchParams.token);

  if (status === "done") {
    return (
      <Shell icon={<CircleCheck aria-hidden size={30} className="mt-1 shrink-0 text-urgency-low-fg" />} title="You're unsubscribed">
        <p className="text-base leading-relaxed text-ink-soft">
          We&apos;ve removed your email from CivicPulse, and you won&apos;t get any more emails from us. Changed your
          mind? You can sign up again anytime.
        </p>
        <Link href="/" className={`${homeLink} self-start`}>
          Back to CivicPulse
        </Link>
      </Shell>
    );
  }

  if (status === "error") {
    return (
      <Shell icon={<CircleAlert aria-hidden size={30} className="mt-1 shrink-0 text-urgency-high-fg" />} title="Something went wrong">
        <p className="text-base leading-relaxed text-ink-soft">
          We couldn&apos;t unsubscribe you just now. Please go back to the link in your email and try again in a minute.
        </p>
      </Shell>
    );
  }

  if (status === "invalid" || !id || !token) {
    return (
      <Shell icon={<CircleAlert aria-hidden size={30} className="mt-1 shrink-0 text-urgency-med-fg" />} title="This link isn't valid">
        <p className="text-base leading-relaxed text-ink-soft">
          The unsubscribe link may be incomplete. Open it again from the bottom of a CivicPulse email, or reply to
          any of our emails and we&apos;ll remove you by hand.
        </p>
        <Link href="/" className={`${homeLink} self-start`}>
          Back to CivicPulse
        </Link>
      </Shell>
    );
  }

  return (
    <Shell icon={<MailX aria-hidden size={30} className="mt-1 shrink-0 text-ink-soft" />} title="Unsubscribe from CivicPulse?">
      <p className="text-base leading-relaxed text-ink-soft">
        You&apos;ll stop getting DDSB meeting summaries, and we&apos;ll delete your email address from our list.
      </p>
      {/* A button (POST), not a plain link: email scanners that open links can't unsubscribe anyone. */}
      <form method="post" action="/api/unsubscribe" className="flex flex-col gap-3 sm:flex-row">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="source" value="page" />
        <button
          type="submit"
          className="inline-flex h-12 cursor-pointer items-center justify-center rounded-[10px] bg-ink px-5 text-[15px] font-bold text-white transition-colors hover:bg-civic"
        >
          Unsubscribe
        </button>
        <Link href="/" className={homeLink}>
          Keep me subscribed
        </Link>
      </form>
    </Shell>
  );
}
