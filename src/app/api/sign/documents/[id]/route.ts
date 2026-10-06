// ============================================================
// /api/sign/documents/[id]
//
//   GET     (menu.sign)  the document, its signers and files, and what stops a draft being sent
//   PATCH   (sign.send)  change a draft: title, category, contact, message, language, expiry, signing order,
//                        code, reminders, values to fill in, fields and roles
//   DELETE  (sign.send)  delete a draft and its files (a document that was sent is voided, not deleted)
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { sendProblems } from "@/lib/sign/rules";
import { SignError } from "@/lib/sign/service/errors";
import { deleteDraft, updateDraft, type DraftPatch } from "@/lib/sign/service/drafts";
import { loadDocument, loadSigners } from "@/lib/sign/service/context";

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
    return json({ document: doc, signers, files: files.data ?? [], problems });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<DraftPatch>(request);
    const document = await updateDraft(ctx, id, body);
    return json({ document });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    await deleteDraft(ctx, await idOf(params));
    return json({ deleted: true });
  });
}
