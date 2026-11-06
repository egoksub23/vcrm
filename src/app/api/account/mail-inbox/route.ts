import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { mailInboxOffChannels } from "@/lib/inbox/mail-inbox";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [email, gmail] = await Promise.all([
      ctx.supabase.from("email_config").select("inbox_enabled").eq("account_id", ctx.accountId).maybeSingle(),
      ctx.supabase.from("gmail_config").select("inbox_enabled").eq("account_id", ctx.accountId).maybeSingle(),
    ]);
    const off = mailInboxOffChannels({
      email_config: email.error ? null : (email.data as { inbox_enabled?: boolean | null } | null),
      gmail_config: gmail.error ? null : (gmail.data as { inbox_enabled?: boolean | null } | null),
    });
    return NextResponse.json({ offChannels: off });
  } catch (err) {
    return toErrorResponse(err);
  }
}
