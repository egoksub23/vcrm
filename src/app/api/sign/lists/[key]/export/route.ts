// ============================================================
// GET /api/sign/lists/[key]/export   (menu.sign)
//
// The list as a CSV file (UTF-8 with a byte order mark, so Excel shows Bahasa Melayu, Chinese and Korean correctly):
// value, en, ms, zh, ko, group, archived. The same file can be edited and imported back.
// ============================================================
import { NextResponse } from "next/server";

import { staff } from "@/lib/sign/http";
import { exportList } from "@/lib/sign/service/lists";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { filename, csv } = await exportList(ctx, (await params).key);
    return new NextResponse(csv, {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" },
    });
  });
}
