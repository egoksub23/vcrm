// ============================================================
// Operator (platform administrator) authentication for the
// /api/platform routes. Server-only.
//
// A platform admin is an ordinary logged-in member of one account who
// also appears in `platform_admins` (migration 132). This is NOT built on
// getCurrentAccount(): an operator must be able to reach the console
// even if their own workspace is suspended or half-configured, and the
// check that matters is the database's own `is_platform_admin()`.
// Every mutation then goes through the SECURITY DEFINER platform_*
// RPCs, which re-check the same thing, so a route bug cannot widen
// access on its own.
// ============================================================
import type { SupabaseClient } from "@supabase/supabase-js";

import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

export interface PlatformContext {
  /** Cookie-session client; RLS and the platform RPCs see the operator. */
  supabase: SupabaseClient;
  userId: string;
}

export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new UnauthorizedError();

  const { data: isAdmin, error: rpcError } = await supabase.rpc("is_platform_admin");
  if (rpcError) {
    console.error("[requirePlatformAdmin] is_platform_admin failed:", rpcError.message);
    throw new ForbiddenError("Could not verify platform access");
  }
  if (isAdmin !== true) throw new ForbiddenError("Platform administrator access required");

  return { supabase, userId: user.id };
}
