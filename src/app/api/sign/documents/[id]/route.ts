// ============================================================
// /api/sign/documents/[id]
//
//   GET     (menu.sign)  the document, its signers and files, and what stops a draft being sent
//   PATCH   (sign.send)  change a draft: title, category, contact, ticket and deal (attach or detach, F-51), message, language, expiry, signing order,
//                        code, reminders, values to fill in, fields and roles
//   DELETE  (sign.send)  delete a draft and its files; or, with sign.settings as well, a signed document whose retention
//                        date has passed (409 document_retained, with the date, before that). A document that was sent
//                        is voided, never deleted.
// ============================================================
import { assertCapability } from "@/lib/auth/account";
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { sendProblems } from "@/lib/sign/rules";
import { SignError } from "@/lib/sign/service/errors";
import { deleteDocument, updateDraft, type DraftPatch } from "@/lib/sign/service/drafts";
import { loadDocument, loadSigners } from "@/lib/sign/service/context";
import { envelopeBrief } from "@/lib/sign/service/envelopes";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const id = await idOf(params);
    const doc = await loadDocument(ctx, id);
    const signers = await loadSigners(ctx, id);
    const files = await ctx.admin.from("sign_document_files").select("id, kind, name, mime, size_bytes, sha256, created_at").eq("document_id", id).eq("account_id", ctx.accountId);
    const problems =
      doc.status === "draft"
        ? sendProblems({
            fields: doc.fields_snapshot,
            roles: doc.roles_snapshot,
            signers: signers.map((s) => ({ role_key: s.role_key, kind: s.kind, full_name: s.full_name, email: s.email, phone: s.phone, channel: s.channel, order_no: s.order_no })),
            signInOrder: doc.sign_in_order,
            pageCount: doc.page_count ?? 0,
            hasBaseFile: !!doc.base_path,
          })
        : [];
    // a document of an envelope says which, and what its siblings are (their titles and states only)
    return json({ document: doc, signers, files: files.data ?? [], problems, envelope: await envelopeBrief(ctx, doc.envelope_id) });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<DraftPatch>(request);
    // an id that is not an id is "not found", not a database error (the ticket and the deal are checked against the workspace by the service)
    for (const [key, code] of [["ticketId", "ticket_not_found"], ["dealId", "deal_not_found"]] as const) {
      const v = body[key];
      if (v !== undefined && v !== null && !(typeof v === "string" && UUID_RE.test(v))) throw new SignError(code, key === "ticketId" ? "That ticket was not found." : "That deal was not found.", 400);
    }
    const document = await updateDraft(ctx, id, body);
    return json({ document });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx, auth }) => {
    const id = await idOf(params);
    // a signed document is a record: whoever may delete a draft may not delete that; it takes sign.settings, and the retention date
    if ((await loadDocument(ctx, id)).status !== "draft") assertCapability(auth, "sign.settings");
    await deleteDocument(ctx, id);
    return json({ deleted: true });
  });
}
