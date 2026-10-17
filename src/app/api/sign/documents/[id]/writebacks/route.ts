// ============================================================
// GET /api/sign/documents/[id]/writebacks   (menu.sign)
//
// The contact changes the answers of a document made, for the history on the document's screen: which contact field,
// and its old and new value. The values are personal data: they are real only for a person who holds
// `sign.reveal-sensitive` (checked here, from the capabilities the route already loaded); for anyone else with the menu
// they come as a mask. See service/writeback-history.ts.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { loadWritebackHistory } from "@/lib/sign/service/writeback-history";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx, auth }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    return json(await loadWritebackHistory(ctx, id, auth.capabilities.has("sign.reveal-sensitive")));
  });
}
