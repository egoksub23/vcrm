// ============================================================
// /api/sign/bulk
//
//   GET   (menu.sign)  the workspace's recent batches, newest first (?limit=, at most 50)
//   POST  (sign.send)  start a batch: JSON { options, csv | contactIds, skipInvalid?, fileName? }. The list and the
//                      setup are checked again here exactly as the preview did, the month's limit must have room
//                      for every document, and then the batch is recorded; the documents are made and sent in
//                      the background (the Doc Sign job runs every minute), so closing the browser loses nothing.
//
// `options`: templateId, personRole, fixedSigners[], channel, title, categoryId, message, locale, expiryDays,
// codeRequired, signInOrder, reminderDays. `csv` is the file's text (at most 1 MB, 500 people); `contactIds` is a
// list of contacts (at most 500).
// ============================================================
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { json, readJson, staff } from "@/lib/sign/http";
import { createBulk, listBulkJobs } from "@/lib/sign/service/bulk";
import { assertSignOn } from "@/lib/sign/service/gate";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx }) => {
    await assertSignOn(ctx);
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    return json({ jobs: await listBulkJobs(ctx, Number.isFinite(limit) && limit > 0 ? limit : 20) });
  });
}

export async function POST(request: Request) {
  return staff("sign.send", request, async ({ ctx, auth }) => {
    await assertSignOn(ctx);
    const rate = checkRateLimit(`sign-bulk-create:${auth.userId}`, { limit: 6, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);
    const body = await readJson(request, 2_300_000);
    return json({ job: await createBulk(ctx, body) }, 201);
  });
}
