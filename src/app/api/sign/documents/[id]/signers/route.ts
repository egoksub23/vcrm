// ============================================================
// PUT /api/sign/documents/[id]/signers   (sign.send)
//
// Replace a draft's signing list: full name, email, role, channel (email or WhatsApp, with a phone number
// for WhatsApp) and order for each person. The order only matters if the document needs signing order.
//
// Two bodies are read:
//   { signers: [{ roleKey, kind, fullName, email, ... }] }   the list as it always was (for a caller that already knows the roles)
//   { people: [{ fullName, email, type, channel, step, key, roles, incomplete, internalUserId }], ordered? }
//       the people of the sending screens (the same as a document collection's): a person is a name, an email and a type ("signer" or
//       "copy"). An uploaded file takes a role from each person who must sign (their key, their name), kept in step with the people here;
//       a document from a template keeps the template's roles and `roles` says which person has which. The people who receive a copy are
//       saved in the same call. Answers { signers, copies }.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { setCopyRecipients } from "@/lib/sign/service/copy-recipients";
import { setSigners, type SignerInput } from "@/lib/sign/service/drafts";
import { setDocumentPeople } from "@/lib/sign/service/document-people";
import { parsePeople } from "@/lib/sign/service/people-input";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    const body = await readJson<{ signers?: unknown; people?: unknown; ordered?: unknown }>(request);
    if (Array.isArray(body.people)) {
      const people = parsePeople(body.people);
      const signers = await setDocumentPeople(ctx, id, people, { ordered: typeof body.ordered === "boolean" ? body.ordered : undefined });
      // the people who receive a copy are saved after the signing list (so a copy to someone who signs is refused against the list as saved)
      const copies = await setCopyRecipients(ctx, { documentId: id }, people.filter((p) => p.type === "copy").map((p) => ({ fullName: p.fullName, email: p.email })));
      return json({ signers, copies });
    }
    if (!Array.isArray(body.signers)) throw new SignError("bad_signers", "Send the list of people.", 400);
    const signers: SignerInput[] = body.signers.map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      return {
        roleKey: String(x.roleKey ?? ""),
        kind: x.kind === "filler" ? "filler" : "signer",
        fullName: String(x.fullName ?? ""),
        email: String(x.email ?? ""),
        phone: typeof x.phone === "string" ? x.phone : null,
        channel: x.channel === "whatsapp" ? "whatsapp" : "email",
        orderNo: Number(x.orderNo ?? 0),
        internalUserId: typeof x.internalUserId === "string" && UUID_RE.test(x.internalUserId) ? x.internalUserId : null,
      };
    });
    return json({ signers: await setSigners(ctx, id, signers) });
  });
}
