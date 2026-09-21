import type { Message } from "@/types";

/**
 * What `/api/whatsapp/send` and `/api/messages/[id]/resend` return when the
 * channel rejects a send (see src/lib/messages/send-error-body.ts).
 */
export interface SendFailureBody {
  error?: string;
  code?: string;
  failed_message_id?: string;
  needs_template?: boolean;
  failure?: {
    code: number | null;
    title: string;
    details: string | null;
    kind?: string;
    friendly?: string;
    needs_template?: boolean;
  };
}

/**
 * Patch for the optimistic bubble once the server has answered with a
 * rejection: mark it failed, and when the server saved the failed message,
 * adopt its id (so the realtime insert of that same row is de-duplicated
 * instead of adding a second bubble) and its reason.
 */
export function failedMessagePatch(body: SendFailureBody | null | undefined): Partial<Message> {
  const patch: Partial<Message> = { status: "failed" };
  if (body?.failed_message_id) patch.id = body.failed_message_id;
  const f = body?.failure;
  if (f) {
    patch.error_code = f.code ?? null;
    patch.error_title = f.title ?? null;
    patch.error_details = f.details ?? null;
  }
  return patch;
}

/** The provider's reason from a rejection body, or null when there is none. */
export function sendFailureToastValues(
  body: SendFailureBody | null | undefined,
): { code: number | null; title: string; details: string | null } | null {
  const f = body?.failure;
  if (!f) return null;
  return { code: f.code ?? null, title: f.title, details: f.details ?? null };
}
