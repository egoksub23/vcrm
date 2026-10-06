// ============================================================
// GET /api/sign/attention   (menu.sign)
//
// The "Needs attention" shortcut of the documents list: documents that were declined or expired in the last 30 days or
// failed to seal, and open documents where a message to someone did not arrive and has not been put right since. Each
// item says why (`reasons`) and who it is about. A bounce the mail provider reports after it accepted the message is
// not recorded anywhere, so only failures the app saw appear.
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { listNeedsAttention } from "@/lib/sign/service/countersign";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const items = await listNeedsAttention(ctx);
    return json({ items, count: items.length });
  });
}
