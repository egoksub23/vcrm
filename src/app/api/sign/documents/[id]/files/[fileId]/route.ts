// ============================================================
// GET /api/sign/documents/[id]/files/[fileId]   (menu.sign)
//
// A file a signer uploaded to this document, as a download. The file must belong to this document and this
// workspace. Opening it is recorded in the audit trail (the file's id, never its contents).
// ============================================================
import { NextResponse } from "next/server";

import { UUID_RE, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { uploadedFileForStaff } from "@/lib/sign/service/progress";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { id, fileId } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    if (!UUID_RE.test(fileId)) throw new SignError("file_not_found", "That file was not found.", 404);
    const file = await uploadedFileForStaff(ctx, id, fileId);
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${file.name.replace(/["\\\r\n]/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
