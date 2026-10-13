// ============================================================
// Compliance requests linked to the Inbox chat (migration 185), the pure parts of the "Compliance requests" section of the ticket column: the counts, which
// status is "open", whether the section is drawn at all, and the view model of a row. No I/O, no React, browser-safe.
//
// What a row carries is decided HERE, not by the server alone: reference, type, status and when it was raised, and a link only when the person may open
// the case. Whatever else an answer might hold (a case step, an id) never reaches a row for a person who may not open it.
// ============================================================

import type { RaisedItem, RaiserStatus } from "./raise-types";

/** The shape of one linked request as the route answers it (service/linked.ts LinkedItem), without importing the server file. */
export type LinkedInput = RaisedItem & { step?: string };

/** The statuses that count as "open": the request has not reached an end. */
export const OPEN_STATUSES: readonly RaiserStatus[] = ["received", "in_review", "in_progress"];

export const isOpenStatus = (status: RaiserStatus): boolean => OPEN_STATUSES.includes(status);

/** How often the section asks again while the tab is visible. */
export const LINKED_POLL_MS = 60_000;

export interface LinkedCounts {
  total: number;
  open: number;
}

/** "2 requests, 1 open". */
export function linkedCounts(items: readonly Pick<RaisedItem, "status">[]): LinkedCounts {
  return { total: items.length, open: items.filter((i) => isOpenStatus(i.status)).length };
}

/**
 * Is the Compliance section drawn? Only when the workspace has the Compliance feature on (the platform flag the browser holds) AND the server did not say it is
 * off. `serverEnabled` is null until the first answer: the section waits for it (a spinner) rather than flashing in and out. A failed read keeps what is known.
 */
export function complianceSectionVisible(featureOn: boolean, serverEnabled: boolean | null): boolean {
  return featureOn && serverEnabled !== false;
}

/** The type of a request in the person's language, falling back to the English label. */
export function linkedTypeLabel(item: Pick<RaisedItem, "typeLabel" | "typeLabelL10n">, locale: string): string {
  const l10n = (item.typeLabelL10n ?? {}) as Record<string, string | undefined>;
  return l10n[locale]?.trim() || item.typeLabel;
}

export interface LinkedRowView {
  key: string;
  reference: string;
  typeLabel: string;
  status: RaiserStatus;
  raisedAt: string;
  /** The case, only for a person who may open it AND when the server gave the id. Null: the row is plain text. */
  href: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row of one request. Built field by field: nothing the server added beyond these fields can reach the screen. */
export function linkedRow(item: LinkedInput, locale: string, canOpen: boolean): LinkedRowView {
  return {
    key: item.reference,
    reference: item.reference,
    typeLabel: linkedTypeLabel(item, locale),
    status: item.status,
    raisedAt: item.raisedAt,
    href: canOpen && typeof item.id === "string" && UUID_RE.test(item.id) ? `/compliance/${item.id}` : null,
  };
}

export const linkedRows = (items: readonly LinkedInput[], locale: string, canOpen: boolean): LinkedRowView[] => items.map((i) => linkedRow(i, locale, canOpen));
