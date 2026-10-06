// ============================================================
// POST /api/sign/public/[token]/consent   { locale? }
//
// The signer agrees to sign electronically. The version of the wording shown, the time, the address and
// the device are recorded. Nothing can be entered or signed before this.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { pageState, recordConsent, codeRequiredFor } from "@/lib/sign/service/signing";
import { SIGN_LOCALES } from "@/lib/sign/types";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(request, params, async ({ ctx, lookup, sessionOk, ip, device }) => {
    if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
    if (pageState(lookup.doc, lookup.signer) !== "active") throw new SignError("signer_not_open", "This document can no longer be completed.", 409);
    const body = await readJson<{ locale?: unknown }>(request, 2000);
    const locale = typeof body.locale === "string" && SIGN_LOCALES.includes(body.locale as never) ? body.locale : null;
    await recordConsent(ctx, lookup, locale, ip, device);
    return json({ consented: true });
  });
}
