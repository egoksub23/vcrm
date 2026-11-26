"use client";

import { useEffect, useState } from "react";

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
  /** Hide the Emails tab: no email channel is connected and inbox-enabled. */
  hideEmailTab: boolean;
  /** The first read has answered. */
  loaded: boolean;
}

interface MailInboxData {
  off: ChannelType[];
  hideEmailTab: boolean;
}

const TTL_MS = 60_000;
const NONE: ChannelType[] = [];
let cache: { at: number; data: MailInboxData } | null = null;
let inflight: Promise<MailInboxData> | null = null;
const listeners = new Set<() => void>();

export function invalidateMailInbox(): void {
  cache = null;
  inflight = null;
  for (const l of listeners) l();
}

async function fetchMailInboxData(): Promise<MailInboxData> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  const load = (async () => {
    const res = await fetch("/api/account/mail-inbox").catch(() => null);
    const json = res?.ok ? (await res.json().catch(() => null)) : null;
    const off = (Array.isArray(json?.offChannels) ? json.offChannels : []) as ChannelType[];
    const data: MailInboxData = { off, hideEmailTab: json?.hideEmailTab === true };
    cache = { at: Date.now(), data };
    return data;
  })();
  inflight = load;
  try {
    return await load;
  } finally {
    if (inflight === load) inflight = null;
  }
}

export function useMailInbox(): MailInboxState {
  const [state, setState] = useState<MailInboxState>({
    offChannels: cache?.data.off ?? NONE,
    hideEmailTab: cache?.data.hideEmailTab ?? false,
    loaded: cache !== null,
  });

  useEffect(() => {
    let live = true;
    const run = () => {
      fetchMailInboxData()
        .then((data) => {
          if (live)
            setState((prev) =>
              prev.loaded && prev.offChannels.join() === data.off.join() && prev.hideEmailTab === data.hideEmailTab
                ? prev
                : { offChannels: data.off, hideEmailTab: data.hideEmailTab, loaded: true },
            );
        })
        .catch(() => {
          if (live) setState((prev) => (prev.loaded ? prev : { offChannels: NONE, hideEmailTab: false, loaded: true }));
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
