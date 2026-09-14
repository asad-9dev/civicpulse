import {
  Bus,
  Calendar,
  CircleAlert,
  CircleCheck,
  Map as MapIcon,
  MapPin,
  Scale,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { formatMeetingDate, urgencyLevel, type UrgencyLevel } from "@/lib/format";
import type { Category } from "@/lib/types";

export function DateBadge({ isoDate }: { isoDate: string }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-[7px] rounded-md bg-chip px-2.5 font-mono text-[13px] font-medium">
      <Calendar aria-hidden size={15} strokeWidth={2} />
      <time dateTime={isoDate}>{formatMeetingDate(isoDate)}</time>
    </span>
  );
}

const URGENCY: Record<UrgencyLevel, { label: string; icon: LucideIcon; className: string }> = {
  high: {
    label: "High",
    icon: TriangleAlert,
    className: "border-urgency-high-line bg-urgency-high-bg text-urgency-high-fg",
  },
  medium: {
    label: "Medium",
    icon: CircleAlert,
    className: "border-urgency-med-line bg-urgency-med-bg text-urgency-med-fg",
  },
  low: {
    label: "Low",
    icon: CircleCheck,
    className: "border-urgency-low-line bg-urgency-low-bg text-urgency-low-fg",
  },
};

/** Color is never the only signal: every level carries its own icon and word. */
export function UrgencyBadge({ score }: { score: number }) {
  const { label, icon: Icon, className } = URGENCY[urgencyLevel(score)];
  return (
    <span
      className={`inline-flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-bold ${className}`}
    >
      <Icon aria-hidden size={15} strokeWidth={2.25} />
      Urgency {score}/5 · {label}
    </span>
  );
}

export function TownTag({ town }: { town: string }) {
  return (
    <span className="inline-flex h-7 items-center gap-[5px] rounded-full border border-rule-strong px-2.5 text-sm text-ink-soft">
      <MapPin aria-hidden size={13} strokeWidth={2.25} />
      {town}
    </span>
  );
}

export const CATEGORY_ICONS: Record<Category, LucideIcon> = {
  "Boundary Review": MapIcon,
  Transport: Bus,
  Policy: Scale,
  Budget: Wallet,
};

export function CategoryLabel({ category }: { category: Category }) {
  const Icon = CATEGORY_ICONS[category];
  return (
    <span className="inline-flex items-center gap-2 text-sm font-bold text-ink-soft">
      <Icon aria-hidden size={17} strokeWidth={2} />
      {category}
    </span>
  );
}
