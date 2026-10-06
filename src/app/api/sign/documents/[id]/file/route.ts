// ============================================================
// GET /api/sign/documents/[id]/file?kind=base|final|original   (menu.sign)
//
// The bytes of one of a document's files, for the editor and the detail screen. `base` is the working
// PDF (while a draft) or the file as it was sent; `final` is the sealed copy; `original` is the upload as
// received (a Word file stays a Word file). Opening or downloading the sealed copy is recorded.
// ============================================================
import { NextResponse } from "next/server";

import { UUID_RE, staff } from "@/lib/sign/http";
import { loadDocument, logEvent } from "@/lib/sign/service/context";
import { SignError } from "@/lib/sign/service/errors";
import { getFile, safeFileName } from "@/lib/sign/storage";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
    const doc = await loadDocument(ctx, id);
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") ?? "base";
    const download = url.searchParams.get("download") === "1";
    const stem = safeFileName(doc.reference ?? doc.title, "document");

    let path: string | null = null;
    let mime = "application/pdf";
    let filename = `${stem}.pdf`;
    if (kind === "final") {
      path = doc.final_path;
      filename = `${stem}-signed.pdf`;
      if (!path) throw new SignError("no_final_file", "This document has not been sealed yet.", 404);
    } else if (kind === "original") {
      path = doc.original_path;
      mime = doc.original_type ?? "application/octet-stream";
      const ext = mime.includes("wordprocessingml") ? "docx" : mime.includes("msword") ? "doc" : mime.startsWith("image/") ? mime.slice(6).replace("jpeg", "jpg") : "pdf";
      filename = `${stem}-original.${ext}`;
      if (!path) throw new SignError("no_original_file", "This document has no separate original file.", 404);
    } else if (kind === "base") {
      path = doc.base_path;
      if (!path) throw new SignError("no_file", "This document has no file.", 404);
    } else {
      throw new SignError("bad_kind", "Choose base, final or original.", 400);
    }

    const bytes = await getFile(ctx.admin, path, ctx.accountId);
    if (kind === "final") await logEvent(ctx, id, "downloaded", { actor: "user", userId: ctx.userId, detail: { kind } });
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${download || kind === "original" ? "attachment" : "inline"}; filename="${filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
