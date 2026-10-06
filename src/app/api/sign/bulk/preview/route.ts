// ============================================================
// POST /api/sign/bulk/preview   (sign.send)
//
// What a batch would do, with nothing made and nothing sent: the same JSON as the start route (options, and csv
// or contactIds). The answer lists every problem of the file, the setup and each person, and whether the month's
// limit of documents has room for the people without a problem.
// ============================================================
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { json, readJson, staff } from "@/lib/sign/http";
import { previewBulk } from "@/lib/sign/service/bulk";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function POST(request: Request) {
  return staff("sign.send", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-bulk-preview:${auth.userId}`, { limit: 20, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);
    const body = await readJson(request, 2_300_000);
    return json(await previewBulk(ctx, body));
  });
}
