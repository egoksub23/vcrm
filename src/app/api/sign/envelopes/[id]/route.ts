// ============================================================
// /api/sign/envelopes/[id]
//
//   GET     (menu.sign)  the envelope, its documents (summaries), the signing list (one row for each person on each document), and, for a draft,
//                        what stands between it and Send (each problem names its document) and whether the month's limit has room for all of them
//   PATCH   (sign.send)  change what an envelope shares while it is a draft: title, message, language, expiry, signing order, code, reminders,
//                        contact, ticket and deal, and whether it is private (migration 176: only its uploader or an admin may change that). The options are
//                        written onto every document in the same step.
//   DELETE  (sign.send)  delete a draft envelope with its drafts; or, with sign.settings as well, a completed one once every document's
//                        retention date has passed (409 document_retained, with the date, before that). A sent envelope is cancelled, never deleted.
// ============================================================
import { assertCapability } from "@/lib/auth/account";
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { loadEnvelope } from "@/lib/sign/service/envelope-data";
import { deleteEnvelope, envelopeData, updateEnvelope, type EnvelopePatch } from "@/lib/sign/service/envelopes";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => json(await envelopeData(ctx, await idOf(params))));
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<EnvelopePatch>(request);
    // an id that is not an id is "not found", not a database error (the contact, the ticket and the deal are checked against the workspace by the service)
    for (const [key, code] of [["contactId", "contact_not_found"], ["ticketId", "ticket_not_found"], ["dealId", "deal_not_found"]] as const) {
      const v = body[key];
      if (v !== undefined && v !== null && !(typeof v === "string" && UUID_RE.test(v))) throw new SignError(code, "That record was not found.", 400);
    }
    return json({ envelope: await updateEnvelope(ctx, id, body) });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx, auth }) => {
    const id = await idOf(params);
    // a signed envelope is a record: whoever may delete a draft may not delete that; it takes sign.settings, and the retention dates
    if ((await loadEnvelope(ctx, id)).status !== "draft") assertCapability(auth, "sign.settings");
    await deleteEnvelope(ctx, id);
    return json({ deleted: true });
  });
}
