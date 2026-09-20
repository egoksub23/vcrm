import { toCsv } from "@/lib/csv";

import { summaryToText } from "./summary";
import type { AuditEntry } from "./types";

/** Hard cap on an export: the file is streamed, but never unbounded. */
export const EXPORT_MAX_ROWS = 10_000;
/** Rows read from the database per round trip while streaming. */
export const EXPORT_PAGE_SIZE = 1_000;

export const EXPORT_HEADER = [
  "Time (UTC)",
  "Actor",
  "Actor type",
  "Action",
  "Item type",
  "Item",
  "Item ID",
  "Details",
] as const;

/** One CSV line (CRLF-terminated). Cells starting with = + - @ are guarded by toCsv. */
export function csvHeaderLine(): string {
  return toCsv([[...EXPORT_HEADER]]);
}

export function csvEntryLines(entries: readonly AuditEntry[]): string {
  if (entries.length === 0) return "";
  return toCsv(
    entries.map((e) => [
      e.createdAt,
      e.actor.name,
      e.actor.kind,
      e.action,
      e.entityType,
      e.entityLabel ?? "",
      e.entityId ?? "",
      summaryToText(e.action, e.summary),
    ]),
  );
}
