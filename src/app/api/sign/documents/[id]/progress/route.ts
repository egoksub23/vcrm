// ============================================================
// GET /api/sign/documents/[id]/progress   (menu.sign)
//
// A document with a form, as the sender sees it: for each role with parts, who it is, where each part
// stands (not started, in progress, done), the share of required answers given and the last activity; the
// answers so far (read only, hidden fields left out, files by name and size); and anything the sender should
// know, such as an answer too long for where it prints. 404 `no_form` for a document without a form.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { loadProgress } from "@/lib/sign/service/progress";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    return json(await loadProgress(ctx, id));
  });
}
