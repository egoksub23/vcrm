"use client";

import { useEffect, useState } from "react";

import { mailInboxOffChannels } from "@/lib/inbox/mail-inbox";
import { createClient } from "@/lib/supabase/client";
import type { ChannelType } from "@/types";

// ============================================================
// Which email channels the Inbox must not offer (migration 179): a connected mailbox switched off as the customer care inbox. Every member can read the
// two mailbox rows (RLS), and only the switch columns are selected here, never a token. One cached read shared by everything on screen;
// `invalidateMailInbox()` (after the switch in Settings > Channels is changed) refreshes it. Until the first read answers nothing is switched off, so
// the Inbox behaves as before; the server refuses the send anyway.
// ============================================================

export interface MailInboxState {
  /** The email channels (`email`, `gmail`) the Inbox does not offer. */
  offChannels: ChannelType[];
  /** The first read has answered. */
  loaded: boolean;
}

const TTL_MS = 60_000;
const NONE: ChannelType[] = [];
let cache: { at: number; off: ChannelType[] } | null = null;
let inflight: Promise<ChannelType[]> | null = null;
const listeners = new Set<() => void>();

export function invalidateMailInbox(): void {
  cache = null;
  inflight = null;
  for (const l of listeners) l();
}

async function fetchOffChannels(): Promise<ChannelType[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.off;
  if (inflight) return inflight;
  const supabase = createClient();
  const load = (async () => {
    const [email, gmail] = await Promise.all([
      supabase.from("email_config").select("inbox_enabled").maybeSingle(),
      supabase.from("gmail_config").select("inbox_enabled").maybeSingle(),
    ]);
    // a failed read is "nothing switched off": the Inbox behaves as before and the server still refuses
    const off = mailInboxOffChannels({
      email_config: email.error ? null : (email.data as { inbox_enabled?: boolean | null } | null),
      gmail_config: gmail.error ? null : (gmail.data as { inbox_enabled?: boolean | null } | null),
    });
    cache = { at: Date.now(), off };
    return off;
  })();
  inflight = load;
  try {
    return await load;
  } finally {
    if (inflight === load) inflight = null;
  }
}

export function useMailInbox(): MailInboxState {
  const [state, setState] = useState<MailInboxState>({ offChannels: cache?.off ?? NONE, loaded: cache !== null });

  useEffect(() => {
    let live = true;
    const run = () => {
      fetchOffChannels()
        .then((off) => {
          if (live) setState((prev) => (prev.loaded && prev.offChannels.join() === off.join() ? prev : { offChannels: off, loaded: true }));
        })
        .catch(() => {
          if (live) setState((prev) => (prev.loaded ? prev : { offChannels: NONE, loaded: true }));
        });
    };
    run();
    listeners.add(run);
    return () => {
      live = false;
      listeners.delete(run);
    };
  }, []);

  return state;
}
