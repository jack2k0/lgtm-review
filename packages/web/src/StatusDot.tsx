import type { Status } from "@lgtm/core";
import { statusLabel } from "./viewmodel";

/** Colored dot plus the text label: status is never conveyed by color alone. */
export function StatusDot({ status, count }: { status: Status; count?: number }) {
  return (
    <span className="status">
      <span className={`dot dot-${status}`} aria-hidden="true" />
      {count !== undefined ? `${count} ` : ""}
      {statusLabel(status).toLowerCase()}
    </span>
  );
}

export function StatusTag({ status }: { status: Status }) {
  return (
    <span className="status">
      <span className={`dot dot-${status}`} aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}
