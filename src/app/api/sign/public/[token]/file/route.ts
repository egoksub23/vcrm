// ============================================================
// GET /api/sign/public/[token]/file
//
// The PDF a signer may see: the document as it was sent while it is open, and the sealed copy once it is
// complete (the only time they can keep a copy). When a code is required it must have been entered.
// ============================================================
import { NextResponse } from "next/server";

import { json, publicLink } from "@/lib/sign/http";
import { fileForSigner } from "@/lib/sign/service/signing";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(request, params, async ({ ctx, lookup, sessionOk }) => {
    const file = await fileForSigner(ctx, lookup, sessionOk);
    if (!file) return json({ error: "There is no file to show.", code: "no_file" }, 404);
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.byteLength),
        // Only the finished copy is offered as a download; while the document is open it is a view.
        "Content-Disposition": `${download && file.kind === "final" ? "attachment" : "inline"}; filename="${file.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
