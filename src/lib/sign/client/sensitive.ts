// ============================================================
// Sensitive answers, browser side: asking the server for a value the screen shows masked. The value is held in
// memory by the row that asked, for `REVEAL_SHOW_MS`, and is never put in the address, in storage or in an attribute.
// ============================================================

import type { RevealSensitiveResult } from "../forms/api-types";
import { signRequest } from "./api";

/** How long a revealed value stays on the screen before it is hidden again. */
export const REVEAL_SHOW_MS = 30_000;

/** The error codes the reveal call can fail with that the screen words (anything else reads as the generic sentence). */
export const REVEAL_ERROR_CODES = ["answer_not_found", "audit_unavailable", "rate_limited", "forbidden", "signed_out", "network"] as const;

export function revealErrorKey(code: string | null | undefined): string {
  return code && (REVEAL_ERROR_CODES as readonly string[]).includes(code) ? `sensitive.errors.${code}` : "sensitive.errors.generic";
}

/** POST /api/sign/documents/[id]/sensitive. Writes a `sensitive_viewed` event on the server first. */
export const revealSensitive = (documentId: string, field: string): Promise<RevealSensitiveResult> =>
  signRequest<RevealSensitiveResult>(`/api/sign/documents/${encodeURIComponent(documentId)}/sensitive`, { json: { field } });
