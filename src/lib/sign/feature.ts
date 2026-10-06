// ============================================================
// Is Doc Sign on for this workspace? The operator's flags `sign` and `sign_merchant`
// (account_platform.features, migration 157), read the way the platform layer reads every flag
// (lib/platform/features.ts): a missing key reads as on, which is why migration 157 wrote an explicit
// false for every workspace that existed and the seed writes one for every new workspace.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";

async function flag(admin: SupabaseClient, accountId: string, feature: "sign" | "sign_merchant"): Promise<boolean> {
  const { data, error } = await admin.from("account_platform").select("status, features").eq("account_id", accountId).maybeSingle();
  // Cannot read it, or there is no row: do not assume the module is on.
  if (error || !data) return false;
  const platform = parsePlatformRow(data);
  return platform.status === "active" && isFeatureEnabled(platform, feature);
}

export const signEnabled = (admin: SupabaseClient, accountId: string) => flag(admin, accountId, "sign");

/** The Merchant Registration add-on needs Doc Sign itself to be on too. */
export async function signMerchantEnabled(admin: SupabaseClient, accountId: string): Promise<boolean> {
  return (await signEnabled(admin, accountId)) && (await flag(admin, accountId, "sign_merchant"));
}
