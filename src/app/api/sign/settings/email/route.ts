// ============================================================
// /api/sign/settings/email   (sign.settings)
//
//   GET    which way the workspace's email goes out: through its connected Gmail mailbox (`via: "mailbox"`, with the address), through the
//          platform sender (`"platform"`), or not at all yet (`"none"`). A connected mailbox that cannot send (access revoked, switched off) is
//          named in `problem`. Read only: there is no setting here, the mailbox is connected in Settings > Channels > Gmail.
//   POST   send one short test email to the signed-in person's own address through that transport. Answers `{ result }` with `sent`, and when
//          it did not go, `reason` (a named cause) and `detail` (what the mail service said). Five an hour is plenty: every one is a real send
//          from the workspace's mailbox, against Gmail's daily limit.
//
// No token, key or secret is read into the answer.
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { describeEmail, sendTestEmail } from "@/lib/sign/service/email-status";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => json({ email: await describeEmail(ctx) }));
}

export async function POST(request: Request) {
  return staff("sign.settings", request, async ({ ctx, auth }) => {
    // its own budget: the one `staff` keeps is shared by every sign.settings route and is far larger
    const rate = checkRateLimit(`sign-test-email:${auth.userId}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!rate.success) return rateLimitResponse(rate);
    return json({ result: await sendTestEmail(ctx) });
  });
}
