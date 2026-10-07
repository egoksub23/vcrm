// ============================================================
// GET /api/sign/public/[token]/file
//
// The PDF a signer may see: the document as it was sent while it is open, and the sealed copy once it is
// complete (the only time they can keep a copy). When a code is required it must have been entered.
//
// `?part=certificate` (migration 178) is the certificate of a completed document when it is a file of its own, and `?part=zip` everything of
// it in one zip (the signed document and its certificate; for a link that is a document collection's, every completed document of the person's
// with its certificate and a small summary). Both are downloads, under the same rules as the signed copy.
// ============================================================
import { NextResponse } from "next/server";

import { json, publicLink } from "@/lib/sign/http";
import { certificateForSigner, fileForSigner, zipForSigner } from "@/lib/sign/service/signing";

const safeName = (name: string) => name.replace(/["\r\n]/g, "");

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(request, params, async ({ ctx, lookup, sessionOk }) => {
    const url = new URL(request.url);
    const part = url.searchParams.get("part");
    if (part === "zip") {
      const zip = await zipForSigner(ctx, lookup, sessionOk);
      if (!zip) return json({ error: "There is no file to show.", code: "no_file" }, 404);
      return new NextResponse(zip.stream, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${safeName(zip.filename)}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const file = part === "certificate" ? await certificateForSigner(ctx, lookup, sessionOk).then((c) => (c ? { ...c, kind: "final" as const } : null)) : await fileForSigner(ctx, lookup, sessionOk);
    if (!file) return json({ error: "There is no file to show.", code: "no_file" }, 404);
    const download = url.searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.byteLength),
        // Only the finished copy is offered as a download; while the document is open it is a view.
        "Content-Disposition": `${download && file.kind === "final" ? "attachment" : "inline"}; filename="${safeName(file.filename)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
