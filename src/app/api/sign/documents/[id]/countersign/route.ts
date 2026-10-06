// ============================================================
// POST /api/sign/documents/[id]/countersign   (sign.sign)
//
// A Halo user who is named as a signer on a document opens their own turn from inside Halo. Their identity comes from
// their login: the old link of their place stops, a new one is made (nothing is sent anywhere), and a session for that
// signer is set so the verification code is not asked (the audit trail records the method "halo_login"). The answer is
// the path of the signer page, `{ url: "/s/<link>", signerId }`, for the browser to open in the same tab (a path, so it opens on the same address the session cookie was set for); the consent, the signing
// and the sealing then run through the normal signer page and endpoints.
//
//   403 not_a_signer         the caller is not a Halo-user signer on this document (also when it does not exist)
//   409 not_your_turn        their step has not begun
//   409 document_not_open    the document is finished, voided, expired or not sent
//   409 already_signed       they have signed (409 signer_not_open when they declined)
// ============================================================
import { clientIp } from "@/lib/net/client-ip";
import { UUID_RE, json, sessionCookie, staff } from "@/lib/sign/http";
import { openCountersign } from "@/lib/sign/service/countersign";
import { SignError } from "@/lib/sign/service/errors";
import { assertSignOn } from "@/lib/sign/service/gate";
import { sessionCookieName } from "@/lib/sign/tokens";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.sign", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("not_a_signer", "You are not a signer on this document.", 403);
    const ip = clientIp(request.headers);
    const opened = await openCountersign(ctx, id, { ip: ip === "unknown" ? null : ip, device: (request.headers.get("user-agent") ?? "").slice(0, 300) || null });
    const res = json({ url: `/s/${opened.token}`, signerId: opened.signerId });
    if (opened.session) res.headers.append("Set-Cookie", sessionCookie(sessionCookieName(opened.signerId), opened.session.value, opened.session.maxAgeSeconds));
    return res;
  }, { rate: { limit: 20, windowMs: 60_000 } });
}
