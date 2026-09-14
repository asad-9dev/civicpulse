"use client";

import { useCallback, useEffect, useRef } from "react";
import { ExternalLink, FileText, X } from "lucide-react";
import type { Meeting } from "@/lib/types";
import { CategoryLabel, DateBadge, TownTag, UrgencyBadge } from "./Badges";
import { SummaryList } from "./MeetingCard";

/**
 * Full breakdown of one meeting. Uses the native <dialog> for focus trapping,
 * Escape-to-close and an inert background; a bottom sheet on phones (see globals.css).
 */
export function MeetingDialog({ meeting, onClose }: { meeting: Meeting | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Every way out (Escape, backdrop, both buttons) goes through here, so parent state
  // never depends on the asynchronous native "close" event arriving.
  const requestClose = useCallback(() => {
    if (ref.current?.open) ref.current.close();
    onCloseRef.current();
    returnFocusTo.current?.focus();
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    // Safety net for closes that bypass requestClose (e.g. form method="dialog").
    const handleClose = () => onCloseRef.current();
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
    };
  }, [requestClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (meeting && !dialog.open) {
      returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!meeting && dialog.open) dialog.close();
  }, [meeting]);

  return (
    <dialog
      ref={ref}
      className="breakdown-dialog shadow-modal"
      aria-labelledby="breakdown-title"
      // A click that lands on the <dialog> itself (not its content) is a backdrop click.
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      {meeting && (
        <div className="flex max-h-[inherit] flex-col bg-white">
          <header className="flex shrink-0 flex-col gap-3 border-b border-rule-soft bg-raised px-5 pb-5 pt-4 sm:gap-3.5 sm:px-8 sm:pb-6 sm:pt-[26px]">
            <div aria-hidden className="mx-auto -mt-1 mb-1 h-[5px] w-10 rounded-full bg-rule-strong sm:hidden" />
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <DateBadge isoDate={meeting.meetingDate} />
                <UrgencyBadge score={meeting.urgencyScore} />
              </div>
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close breakdown"
                className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border-[1.5px] border-rule-strong bg-white transition-colors hover:border-ink"
              >
                <X aria-hidden size={20} strokeWidth={2.25} />
              </button>
            </div>
            <p className="font-mono text-xs uppercase tracking-[0.06em] text-ink-muted">{meeting.committeeName}</p>
            <h2
              id="breakdown-title"
              className="text-balance font-serif text-[27px] font-semibold leading-[1.14] tracking-[-0.015em] sm:text-4xl sm:leading-[1.12]"
            >
              {meeting.title}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <CategoryLabel category={meeting.category} />
              <span aria-hidden className="text-rule-strong">
                |
              </span>
              <span className="text-sm font-bold text-ink-soft">Affects:</span>
              <ul className="flex flex-wrap gap-1.5">
                {meeting.townsAffected.map((town) => (
                  <li key={town}>
                    <TownTag town={town} />
                  </li>
                ))}
              </ul>
            </div>
          </header>

          <div className="flex flex-col gap-7 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8 sm:py-7">
            <section className="flex flex-col gap-3.5">
              <h3 className="eyebrow">Executive summary</h3>
              <SummaryList items={meeting.executiveSummary} size="dialog" />
            </section>

            <section className="flex flex-col gap-3 border-t border-rule-soft pt-6">
              <h3 className="eyebrow">What this means for students &amp; parents</h3>
              <p className="text-pretty text-base leading-relaxed text-ink-body sm:text-[17px] sm:leading-[1.65]">
                {meeting.studentParentImpact}
              </p>
            </section>

            <section className="flex flex-col gap-2.5 rounded-xl border border-rule-soft bg-paper px-[22px] py-5">
              <h3 className="eyebrow flex items-center gap-2">
                <FileText aria-hidden size={15} strokeWidth={2} />
                Policy changes
              </h3>
              <p className="text-base leading-relaxed text-ink-body">{meeting.policyChanges}</p>
            </section>
          </div>

          <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-rule-soft bg-raised px-5 pb-6 pt-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-8 sm:py-[18px]">
            <span className="text-center text-sm text-ink-muted sm:text-left">Opens ddsb.ca in a new tab</span>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={requestClose}
                className="hidden h-12 cursor-pointer items-center rounded-[10px] border-[1.5px] border-rule-strong bg-white px-5 text-[15px] font-bold transition-colors hover:border-ink sm:inline-flex"
              >
                Close
              </button>
              <a
                href={meeting.originalPdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-[52px] flex-1 items-center justify-center gap-[9px] rounded-[10px] bg-civic px-[22px] text-base font-bold text-white transition-colors hover:bg-ink sm:h-12 sm:flex-none sm:text-[15px]"
              >
                View Original DDSB PDF Agenda
                <ExternalLink aria-hidden size={17} strokeWidth={2.25} />
              </a>
            </div>
          </footer>
        </div>
      )}
    </dialog>
  );
}
