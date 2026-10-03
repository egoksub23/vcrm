// ============================================================
// GET  /api/account/onboarding  (settings.workspace) — what the workspace has done
// POST /api/account/onboarding  (settings.workspace) — hide the checklist for everyone
//
// The first-run checklist on the dashboard (migration 155). The facts are
// true/false only, read by onboarding_status(), which any member of the
// workspace may call; the checklist itself is shown to the people who can act
// on it (workspace admins). Dismissing is for the whole workspace.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseOnboardingFacts } from "@/lib/onboarding/checklist";

export async function GET() {
  try {
    const ctx = await requireCapability("settings.workspace");
    const { data, error } = await ctx.supabase.rpc("onboarding_status", { p_account: ctx.accountId });
    const facts = parseOnboardingFacts(data);
    if (error || !facts) {
      console.error("[GET /api/account/onboarding] rpc error:", error);
      return NextResponse.json({ error: "Failed to load the setup checklist" }, { status: 500 });
    }
    return NextResponse.json({ facts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST() {
  try {
    const ctx = await requireCapability("settings.workspace");
    const { error } = await ctx.supabase.rpc("onboarding_dismiss", { p_account: ctx.accountId });
    if (error) {
      if (error.code === "42501") return NextResponse.json({ error: error.message }, { status: 403 });
      console.error("[POST /api/account/onboarding] rpc error:", error);
      return NextResponse.json({ error: "Could not hide the setup checklist" }, { status: 500 });
    }
    return NextResponse.json({ dismissed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
