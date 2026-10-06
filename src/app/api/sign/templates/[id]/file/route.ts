// ============================================================
// GET /api/sign/templates/[id]/file   (menu.sign)
//
// The template's current PDF, for the editor to show.
// ============================================================
import { NextResponse } from "next/server";

import { UUID_RE, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { templateFile } from "@/lib/sign/service/templates";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
    const { bytes } = await templateFile(ctx, id);
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": 'inline; filename="template.pdf"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
