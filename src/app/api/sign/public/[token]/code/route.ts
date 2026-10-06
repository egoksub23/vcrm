// ============================================================
// POST /api/sign/public/[token]/code
//
// Email the signer a six-digit code (only for a document that asks for one). The code lasts ten minutes,
// can be entered five times, and at most five can be sent an hour. The answer shows where it went with
// the address partly hidden.
// ============================================================
import { json, publicLink, sharedLimit } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { sendCode } from "@/lib/sign/service/signing";

function mask(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "";
  return `${name.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(name.length - 1, 6)))}@${domain}`;
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup }) => {
      const result = await sendCode(ctx, lookup, sharedLimit);
      if (!result.ok) {
        if (result.reason === "rate_limited") throw new SignError("code_rate_limited", "Too many codes were requested. Try again in a while.", 429);
        throw new SignError("code_not_needed", "This document does not need a code.", 400);
      }
      if (result.delivery.status !== "sent") throw new SignError("code_not_sent", "The code could not be sent. Ask the sender for a new link.", 502);
      return json({ sent: true, to: mask(lookup.signer.email) });
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
