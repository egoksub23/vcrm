// ============================================================
// GET /api/sign/bulk/[id]   (menu.sign)
//
// One batch with its live totals (sent, failed, skipped, still waiting) and a page of its people: ?offset=0,
// ?limit= (at most 200, default 100), ?state=pending|sent|failed|skipped. The screen asks again every few seconds
// while the batch is running.
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { getBulkJob } from "@/lib/sign/service/bulk";
import { assertSignOn } from "@/lib/sign/service/gate";
import type { BulkRowState } from "@/lib/sign/bulk/types";

const STATES: readonly string[] = ["pending", "sent", "failed", "skipped"];

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("menu.sign", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const { id } = await params;
    const q = new URL(request.url).searchParams;
    const state = q.get("state");
    const offset = Number(q.get("offset"));
    const limit = Number(q.get("limit"));
    return json(
      await getBulkJob(ctx, id, {
        offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
        state: state && STATES.includes(state) ? (state as BulkRowState) : null,
      }),
    );
  });
}
