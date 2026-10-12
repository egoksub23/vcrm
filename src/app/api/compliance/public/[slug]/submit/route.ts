// ============================================================
// POST /api/compliance/public/[slug]/submit   (public: the parent form at /c/<slug>, no login)
//
// The request itself: a multipart post with a JSON `payload` (the page's signed form token, the address again, the details, the acknowledgements, the
// hidden field, the language) and at most two files (`letter`, the authorization letter, and `proof`, a withdrawal's optional proof). Files travel with
// the submission so a case is never made without the letter it needs. The session cookie set by /verify proves the address.
//
// Answers (always JSON, never cached):
//   200 { ok: true, reference }          taken: a first request, or a repeat (the reference of the request the person already has); `reference` is null
//                                        only for a script that filled the hidden field
//   200 { ok: true, declined: true }     "No, I do not want to close": nothing was created
//   400 { code: "invalid", problems }    which details are wrong and why
//   400 { code, token }                  token_invalid | token_expired | token_too_fast: try again with this fresh token
//   401 { code: "session_invalid" }      confirm the address again
//   404 { code: "not_found" }            unknown, switched off, or the workspace has Compliance off: one answer for all
//   413 { code: "too_large" }            429 { code: "rate_limited" }       503 { code: "failed" | "unavailable" }
//
// The body is capped (two 10 MB files and the details). It never carries a link or a stored answer back, and never says whether a case was already known.
// ============================================================
import { publicEnv, publicJson, readSubmission, submitResponse } from "@/lib/compliance/public/http";
import { submitPublicForm } from "@/lib/compliance/public/service";
import { readCookie, sessionCookieName } from "@/lib/compliance/public/session";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizeSlug } from "@/lib/sign/registration/slug";

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ip = clientIp(request.headers);
    if (!checkRateLimit(`cmp-public:${ip}`, { limit: 90, windowMs: 60_000 }).success) return publicJson({ code: "rate_limited" }, 429);
    const { slug } = await params;
    const clean = normalizeSlug(slug);
    if (!clean) return publicJson({ code: "not_found" }, 404);
    const read = await readSubmission(request);
    if (!read.ok) return publicJson({ code: read.code }, read.status);
    const sessionValue = readCookie(request.headers.get("cookie"), sessionCookieName(clean));
    return submitResponse(await submitPublicForm(publicEnv(), { slug: clean, body: read.payload, files: read.files, sessionValue, ip }));
  } catch {
    console.error("[compliance] a public submission failed");
    return publicJson({ code: "failed" }, 500);
  }
}
