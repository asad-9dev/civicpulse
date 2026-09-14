import { Check } from "lucide-react";

const LINES_BEFORE = ["92%", "100%", "78%", "96%"];
const LINES_AFTER = ["88%", "100%", "64%", "94%", "82%"];

function TextLine({ width }: { width: string }) {
  return <div className="h-2 rounded bg-rule-soft" style={{ width }} />;
}

/**
 * A stack of agenda pages with the one line that matters highlighted,
 * pulled out into a three-point "decoded" card. Decorative only.
 */
export function HeroIllustration() {
  return (
    <div aria-hidden className="relative hidden h-[420px] lg:block">
      <div className="absolute -right-3.5 top-[22px] h-[392px] w-[360px] rotate-3 rounded-md border border-rule bg-white" />
      <div className="absolute -right-1 top-2.5 h-[392px] w-[360px] rotate-[1.4deg] rounded-md border border-rule bg-white" />

      <div className="absolute right-2 top-0 flex h-[392px] w-[360px] flex-col gap-3 rounded-md border border-[#CFC9BC] bg-white p-[26px] shadow-sheet">
        <div className="flex items-center justify-between border-b border-rule-soft pb-3 font-mono text-[10.5px]">
          <span className="font-semibold uppercase tracking-[0.08em] text-ink-soft">Agenda · Committee of the Whole</span>
          <span className="text-ink-muted">p. 47 / 118</span>
        </div>
        {LINES_BEFORE.map((w, i) => (
          <TextLine key={`b${i}`} width={w} />
        ))}
        <div className="-mx-2 my-0.5 rounded-[3px] bg-marker px-2 py-1.5 text-[13px] font-bold leading-[1.35]">
          7.3 Staff report: the one item that changes something for your school
        </div>
        {LINES_AFTER.map((w, i) => (
          <TextLine key={`a${i}`} width={w} />
        ))}
      </div>

      <div className="absolute -bottom-1.5 -left-2 flex w-[300px] flex-col gap-2.5 rounded-xl border-[1.5px] border-ink bg-white px-[18px] py-4 shadow-lift">
        <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-civic">
          <Check size={14} strokeWidth={2.5} />
          Decoded in 3 points
        </span>
        {["What the board decided", "Which towns and students it affects", "When you can have your say"].map((text, i) => (
          <div key={text} className="flex gap-2.5 text-sm leading-[1.4]">
            <span className="font-mono font-semibold text-ink-muted">{i + 1}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
