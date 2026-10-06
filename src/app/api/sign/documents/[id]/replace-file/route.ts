// ============================================================
// POST /api/sign/documents/[id]/replace-file   (sign.send)
//
// Replace the file of a DRAFT (F-77). Multipart: `file` (PDF, Word or an image), and `dryRun` = "1" to only find out what would
// happen. Fields that still fit stay where they are; the answer lists those that no longer do (`flagged`: page_missing,
// size_changed, outside_page). A document that was sent answers 409 `document_not_draft`; the very same file answers 409 `same_file`.
// ============================================================
import { UUID_RE, json, readUpload, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { assertSignOn } from "@/lib/sign/service/gate";
import { replaceDraftFile } from "@/lib/sign/service/replace-file";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      await assertSignOn(ctx);
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
      const { file, fields } = await readUpload(request);
      if (!file) throw new SignError("no_file", "Choose a file to upload.", 400);
      const result = await replaceDraftFile(ctx, id, { bytes: file.bytes, filename: file.name, dryRun: fields.dryRun === "1" });
      return json({ result });
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
