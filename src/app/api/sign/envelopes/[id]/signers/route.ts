// ============================================================
// PUT /api/sign/envelopes/[id]/signers   (sign.send)
//
// Replace a draft collection's people. `people` is a list of persons; each has a full name, an email and a `type`: "signer" (the default: must
// sign) or "copy" (receives the signed copy, nothing else). A person who must sign also has a channel (email or WhatsApp, with a phone number for
// WhatsApp), a `step` (only for a collection that needs signing order), a stable `key` (a `pp_` key the screen keeps for them) and `roles`: for
// the documents made from a TEMPLATE, the template's role the person has on each (by document id). An uploaded file has no roles of its own: it
// takes one from each person who must sign (their key, their name), kept in step here. Saved to every document, the person's rows tied together.
// A list that is not sound is refused (400 bad_signers) with the people and documents it is about. The people who receive a copy are saved in
// the same call (not part of the signing list). Answers { signers, copies }.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { setCopyRecipients } from "@/lib/sign/service/copy-recipients";
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
        type: x.type === "copy" ? "copy" : "signer",
        key: typeof x.key === "string" ? x.key : undefined,
        incomplete: x.incomplete === true,
      };
    });
    const signers = await setEnvelopeSigners(ctx, id, people);
    // the people who receive a copy are saved after the signing list (so a copy to someone who signs is refused against the list as saved)
    const copies = await setCopyRecipients(ctx, { envelopeId: id }, people.filter((p) => p.type === "copy").map((p) => ({ fullName: p.fullName, email: p.email })));
    return json({ signers, copies });
  });
}
