// ============================================================
// Is Compliance requests on for this workspace? The operator's `compliance` flag (account_platform.features, migration 183), read the way the platform
// layer reads every flag (lib/platform/features.ts). `compliance` is one of the DEFAULT_OFF_FEATURES: a missing row, a missing key or a row that could
// not be read all mean OFF, and only an explicit `true` on an active workspace turns it on.
//
// The staff routes do not call this: the flag removes the `menu.compliance` / `compliance.*` capabilities from everyone in the workspace, so they are
// refused before they run. The places that have no signed-in person (the public parent forms, the hourly job) have no capabilities to lose, so they
// read the flag here.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";

export async function complianceEnabled(admin: SupabaseClient, accountId: string): Promise<boolean> {
  const { data, error } = await admin.from("account_platform").select("status, features").eq("account_id", accountId).maybeSingle();
  if (error || !data) return false;
  const platform = parsePlatformRow(data);
  return platform.status === "active" && isFeatureEnabled(platform, "compliance");
}
