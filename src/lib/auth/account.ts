// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
//
// Prefer `requireCapability("tags.manage")` over `requireRole` for
// anything an Owner/Admin can edit per role (see ./capabilities.ts).
// `requireRole` stays for owner-only actions.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";
import {
  getCapability,
  overridesFromRows,
  resolveCapabilities,
} from "./capabilities";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}

// ------------------------------------------------------------
// Capabilities (migration 079, see ./capabilities.ts)
// ------------------------------------------------------------

/** Account context plus the caller's effective capability set. */
export interface CapabilityContext extends AccountContext {
  /** Effective capabilities of the caller's role (default + overrides). */
  capabilities: ReadonlySet<string>;
}

/** Postgres / PostgREST codes for "that table does not exist (yet)". */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

// One load per request context: `getCurrentAccount()` builds a fresh
// context object per call, so keying on it memoises per request while
// never leaking one caller's capabilities to another.
const capabilityCache = new WeakMap<AccountContext, Promise<Set<string>>>();

/**
 * Resolve the caller's effective capabilities: the role's default set
 * plus the account's overrides for that role. One query, memoised per
 * context. Fails closed: if the overrides cannot be read the request is
 * refused rather than falling back to defaults (which could grant more
 * than an admin allowed). The one exception is a missing table, meaning
 * migration 079 is not applied, where no override can exist yet and the
 * defaults equal the pre-079 role floors.
 */
export function loadCapabilities(ctx: AccountContext): Promise<Set<string>> {
  let pending = capabilityCache.get(ctx);
  if (!pending) {
    pending = (async () => {
      if (ctx.role === "owner") return resolveCapabilities("owner");
      const { data, error } = await ctx.supabase
        .from("role_capabilities")
        .select("capability, granted")
        .eq("account_id", ctx.accountId)
        .eq("role", ctx.role);
      if (error) {
        if (error.code && MISSING_TABLE_CODES.has(error.code)) {
          return resolveCapabilities(ctx.role);
        }
        console.error("[loadCapabilities] overrides fetch error:", error);
        throw new ForbiddenError("Could not load permissions");
      }
      return resolveCapabilities(ctx.role, overridesFromRows(data));
    })();
    capabilityCache.set(ctx, pending);
    // A rejected load must not poison a later retry on the same ctx.
    pending.catch(() => capabilityCache.delete(ctx));
  }
  return pending;
}

function capabilityDenied(cap: string): ForbiddenError {
  return new ForbiddenError(`This action requires the '${cap}' permission`);
}

/**
 * Resolve the caller's account context and enforce a capability.
 * Returns the same context as `requireRole` plus `capabilities`.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("This action requires the
 * '<capability>' permission")`. An unknown capability key is always
 * denied (deny by default).
 */
export async function requireCapability(cap: string): Promise<CapabilityContext> {
  const ctx = await getCurrentAccount();
  const capabilities = await loadCapabilities(ctx);
  if (!getCapability(cap) || !capabilities.has(cap)) {
    throw capabilityDenied(cap);
  }
  return Object.assign(ctx, { capabilities });
}

/** Like `requireCapability`, but any one of `caps` is enough. */
export async function requireAnyCapability(
  caps: readonly string[],
): Promise<CapabilityContext> {
  const ctx = await getCurrentAccount();
  const capabilities = await loadCapabilities(ctx);
  if (!caps.some((c) => getCapability(c) && capabilities.has(c))) {
    throw capabilityDenied(caps.join("' or '"));
  }
  return Object.assign(ctx, { capabilities });
}

/**
 * Second, action-specific check on a context that already passed
 * `requireCapability` (for example `comments.delete` inside a route
 * gated by `comments.moderate`). Throws `ForbiddenError`.
 */
export function assertCapability(ctx: CapabilityContext, cap: string): void {
  if (!getCapability(cap) || !ctx.capabilities.has(cap)) {
    throw capabilityDenied(cap);
  }
}
