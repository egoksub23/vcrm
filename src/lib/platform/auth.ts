// ============================================================
// Operator (platform administrator) authentication for the
// /api/platform routes. Server-only.
//
// Phase 1: replaces supabase.auth.getUser() with Auth.js auth().
// The is_platform_admin() RPC check is unchanged.
// ============================================================

import { auth } from "@/auth";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";
import { createPgDb, type PgDb } from "@/lib/postgres/db";

export interface PlatformContext {
  /** Data client (RLS-scoped to the authenticated admin user). */
  supabase: PgDb,
  userId: string;
}

export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthorizedError();

  // Use Supabase SSR client only for the is_platform_admin() check (RLS-dependent RPC).
  const supabase = await createClient();
  const { data: isAdmin, error: rpcError } =
    await supabase.rpc("is_platform_admin");
  if (rpcError) {
    console.error(
      "[requirePlatformAdmin] is_platform_admin failed:",
      rpcError.message,
    );
    throw new ForbiddenError("Could not verify platform access");
  }
  if (isAdmin !== true) throw new ForbiddenError("Platform administrator access required");

  return { supabase: createPgDb(session.user.id), userId: session.user.id };
}
