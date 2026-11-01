import { type PgDb } from '@/lib/postgres/db'

import { isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";

export async function shareEnabled(admin: PgDb, accountId: string): Promise<boolean> {
  const { data, error } = await admin.from("account_platform").select("status, features").eq("account_id", accountId).maybeSingle();
  if (error || !data) return false;
  const platform = parsePlatformRow(data);
  return platform.status === "active" && isFeatureEnabled(platform, "share");
}
