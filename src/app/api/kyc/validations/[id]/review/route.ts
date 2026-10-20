// ============================================================
// POST /api/kyc/validations/[id]/review   body {"friend_id": "<id>", "decision": "approve" | "reject", "note": "<text>"}   (menu.kyc and kyc.decide)
//
// Approve or reject one ID check. The ID verification back end records it, sets the child's eKYC status and, on a rejection, e-mails the parent; Halo
// keeps nothing but the access log. The order is the security model (service.ts decideValidation):
//   1. kyc.decide, else 403 recorded as 'forbidden' and nothing is sent
//   2. the check is read again: one that already carries a review is a 409 (a rejection e-mails the parent, so it is never sent twice)
//   3. an 'attempt' row is written BEFORE the back end is called; when it cannot be written nothing is sent
//   4. the one call, with a 25 s deadline and no retry
//   5. a result row ('ok', 'error' or 'not_found')
// `note` is required for a rejection, optional for an approval, at most 500 characters, one clean line. 20 decisions a minute per person.
// `"amend": true` (migration 192) changes a check that was REJECTED to approved: decision must be "approve" and a note (why) is required. The check must carry a
// rejection (read again first), the log row is an 'amend', and when the back end will not change a decision the answer is 409 `amend_refused`.
// Only a JSON body is accepted (a form or a cross-site request cannot send one). The answer is never cached and holds only the status word, the time,
// the note as sent, whether the back end could save it everywhere and whether the parent's e-mail went: nothing else the back end said.
// ============================================================
import { failure, json, kycStaff } from "@/lib/kyc/http";
import { decideValidation, normaliseNote, validFriendId, validValidationId } from "@/lib/kyc/service";
import { DECISION_NOTE_MAX, KYC_DECISIONS, normaliseFriendId, type KycDecision } from "@/lib/kyc/types";

const MAX_BODY_CHARS = 4_000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return kycStaff({ bucket: "decide", perMinute: 20 }, async ({ admin, caller, runtime }) => {
    const { id: rawId } = await params;
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return failure("invalid_request");
    }
    if (!validValidationId(id)) return failure("invalid_request");

    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return failure("invalid_request");
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_CHARS) return failure("invalid_request");
      body = JSON.parse(text) as unknown;
    } catch {
      return failure("invalid_request");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return failure("invalid_request");
    const { friend_id, decision, note, amend } = body as { friend_id?: unknown; decision?: unknown; note?: unknown; amend?: unknown };

    const friendId = typeof friend_id === "string" ? normaliseFriendId(friend_id) : "";
    if (friendId === "" || !validFriendId(friendId)) return failure("invalid_request");
    if (typeof decision !== "string" || !(KYC_DECISIONS as readonly string[]).includes(decision)) return failure("invalid_request");
    if (note !== undefined && note !== null && typeof note !== "string") return failure("invalid_request");
    const clean = normaliseNote(typeof note === "string" ? note : "");
    if (clean.length > DECISION_NOTE_MAX) return failure("invalid_request");
    if (decision === "reject" && clean === "") return failure("invalid_request");
    // `amend: true` changes a check that was REJECTED to approved: only that, and it needs the reason. Anything but a real boolean is refused.
    if (amend !== undefined && typeof amend !== "boolean") return failure("invalid_request");
    if (amend === true && (decision !== "approve" || clean === "")) return failure("invalid_request");

    const result = await decideValidation(admin, caller, runtime, { validationId: id, friendId, decision: decision as KycDecision, note: clean, amend: amend === true });
    return result.ok ? json(result.body) : failure(result.code);
  });
}
