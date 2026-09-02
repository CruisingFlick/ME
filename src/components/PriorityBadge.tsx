import type { TriagePriority } from "@/db/schema";

const LABELS: Record<TriagePriority, string> = {
  high: "Needs you",
  normal: "Straightforward",
  low: "Can wait",
};

/** Sort key — high first, and anything untriaged sits between high and normal. */
export const PRIORITY_RANK: Record<TriagePriority | "untriaged", number> = {
  high: 0,
  untriaged: 1,
  normal: 2,
  low: 3,
};

export function PriorityBadge({ priority }: { priority: TriagePriority }) {
  return (
    <span className={`badge badge-priority-${priority}`}>
      {LABELS[priority]}
    </span>
  );
}
