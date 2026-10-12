// ============================================================
// GET /api/compliance/requests/[id]/files/[fileId]   (compliance.review, compliance.approve or compliance.reveal)
//
// The bytes of one evidence file. A 'view' event (with the file's id) is written first. Served as an attachment, never inline, with `no-store`,
// `nosniff` and a sandboxing Content-Security-Policy, so the browser can only save it as the PDF or image it is.
// ============================================================
import { NextResponse } from "next/server";

import { complianceStaff, failure, UUID_RE } from "@/lib/compliance/http";
import { downloadFile } from "@/lib/compliance/service/files";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  return complianceStaff({ bucket: "download", perMinute: 60, needAny: ["compliance.review", "compliance.approve", "compliance.reveal"] }, async ({ admin, caller }) => {
    const { id, fileId } = await params;
    if (!UUID_RE.test(id) || !UUID_RE.test(fileId)) return failure("not_found");
    const f = await downloadFile(admin, caller, id, fileId);
    const safeName = f.name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "file";
    return new NextResponse(f.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(f.bytes.byteLength),
        "Content-Disposition": `attachment; filename="${safeName}"`,
        "Cache-Control": "no-store, no-cache, private",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
