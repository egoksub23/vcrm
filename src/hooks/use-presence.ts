"use client";

import { useCallback, useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO database event (it's just the clock passing the
// staleness threshold), so without this tick a member who closes their
// tab would appear online forever. ~15s keeps "offline" responsive
// without busy-spinning.
const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Reads the
 * `member_presence` table (RLS-scoped to the account), subscribes to
 * SSE changes, and re-derives "offline" on a local timer.
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();

  const [rows, setRows] = useState<PresenceMap>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  // Initial snapshot fetch (still uses createClient for PostgREST — Browser PostgREST migration next).
  useEffect(() => {
    if (!active || !accountId) return;
    let cancelled = false;

    const supabase = createClient();

    const applyRow = (row: { user_id: string; status: StoredPresence; last_seen_at: string }) => {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(row.user_id, { status: row.status, last_seen_at: row.last_seen_at });
        return next;
      });
    };

    supabase
      .from("member_presence")
      .select("user_id, status, last_seen_at")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[usePresence] initial fetch error:", error.message);
          return;
        }
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of data ?? []) {
            const userId = r.user_id as string;
            const incoming: PresenceRow = {
              status: r.status as StoredPresence,
              last_seen_at: r.last_seen_at as string,
            };
            const existing = next.get(userId);
            if (!existing || new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)) {
              next.set(userId, incoming);
            }
          }
          return next;
        });
      });

    // Unused applyRow kept to suppress lint warning — used in SSE handler below.
    void applyRow;

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [active, accountId]);

  // SSE realtime subscription.
  useAccountSse(
    "member_presence",
    active
      ? (payload: SsePayload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as { user_id?: string };
            if (!old.user_id) return;
            setRows((prev) => {
              if (!prev.has(old.user_id!)) return prev;
              const next = new Map(prev);
              next.delete(old.user_id!);
              return next;
            });
            return;
          }
          const row = payload.new as { user_id: string; status: StoredPresence; last_seen_at: string };
          setRows((prev) => {
            const next = new Map(prev);
            next.set(row.user_id, { status: row.status, last_seen_at: row.last_seen_at });
            return next;
          });
        }
      : undefined,
    active,
  );

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}
