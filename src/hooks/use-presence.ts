"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  getPresence: (userId: string) => PresenceStatus;
  getRow: (userId: string) => PresenceRow | undefined;
  now: number;
}

export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();

  const [rows, setRows] = useState<PresenceMap>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    fetch("/api/account/presence")
      .then((r) => r.json())
      .then(({ presence }: { presence?: { user_id: string; status: StoredPresence; last_seen_at: string }[] }) => {
        if (cancelled) return;
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of presence ?? []) {
            const incoming: PresenceRow = { status: r.status, last_seen_at: r.last_seen_at };
            const existing = next.get(r.user_id);
            if (!existing || new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)) {
              next.set(r.user_id, incoming);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) console.error("[usePresence] initial fetch error:", err);
      });

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [active]);

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
