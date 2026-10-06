// ============================================================
// POST /api/sign/bulk/[id]/cancel   (sign.send)
//
// Stop a batch that is queued or running. Documents already sent stay sent; the person whose document is being
// sent at this moment is finished; everyone else is recorded as skipped ("cancelled").
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { cancelBulk } from "@/lib/sign/service/bulk";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const { id } = await params;
    return json({ job: await cancelBulk(ctx, id) });
  });
}
