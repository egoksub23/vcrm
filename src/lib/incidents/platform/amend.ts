// Amending an incident's title or description. Pure: checks what was sent and decides what may be saved. The wording before and after is written to the audit
// trail by the database (migration 230); once an incident is closed a short reason is required, so a filed record cannot be reworded without saying why.

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 10000;
export const MIN_REASON = 3;
export const MAX_REASON = 500;

export type AmendResult = { ok: true; patch: Record<string, unknown>; touched: boolean } | { ok: false; error: string };

/**
 * `body` is the PATCH body. Returns the fields to save for the title, description and reason (others are left to the caller). `touched` says whether the request
 * changes the wording at all, so the caller knows whether an incident that is closed needs a reason.
 */
export function parseAmend(body: Record<string, unknown>, status: string): AmendResult {
  const patch: Record<string, unknown> = {};
  const touched = body.title !== undefined || body.description !== undefined;

  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return { ok: false, error: "The title cannot be empty." };
    if (title.length > MAX_TITLE) return { ok: false, error: `The title can be ${MAX_TITLE} characters at most.` };
    patch.title = title;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") return { ok: false, error: "The description must be text." };
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > MAX_DESCRIPTION) return { ok: false, error: `The description can be ${MAX_DESCRIPTION} characters at most.` };
    patch.description = description || null;
  }

  if (touched) {
    const reason = typeof body.amend_reason === "string" ? body.amend_reason.trim() : "";
    if (status === "closed" && reason.length < MIN_REASON) return { ok: false, error: "This incident is closed. Say why you are changing it." };
    if (reason) patch.amend_reason = reason.slice(0, MAX_REASON);
  }
  return { ok: true, patch, touched };
}
