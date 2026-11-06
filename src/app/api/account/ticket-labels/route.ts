import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase.rpc("ticket_label_suggestions");
    if (error) {
      console.error("[GET /api/account/ticket-labels] rpc error:", error);
      return NextResponse.json({ error: "Failed to load ticket labels" }, { status: 500 });
    }
    const labels = ((data as { label: string; uses: number | string }[] | null) ?? []).map(
      (r) => ({ label: r.label, uses: Number(r.uses) }),
    );
    return NextResponse.json({ labels });
  } catch (err) {
    return toErrorResponse(err);
  }
}
