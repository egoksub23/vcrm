// ============================================================
// POST /api/compliance/public/[slug]/code   (public: the parent form at /c/<slug>, no login)
//
// "Send me a code": { email, locale?, captcha?, website? }. Emails a six-digit code to the address typed (through the workspace's own sender), valid 15
// minutes, five tries, three codes an hour per address. Everything that decides what happens is in lib/compliance/public/service.ts.
//
// Answers (always JSON, never cached):
//   200 { ok: true, emailMasked }               a code is on its way (or a script filled the hidden field: the answer is the same)
//   400 { code: "invalid_email" | "captcha_failed" }
//   404 { code: "not_found" }                   unknown, switched off, or the workspace has Compliance off: one answer for all
//   429 { code: "rate_limited" }
//   503 { code: "send_failed" | "unavailable" } the email could not be sent now; the server has no key to hash with
// ============================================================
import { codeResponse, publicEnv, publicJson, readSmallJson } from "@/lib/compliance/public/http";
import { requestCode } from "@/lib/compliance/public/service";
import { clientIp } from "@/lib/net/client-ip";
import { checkRateLimit } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ip = clientIp(request.headers);
    // a cheap per-process ceiling before anything is looked up, so an unknown address cannot be hammered for free (the budgets that count in the database are in the service)
    if (!checkRateLimit(`cmp-public:${ip}`, { limit: 90, windowMs: 60_000 }).success) return publicJson({ code: "rate_limited" }, 429);
    const { slug } = await params;
    const body = await readSmallJson(request);
    if (!body) return publicJson({ code: "bad_request" }, 400);
    return codeResponse(await requestCode(publicEnv(), { slug, body, ip }));
  } catch {
    console.error("[compliance] a public code request failed");
    return publicJson({ code: "failed" }, 500);
  }
}
