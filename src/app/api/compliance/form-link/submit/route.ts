// ============================================================
// POST /api/compliance/form-link/submit   (public: the personal closure form at /c/link/<token>, no login)
//
// The parent filled in the personal closure form that was sent to them in a chat (migration 185). A multipart post: a JSON `payload` (the link's own token,
// the page's signed form token, the email typed, the name, the details, the acknowledgements, the hidden field, the language) and at most one file (`letter`,
// the authorization letter). There is NO emailed code: the link is the parent's key. It UPDATES THE EXISTING CASE the link was made for (it never makes a
// new one), marks the link used and applies the answers in one database step, so a double submit cannot apply twice.
//
// Answers (always JSON, never cached):
//   200 { ok: true, reference }          taken; `reference` is the case's (null only for a script that filled the hidden field)
//   200 { ok: true, declined: true }     "No, I do not want to close": nothing was changed, the link still works
//   400 { code: "invalid", problems }    which details are wrong and why
//   400 { code, token }                  token_invalid | token_expired | token_too_fast: try again with this fresh token
//   404 { code: "not_found" }            an unknown, used, withdrawn, replaced or expired link, or Compliance off: ONE answer for all of them
//   413 { code: "too_large" }            429 { code: "rate_limited" }       503 { code: "failed" | "unavailable" }
//
// The body is capped (a file and the details). It never carries a link, a stored answer or the words of the database back, and never says which of the
// reasons a link does not work.
// ============================================================
import { linkSubmitResponse } from "@/lib/compliance/chat-link/http";
import { submitLinkForm } from "@/lib/compliance/chat-link/public";
import { publicEnv, publicJson, readSubmission } from "@/lib/compliance/public/http";
import { clientIp } from "@/lib/net/client-ip";
import { detectFileKind } from "@/lib/net/file-kind";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ip = clientIp(request.headers);
    // a cheap per-process ceiling before anything is looked up
    if (!checkRateLimit(`cmp-link:${ip}`, { limit: 90, windowMs: 60_000 }).success) return publicJson({ code: "rate_limited" }, 429);
    const read = await readSubmission(request);
    if (!read.ok) return publicJson({ code: read.code }, read.status);
    return linkSubmitResponse(await submitLinkForm(publicEnv(), { body: read.payload, files: read.files, ip }, detectFileKind));
  } catch {
    console.error("[compliance] a closure form submission failed");
    return publicJson({ code: "failed" }, 500);
  }
}
