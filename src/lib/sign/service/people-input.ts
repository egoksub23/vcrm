// ============================================================
// Doc Sign: the people of a request, as the two "people" routes read them (a document collection's, PUT /api/sign/envelopes/[id]/signers, and a
// document on its own, PUT /api/sign/documents/[id]/signers with `people`). One parser, so a person means the same on both. Anything that is
// not a person is read as an empty one; what is wrong with a name or an address is said when the list is checked.
// ============================================================

import type { EnvelopePersonInput } from "./envelopes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePeople(raw: readonly unknown[]): EnvelopePersonInput[] {
  return raw.map((p) => {
    const x = (p ?? {}) as Record<string, unknown>;
    const roles: Record<string, string> = {};
    if (typeof x.roles === "object" && x.roles !== null && !Array.isArray(x.roles)) {
      for (const [doc, role] of Object.entries(x.roles as Record<string, unknown>)) if (UUID.test(doc) && typeof role === "string" && role) roles[doc] = role;
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
      internalUserId: typeof x.internalUserId === "string" && UUID.test(x.internalUserId) ? x.internalUserId : null,
    } satisfies EnvelopePersonInput;
  });
}
