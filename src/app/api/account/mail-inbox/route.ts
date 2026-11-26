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
    const emailRow = email.error ? null : (email.data as { inbox_enabled?: boolean | null } | null);
    const gmailRow = gmail.error ? null : (gmail.data as { inbox_enabled?: boolean | null } | null);
    const off = mailInboxOffChannels({ email_config: emailRow, gmail_config: gmailRow });
    // Hide the Emails tab when no email channel is active (connected + inbox_enabled).
    // A null row means the mailbox is not connected — also not active.
    const hasActiveEmail =
      (emailRow !== null && emailRow.inbox_enabled !== false) ||
      (gmailRow !== null && gmailRow.inbox_enabled !== false);
    return NextResponse.json({ offChannels: off, hideEmailTab: !hasActiveEmail });
  } catch (err) {
    return toErrorResponse(err);
  }
}
