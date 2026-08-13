import type { RequestStatus } from "@/db/schema";
import { STATUS_LABELS } from "@/lib/requests";

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>
  );
}
