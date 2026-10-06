// ============================================================
// POST /api/sign/lists/[key]/reset   (sign.settings)
//
// "Reset to default" for a list that comes with Doc Sign: every item it ships with is back as shipped (labels and place);
// what the workspace added stays, after them. Nothing is removed. Forms already made are not touched.
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { resetList } from "@/lib/sign/service/lists";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return staff("sign.settings", request, async ({ ctx }) => json({ list: await resetList(ctx, (await params).key) }));
}
