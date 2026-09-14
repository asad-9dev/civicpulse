import { Activity, ExternalLink, Mail } from "lucide-react";
import { HeroIllustration } from "@/components/HeroIllustration";
import { MeetingExplorer } from "@/components/MeetingExplorer";
import { NewsletterForm } from "@/components/NewsletterForm";
import { getMeetings } from "@/lib/meetings";

// Re-read public/data/meetings.json on each request so new pipeline output shows up immediately.
export const dynamic = "force-dynamic";

const DDSB_MEETINGS_URL = "https://www.ddsb.ca/about-ddsb/board-of-trustees/board-meetings/";

function Wordmark({ size = "lg" }: { size?: "lg" | "sm" }) {
  return (
    <span className="flex items-center gap-2.5">
      {size === "lg" && (
        <span className="flex size-8 items-center justify-center rounded-lg bg-ink sm:size-[38px] sm:rounded-[10px]">
          <Activity aria-hidden size={20} strokeWidth={2.25} className="text-marker" />
        </span>
      )}
      <span
        className={`font-serif font-bold leading-none tracking-[-0.015em] ${size === "lg" ? "text-[21px] sm:text-[25px]" : "text-xl"}`}
      >
        CivicPulse
      </span>
      <span className="rounded border-[1.5px] border-ink px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-tight tracking-[0.1em] sm:text-[11px]">
        DDSB
      </span>
    </span>
  );
}

export default async function HomePage() {
  const meetings = await getMeetings();

  return (
    <>
      <a
        href="#meetings"
        className="sr-only z-50 rounded-lg bg-ink px-4 py-3 font-bold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to meetings
      </a>

      <header className="border-b border-rule">
        <div className="page-container flex h-16 items-center justify-between sm:h-[76px]">
          <a href="/" aria-label="CivicPulse home" className="rounded-lg">
            <Wordmark />
          </a>
          <div className="flex items-center gap-6">
            <a
              href="#subscribe"
              className="inline-flex size-11 items-center justify-center gap-2 rounded-[10px] bg-ink text-[15px] font-bold text-white transition-colors hover:bg-civic sm:w-auto sm:px-[18px]"
            >
              <Mail aria-hidden size={18} strokeWidth={2} />
              <span className="sr-only sm:not-sr-only">Get meeting alerts</span>
            </a>
          </div>
        </div>
      </header>

      <main>
        <section className="page-container grid items-center gap-16 pt-9 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:pt-[72px]">
          <div className="flex flex-col gap-[18px] sm:gap-7">
            <p className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft sm:text-[13px]">
              <span aria-hidden className="size-2 rounded-full bg-civic" />
              <span className="sm:hidden">DDSB · Trustee meetings</span>
              <span className="hidden sm:inline">Durham District School Board · Trustee meetings</span>
            </p>
            <h1 className="text-balance font-serif text-[46px] font-semibold leading-[1.02] tracking-[-0.025em] sm:text-[64px] lg:text-[80px] lg:leading-none">
              DDSB Trustee Decisions, <em className="marker px-1 font-medium sm:px-1.5">Decoded</em>
            </h1>
            <p className="max-w-[610px] text-pretty text-[17px] leading-[1.55] text-ink-soft sm:text-[21px]">
              Every board agenda runs past 100 pages. CivicPulse reads each one and boils it down to three
              plain-language points: what changed, who it affects, and when you can speak up. That saves parents and
              students <strong className="text-ink">15+ hours of PDF reading per meeting</strong>.
            </p>
          </div>
          <HeroIllustration />
        </section>

        <MeetingExplorer meetings={meetings} />

        <section id="subscribe" aria-labelledby="subscribe-heading" className="mt-14 scroll-mt-6 bg-ink text-white sm:mt-24">
          <div className="page-container grid items-center gap-8 py-11 sm:py-[72px] lg:grid-cols-2 lg:gap-[72px]">
            <div className="flex flex-col gap-4">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-marker sm:text-xs">
                Meeting alerts · Free
              </p>
              <h2
                id="subscribe-heading"
                className="text-balance font-serif text-[34px] font-semibold leading-[1.06] tracking-[-0.02em] sm:text-[50px] sm:leading-[1.04]"
              >
                Get every board meeting decoded in your inbox.
              </h2>
              <p className="text-base leading-[1.55] text-night-text sm:text-lg">
                One short email after each trustee meeting: the three things that changed, which towns they affect,
                and any deadline to have your say.
              </p>
            </div>
            <NewsletterForm />
          </div>
        </section>
      </main>

      <footer className="page-container flex flex-col gap-6 pb-12 pt-8 sm:flex-row sm:items-start sm:justify-between sm:gap-12 sm:pb-14 sm:pt-10">
        <div className="flex max-w-[720px] flex-col gap-3">
          <Wordmark size="sm" />
          <p className="text-[15px] leading-relaxed text-ink-soft">
            CivicPulse is an independent civic project. It is not affiliated with or endorsed by the Durham District
            School Board. Summaries are AI-assisted and can contain mistakes, so always confirm details in the
            original agenda.
          </p>
        </div>
        <a
          href={DDSB_MEETINGS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap text-[15px] font-bold text-civic hover:text-ink"
        >
          Official DDSB board meetings
          <ExternalLink aria-hidden size={16} strokeWidth={2.25} />
        </a>
      </footer>
    </>
  );
}
