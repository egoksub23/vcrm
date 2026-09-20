"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  resolveAccountCurrencies,
  type CurrencyOption,
} from "@/lib/currency";
import {
  DEFAULT_STATUS_COLORS,
  withStatusColorDefaults,
  type StatusColors,
} from "@/lib/status-colors";

/** Fallback SLA response target (minutes) — mirrors DEFAULT_CURRENCY's
 *  role: used while loading or when no account is resolved, migration
 *  049's DB default is the same value. */
const DEFAULT_SLA_MINUTES = 30;
import { isAccountRole, type AccountRole } from "@/lib/auth/roles";
import type { CapabilityKey } from "@/lib/auth/capabilities";

/** How often the effective capability set is re-read in the background. */
const CAPABILITIES_REFRESH_MS = 2 * 60 * 1000;
/** Minimum gap between focus-triggered refreshes. */
const CAPABILITIES_FOCUS_THROTTLE_MS = 15 * 1000;

const NO_CAPABILITIES: ReadonlySet<string> = new Set<string>();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
  /** Account-wide SLA response target, in minutes (migration 049).
   *  NOT NULL DEFAULT 30 in the DB; narrowed to DEFAULT_SLA_MINUTES
   *  when absent. */
  sla_response_minutes: number;
  /** Per-account Inbox status/priority colors (migration 057). NOT
   *  NULL DEFAULT in the DB; narrowed through withStatusColorDefaults
   *  in case a row predates a since-added key. */
  status_colors: StatusColors;
  /** Currencies offered in pickers (migration 068). Falls back to the
   *  built-in list when the account hasn't customised it. */
  currencies: CurrencyOption[];
}

/**
 * Whether we managed to establish what this user may do.
 *
 * `unlinked` and `error` are the states worth surfacing: every RLS
 * policy checks `is_account_member(account_id, …)` and every `useCan`
 * gate returns false without a role, so in both the app silently
 * becomes read-only — the whole UI renders, and nothing saves. That is
 * indistinguishable from a bug unless we say so (issue #471).
 */
export type AccountStatus =
  /** Profile row still in flight. */
  | "loading"
  /** Account + role resolved; normal operation. */
  | "ready"
  /** Signed in, but no profile row / no account / no role on it. */
  | "unlinked"
  /** The profile lookup itself failed after retrying. */
  | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /**
   * Outcome of resolving this user's account + role. Anything other
   * than `ready` means writes will be rejected — render
   * `<AccountAccessAlert />` (already mounted in the dashboard shell)
   * rather than letting the user discover it one failed save at a time.
   */
  accountStatus: AccountStatus;
  /** Underlying message when `accountStatus` is 'error' / 'unlinked'. */
  accountStatusDetail: string | null;
  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** Currencies this account offers (deal form, Settings → Deals &
   *  currency). Never empty — falls back to the built-in list. */
  currencies: CurrencyOption[];
  /** Account SLA response target, in minutes. Falls back to
   *  DEFAULT_SLA_MINUTES while loading or when no account is
   *  resolved, so callers can use it unconditionally. */
  slaResponseMinutes: number;
  /** Account's Inbox status/priority colors. Falls back to
   *  DEFAULT_STATUS_COLORS while loading or when no account is
   *  resolved, so callers can use it unconditionally. */
  statusColors: StatusColors;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller may change member roles (`members.change-role`). */
  canManageMembers: boolean;
  /** True if the caller may edit account-wide settings (`settings.workspace`). */
  canEditSettings: boolean;
  /** True if the caller may send messages (`messages.send`). */
  canSendMessages: boolean;

  // ----------------------------------------------------------
  // Capabilities (Roles & permissions)
  // ----------------------------------------------------------

  /**
   * The caller's effective capability set (role default plus the
   * account's overrides), from GET /api/account/capabilities. EMPTY
   * while loading, on a first-load failure, or without a role: every
   * check fails closed. Its identity only changes when the contents do.
   */
  capabilities: ReadonlySet<string>;
  /** True until the first capability load has settled (success or failure). */
  capabilitiesLoading: boolean;
  /** Re-read the capability set now (e.g. after editing the matrix). */
  refreshCapabilities: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Attempts at the profile lookup, including the first. */
const PROFILE_FETCH_ATTEMPTS = 2;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape of the `profiles` select below. */
interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
  account_id: string | null;
  account_role: string | null;
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Why the account/role couldn't be established, when it couldn't.
  // Null on the happy path.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);

  // Effective capabilities. `capabilitiesLoading` flips to false once,
  // when the first load settles, and is NOT raised again by background
  // refreshes or profile refreshes: a re-render loop or a flash of
  // "no access" every two minutes would be worse than a briefly stale
  // set. It is raised again only when a different user signs in.
  const [capabilities, setCapabilities] =
    useState<ReadonlySet<string>>(NO_CAPABILITIES);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const capabilitiesRef = useRef<ReadonlySet<string>>(NO_CAPABILITIES);
  const capabilitiesUserRef = useRef<string | null>(null);
  const capabilitiesSeqRef = useRef(0);
  const capabilitiesLastRunRef = useRef(0);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Reads the caller's effective capabilities. Never throws. A failure
  // keeps the last good set (and only ever fails closed when there has
  // never been a good load, because the set then is still empty). The
  // set is only stored when its contents differ, so consumers do not
  // re-render on every refresh.
  const loadCapabilities = useCallback(async () => {
    const seq = ++capabilitiesSeqRef.current;
    capabilitiesLastRunRef.current = Date.now();
    try {
      const res = await fetch("/api/account/capabilities", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const list =
        body && typeof body === "object"
          ? (body as { capabilities?: unknown }).capabilities
          : null;
      if (!Array.isArray(list)) throw new Error("unexpected response shape");
      if (seq !== capabilitiesSeqRef.current) return;
      const next = new Set<string>(
        list.filter((c): c is string => typeof c === "string"),
      );
      if (!sameSet(capabilitiesRef.current, next)) {
        capabilitiesRef.current = next;
        setCapabilities(next);
      }
    } catch (err) {
      if (seq !== capabilitiesSeqRef.current) return;
      console.error("[AuthProvider] loadCapabilities failed:", err);
    } finally {
      if (seq === capabilitiesSeqRef.current) setCapabilitiesLoading(false);
    }
  }, []);

  // Drop the capability set (sign-out, a different user, or no role):
  // everything fails closed again.
  const resetCapabilities = useCallback((settled: boolean) => {
    capabilitiesSeqRef.current++;
    capabilitiesRef.current = NO_CAPABILITIES;
    setCapabilities(NO_CAPABILITIES);
    setCapabilitiesLoading(!settled);
  }, []);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserIdRef.current = userId;
    // A different person than the one the capability set belongs to:
    // start from empty (fail closed) and show the loading state again.
    // The same person re-fetching their profile keeps the current set.
    if (capabilitiesUserRef.current !== userId) {
      capabilitiesUserRef.current = userId;
      resetCapabilities(false);
    }
    let capabilitiesStarted = false;
    try {
      let data: ProfileRow | null = null;
      for (let attempt = 1; ; attempt++) {
        const result = await supabase
          .from("profiles")
          .select(
            "id, full_name, email, avatar_url, role, beta_features, account_id, account_role",
          )
          .eq("user_id", userId)
          .maybeSingle();

        if (!result.error) {
          data = result.data;
          break;
        }

        const error = result.error;
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        // One hiccup here used to lock the session read-only for good:
        // the profile stayed null, so every `useCan` gate answered
        // false and no page offered a way to recover (issue #471).
        // Retry, then hand the reason to the UI.
        if (attempt < PROFILE_FETCH_ATTEMPTS) {
          await sleep(PROFILE_FETCH_RETRY_MS);
          continue;
        }
        lastFetchedUserIdRef.current = null;
        setStatusDetail(error.message);
        return;
      }

      if (data) {
        // Load the account with a plain lookup by id instead of an
        // embedded FK join. The embed (`account:accounts!inner(...)`)
        // forces PostgREST to resolve the profiles.account_id →
        // accounts.id relationship from its schema cache; a stale cache
        // (common right after a migration adds the FK) makes it fail
        // hard with PGRST200 and blanks the whole profile — the user
        // then loses account context everywhere (issue #294). A point
        // lookup by id needs no relationship inference, so the profile
        // (with account_id / account_role) still resolves even if the
        // account name lookup itself can't.
        let accountRow: AccountSummary | null = null;
        if (data.account_id) {
          const { data: account, error: accountErr } = await supabase
            .from("accounts")
            // default_currency added in migration 021, sla_response_minutes
            // in migration 049, status_colors in migration 057; all
            // narrowed to a fallback below for older schemas where
            // they read null.
            .select("id, name, default_currency, sla_response_minutes, status_colors")
            .eq("id", data.account_id)
            .maybeSingle();
          if (accountErr) {
            console.error("[AuthProvider] fetchAccount error:", {
              message: accountErr.message,
              details: accountErr.details,
              hint: accountErr.hint,
              code: accountErr.code,
            });
          } else if (account) {
            // Read separately: `currencies` arrived in migration 068, and a
            // select naming a missing column would fail the whole account
            // lookup above. An error here just means "built-in list".
            const { data: currencyRow } = await supabase
              .from("accounts")
              .select("currencies")
              .eq("id", data.account_id)
              .maybeSingle();
            accountRow = {
              id: account.id,
              name: account.name,
              currencies: resolveAccountCurrencies(currencyRow?.currencies),
              default_currency: account.default_currency ?? DEFAULT_CURRENCY,
              sla_response_minutes: account.sla_response_minutes ?? DEFAULT_SLA_MINUTES,
              status_colors: withStatusColorDefaults(account.status_colors),
            };
          }
        }

        // Narrow the DB enum into our AccountRole union. The DB
        // constraint should make this unconditional, but a future
        // migration that broadens the enum without updating TS would
        // otherwise crash here — fall back to null and let UI gates
        // treat the caller as least-privileged.
        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        });
        setAccount(accountRow);
        if (!data.account_id || !accountRole) {
          // The row exists but carries no tenancy. Migration 017 made
          // both columns NOT NULL for new signups, so this is a user
          // whose bootstrap didn't complete (handle_new_user swallows a
          // failure as a WARNING) or one predating that migration.
          // Every insert and update they attempt will be denied by RLS.
          setStatusDetail(
            `profile ${data.id} has no ${!data.account_id ? "account_id" : "account_role"}`,
          );
        }
        if (accountRole) {
          // Once per profile fetch; not awaited so it never delays the
          // profile. `capabilitiesLoading` stays true until it settles.
          capabilitiesStarted = true;
          void loadCapabilities();
        } else {
          // No role means no capabilities, whatever the server might say.
          resetCapabilities(true);
          capabilitiesStarted = true;
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setStatusDetail("no profiles row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
      setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
    } finally {
      // The profile could not be resolved, so no capability request was
      // made. Settle the loading flag; the set stays whatever it was
      // (empty unless an earlier load succeeded).
      if (!capabilitiesStarted) setCapabilitiesLoading(false);
      setProfileLoading(false);
    }
  }, [loadCapabilities, resetCapabilities]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
        setCapabilitiesLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
          capabilitiesUserRef.current = null;
          resetCapabilities(true);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        capabilitiesUserRef.current = null;
        resetCapabilities(true);
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile, resetCapabilities]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    capabilitiesUserRef.current = null;
    resetCapabilities(true);
    window.location.href = "/login";
  }, [resetCapabilities]);

  const refreshCapabilities = useCallback(async () => {
    if (!capabilitiesUserRef.current) return;
    await loadCapabilities();
  }, [loadCapabilities]);

  // Keep the set fresh without a reload: when the tab regains focus
  // (throttled) and every couple of minutes. Background reads never
  // raise a loading flag and never re-render when nothing changed.
  const roleForRefresh = profile?.account_role ?? null;
  useEffect(() => {
    if (!roleForRefresh) return;
    const run = (throttled: boolean) => {
      if (document.visibilityState === "hidden") return;
      if (
        throttled &&
        Date.now() - capabilitiesLastRunRef.current <
          CAPABILITIES_FOCUS_THROTTLE_MS
      ) {
        return;
      }
      void loadCapabilities();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") run(true);
    };
    const onFocus = () => run(true);
    const timer = setInterval(() => run(false), CAPABILITIES_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [roleForRefresh, loadCapabilities]);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      // Derived from the capability set (empty while loading / without
      // a role), so a switch in Roles & permissions moves these too.
      canManageMembers: role ? capabilities.has("members.change-role") : false,
      canEditSettings: role ? capabilities.has("settings.workspace") : false,
      canSendMessages: role ? capabilities.has("messages.send") : false,
    };
  }, [profile?.account_role, profile?.account_id, capabilities]);

  // Signed out is not a broken account — the shell redirects to /login
  // before anything reads this.
  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading
      ? "loading"
      : !profile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        currencies: account?.currencies ?? CURRENCIES,
        slaResponseMinutes: account?.sla_response_minutes ?? DEFAULT_SLA_MINUTES,
        statusColors: account?.status_colors ?? DEFAULT_STATUS_COLORS,
        accountStatus,
        accountStatusDetail: statusDetail,
        capabilities,
        capabilitiesLoading,
        refreshCapabilities,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      currencies: CURRENCIES,
      slaResponseMinutes: DEFAULT_SLA_MINUTES,
      statusColors: DEFAULT_STATUS_COLORS,
      // Outside the provider there is nothing to resolve yet — 'loading'
      // keeps the access alert from firing on, say, the login page.
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
      capabilities: NO_CAPABILITIES,
      capabilitiesLoading: false,
      refreshCapabilities: async () => {},
    };
  }
  return ctx;
}

/**
 * useCapability: does the caller hold `cap` right now?
 *
 * Fails closed: false while capabilities load, when the load never
 * succeeded, without a role, and outside an AuthProvider. Unknown
 * keys are simply not in the set, so they are false too.
 */
export function useCapability(cap: CapabilityKey | (string & {})): boolean {
  const { capabilities, capabilitiesLoading, accountRole } = useAuth();
  if (capabilitiesLoading || !accountRole) return false;
  return capabilities.has(cap);
}
