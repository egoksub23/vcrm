// ============================================================
// POST /api/sign/public/[token]/decline   { reason? }
//
// The signer declines. The chain stops, the sender and the others who were invited are told, and every
// link then shows how the document ended.
// ============================================================
import { json, publicLink, readJson } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { declineSigning } from "@/lib/sign/service/signing";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ reason?: unknown }>(request, 6000);
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : null;
      await declineSigning(ctx, lookup, reason, { ip, device });
      return json({ declined: true });
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
