// ============================================================
// GET /api/kyc/validations[?friend_id=<id>][&limit=50][&before_id=<id>][&reload=1][&reveal=1&friend_id=<id>&validation_id=<id>]   (menu.kyc; reveal also needs kyc.reveal)
//
// The validations the ID verification back end holds, newest first (for one friend id, or without friend_id the latest of everybody; before_id pages back), MASKED: the ID number, date of birth, address and any other
// sensitive field are masked on the server before they are put in the answer. `reveal=1` with a `validation_id` returns that ONE validation's sensitive
// values in full, and only when the caller holds kyc.reveal (otherwise 403, recorded as 'forbidden'); every other item stays masked. Ten reveals a
// minute per person, counted in the database so it holds across processes.
//
// friend_id: 1 to 100 characters of [A-Za-z0-9._@:+-]. limit: 1 to 100 (default 50). Every call writes a kyc_access_log row first (lookup, list on
// `reload=1`, reveal), and when the row cannot be written nothing is returned. The answer is never cached. The key and the back end's address are
// never in an answer; neither is anything the back end said.
// ============================================================
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";
import { failure, json, kycStaff, rateLimited } from "@/lib/kyc/http";
import { lookupValidations, validFriendId, validValidationId } from "@/lib/kyc/service";
import { BEFORE_ID_RE, normaliseFriendId } from "@/lib/kyc/types";

export async function GET(request: Request) {
  return kycStaff({ bucket: "validations", perMinute: 30 }, async ({ admin, caller, runtime }) => {
    const params = new URL(request.url).searchParams;
    const friendId = normaliseFriendId(params.get("friend_id") ?? "");
    // No friend id = the latest checks of everybody (the screen's start page). A reveal is always for one friend.
    if (friendId !== "" && !validFriendId(friendId)) return failure("invalid_request");
    const beforeId = (params.get("before_id") ?? "").trim();
    if (beforeId !== "" && !BEFORE_ID_RE.test(beforeId)) return failure("invalid_request");

    const rawLimit = params.get("limit");
    const parsedLimit = rawLimit === null || rawLimit === "" ? 50 : Number(rawLimit);
    if (!Number.isFinite(parsedLimit)) return failure("invalid_request");
    const limit = Math.max(1, Math.min(100, Math.trunc(parsedLimit)));

    let revealValidationId: string | null = null;
    if (params.get("reveal") === "1") {
      const vid = (params.get("validation_id") ?? "").trim();
      if (friendId === "" || !validValidationId(vid)) return failure("invalid_request");
      revealValidationId = vid;
      const rate = await checkSharedRateLimit(`kyc-reveal:${caller.userId}`, { limit: 10, windowMs: 60_000 });
      if (!rate.success) return rateLimited(rate.reset);
    }

    const result = await lookupValidations(admin, caller, runtime, { friendId, limit, beforeId: beforeId || null, reload: params.get("reload") === "1", revealValidationId });
    return result.ok ? json(result.body) : failure(result.code);
  });
}
