// ============================================================
// PUT /api/sign/envelopes/[id]/signers   (sign.send)
//
// Replace a draft envelope's ONE signing list. `people` is a list of persons; each has a full name, email, channel (email or WhatsApp, with a phone
// number for WhatsApp), a `step` (only for an envelope that needs signing order) and `roles`: the role the person has on each document, by
// document id (a document left out is one they are not on). Saved to every document, the person's rows tied together. A list that is not sound
// is refused (400 bad_signers) with the people and documents it is about.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { setEnvelopeSigners, type EnvelopePersonInput } from "@/lib/sign/service/envelopes";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
    const body = await readJson<{ people?: unknown }>(request);
    if (!Array.isArray(body.people)) throw new SignError("bad_signers", "Send the list of people.", 400);
    const people: EnvelopePersonInput[] = body.people.map((p) => {
      const x = (p ?? {}) as Record<string, unknown>;
      const roles: Record<string, string> = {};
      if (typeof x.roles === "object" && x.roles !== null && !Array.isArray(x.roles)) {
        for (const [doc, role] of Object.entries(x.roles as Record<string, unknown>)) if (UUID_RE.test(doc) && typeof role === "string" && role) roles[doc] = role;
      }
      return {
        fullName: String(x.fullName ?? ""),
        email: String(x.email ?? ""),
        phone: typeof x.phone === "string" ? x.phone : null,
        channel: x.channel === "whatsapp" ? "whatsapp" : "email",
        step: Number(x.step ?? 0) || undefined,
        roles,
      };
    });
    return json({ signers: await setEnvelopeSigners(ctx, id, people) });
  });
}
