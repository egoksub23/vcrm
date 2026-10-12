// ============================================================
// POST /api/compliance/public/[slug]/verify   (public: the parent form at /c/<slug>, no login)
//
// "Here is the code": { email, code }. A right code gives a session: an HttpOnly cookie for this form for an hour, carrying a keyed hash of the address
// (never the address). Every try is counted in the database BEFORE it is judged, five tries per code.
//
// Answers (always JSON, never cached):
//   200 { ok: true, emailMasked }  + Set-Cookie
//   400 { code: "wrong_code", attemptsLeft } | { code: "expired" | "too_many_attempts" | "no_code" | "invalid_email" }
//   404 { code: "not_found" }      429 { code: "rate_limited" }      503 { code: "unavailable" }
// "no_code" is the answer for a code that was never asked for, one for another address and one already used: it does not say which.
// ============================================================
import { publicEnv, publicJson, readSmallJson, verifyResponse } from "@/lib/compliance/public/http";
import { verifyCode } from "@/lib/compliance/public/service";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ip = clientIp(request.headers);
    if (!checkRateLimit(`cmp-public:${ip}`, { limit: 90, windowMs: 60_000 }).success) return publicJson({ code: "rate_limited" }, 429);
    const { slug } = await params;
    const body = await readSmallJson(request);
    if (!body) return publicJson({ code: "bad_request" }, 400);
    return verifyResponse(await verifyCode(publicEnv(), { slug, body, ip }));
  } catch {
    console.error("[compliance] a public code entry failed");
    return publicJson({ code: "failed" }, 500);
  }
}
