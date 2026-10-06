// ============================================================
// Doc Sign, browser side: the "Awaiting my signature" and "Needs attention" shortcuts and "Sign now". The calls to
// the three routes (src/app/api/sign/awaiting-me, attention and documents/[id]/countersign) and the small decisions
// around them, kept pure so they are tested.
// ============================================================

import type { AttentionItem, AttentionReason, AwaitingItem } from "../service/countersign";
import { signRequest } from "./api";

export type { AttentionItem, AttentionReason, AwaitingItem };

export interface ShortcutList<T> {
  items: T[];
  count: number;
}

export const fetchAwaiting = (signal?: AbortSignal) => signRequest<ShortcutList<AwaitingItem>>("/api/sign/awaiting-me", { signal });
export const fetchAttention = (signal?: AbortSignal) => signRequest<ShortcutList<AttentionItem>>("/api/sign/attention", { signal });

/** Where "Sign now" may go: the signer page of the same site, nothing else (a path from the server is still checked). */
export function signerPath(url: unknown): string | null {
  return typeof url === "string" && /^\/s\/[0-9a-f]{64}$/.test(url) ? url : null;
}

/** Ask the server to open the signed-in person's own turn on a document; the answer is the signer page to go to. */
export async function openMyTurn(documentId: string): Promise<string> {
  const body = await signRequest<{ url?: unknown }>(`/api/sign/documents/${documentId}/countersign`, { json: {} });
  const path = signerPath(body.url);
  if (!path) throw new Error("unexpected answer");
  return path;
}

/** The failure codes "Sign now" words itself; anything else reads as the generic sentence. */
export const COUNTERSIGN_ERROR_CODES = ["not_your_turn", "document_not_open", "already_signed", "signer_not_open", "not_a_signer", "forbidden", "signed_out", "rate_limited", "network", "sign_disabled"] as const;

export function countersignErrorKey(code: string | undefined): string {
  return code && (COUNTERSIGN_ERROR_CODES as readonly string[]).includes(code) ? code : "generic";
}

/** The shortcut the list shows: the documents as they are, or one of the two. */
export type ListView = "documents" | "awaiting" | "attention";

/** The badge of the sidebar entry: nothing at zero, "9+" from ten. */
export function badgeText(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}

const REASON_ORDER: readonly AttentionReason[] = ["failed", "declined", "undelivered", "expired"];

/** The reasons of an item in the order the screen words them. */
export function sortedReasons(reasons: readonly AttentionReason[]): AttentionReason[] {
  return [...reasons].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
}
