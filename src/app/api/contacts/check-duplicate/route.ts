import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { findExistingContact } from "@/lib/contacts/dedupe";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const phone = searchParams.get("phone") ?? "";
    const excludeId = searchParams.get("excludeId") ?? undefined;

    if (!phone) return NextResponse.json({ contact: null });

    const contact = await findExistingContact(
      ctx.supabase as never,
      ctx.accountId,
      phone,
      excludeId || undefined,
    );
    return NextResponse.json({ contact });
  } catch (err) {
    return toErrorResponse(err);
  }
}
