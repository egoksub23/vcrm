// ============================================================
// /api/sign/public/[token]/forward
//
//   POST    { fullName, email, note?, part? }   hand the signer's whole turn, or (with `part`) one part of the
//                                               form, to someone else
//   DELETE  { part }                            take a part back before it is completed
//
// Forwarding is the sender's choice (off unless the template or the document allows it). The new person gets
// a link of their own, agrees to sign for themselves and sees only what was handed to them; a whole turn
// makes them the signer for that role and the old link stops at once. At most two forwards per position, a
// few an hour, never to yourself or to someone already on the document for the role. A person who was
// handed a part cannot pass it on. Every forward is an audit event with a name and a masked address, never
// a link. When a code is required it must have been entered.
// ============================================================
import { json, publicLink, readJson, sharedLimit } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { forwardFromLink, takeBackFromLink } from "@/lib/sign/service/forward";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ fullName?: unknown; email?: unknown; note?: unknown; part?: unknown }>(request, 6000);
      if (typeof body.fullName !== "string" || typeof body.email !== "string") throw new SignError("forward_details", "Enter a full name and a valid email.", 400);
      if (body.part !== undefined && body.part !== null && typeof body.part !== "string") throw new SignError("forward_part_unknown", "Choose a part.", 400);
      const result = await forwardFromLink(ctx, lookup, { fullName: body.fullName, email: body.email, note: body.note as string | null | undefined, part: (body.part as string | null | undefined) ?? null }, { ip, device }, sharedLimit);
      return json(result);
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}

export async function DELETE(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk, ip, device }) => {
      if (lookup.doc.code_required && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const body = await readJson<{ part?: unknown }>(request, 2000);
      if (typeof body.part !== "string" || !body.part) throw new SignError("forward_part_unknown", "Choose a part.", 400);
      return json(await takeBackFromLink(ctx, lookup, body.part, { ip, device }));
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
