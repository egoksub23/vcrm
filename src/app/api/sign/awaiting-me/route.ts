// ============================================================
// GET /api/sign/awaiting-me   (sign.sign)
//
// The documents whose turn it is for the signed-in person, who is a Halo user named on them (a countersigner): the
// document is sent or in progress, their place is invited and not finished and, when signing follows an order, their
// step has begun. Only their own places on documents of their own workspace. Each item has the title, reference, who
// sent it, when, when it expires and the signer id. The count is the number of items (at most 100).
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { listAwaitingMe } from "@/lib/sign/service/countersign";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function GET(request: Request) {
  return staff("sign.sign", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const items = await listAwaitingMe(ctx);
    return json({ items, count: items.length });
  });
}
