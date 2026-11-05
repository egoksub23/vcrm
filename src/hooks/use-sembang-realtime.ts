"use client";

// Realtime for Sembang — modeled on `useRealtime` (@/hooks/use-realtime.ts):
// ref-stashed callbacks so subscribers don't need to memoize, one
// `.channel()` per hook instance, cleanup on unmount. Two small hooks
// rather than one parametrized one, matching how the two call sites
// actually differ:
//
//  - `useSembangChannelRealtime` — ONE open channel's message list,
//    filtered `channel_id=eq.<id>` so a busy account's other channels
//    don't generate noise in the open thread.
//  - `useSembangSidebarRealtime` — account-wide (unfiltered; RLS already
//    scopes what the caller actually receives) across all three tables,
//    for the channel-list sidebar to reorder/update live.

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

export interface SembangMessageRow {
  id: string;
  channel_id: string;
  account_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  // Migration 099 columns.
  parent_message_id?: string | null;
  edited_at?: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
}

/** Migration 099. No `channel_id` column on this table — a reaction row
 *  only carries `message_id`, so this event can't be filtered server-side
 *  to one open channel/thread; callers check `message_id` against their
 *  own locally-loaded messages before acting on it. */
export interface SembangReactionRow {
  message_id: string;
  account_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
}

/** Migration 107. Like `SembangReactionRow` — no `channel_id` column, so
 *  this event can't be filtered server-side either; callers check
 *  `message_id` against their own locally-loaded messages. Always an
 *  INSERT in practice (the server never updates/deletes a preview row). */
export interface SembangLinkPreviewRow {
  message_id: string;
  account_id: string;
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  domain: string | null;
}

/** Migration 099. */
export interface SembangPinRow {
  channel_id: string;
  message_id: string;
  account_id: string;
  pinned_by: string;
  pinned_at: string;
}

/** Migration 099, widened by 121 (status gains 'in_progress', assignee_id
 *  replaced by the separate sembang_task_assignees table, description
 *  added) — channel-thread.tsx only uses this to type the realtime
 *  payload shape and always just triggers a refetch, so it doesn't read
 *  assignee/description fields off it either way. */
export interface SembangTaskRow {
  id: string;
  channel_id: string;
  account_id: string;
  message_id: string | null;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done";
  due_at: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

export interface SembangChannelRow {
  id: string;
  account_id: string;
  name: string;
  topic: string | null;
  is_private: boolean;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export interface SembangChannelMemberRow {
  channel_id: string;
  account_id: string;
  user_id: string;
  role: "member" | "moderator";
  joined_at: string;
  last_read_at: string;
}

interface UseSembangChannelRealtimeOptions {
  /** null/undefined disables the subscription (no thread open yet). */
  channelId: string | null | undefined;
  onMessageEvent?: (event: RealtimeEvent<SembangMessageRow>) => void;
  /** Migration 099. Unfiltered (see `SembangReactionRow`'s doc comment) —
   *  fires for every reaction change the caller's RLS lets them see, not
   *  just this channel's. */
  onReactionEvent?: (event: RealtimeEvent<SembangReactionRow>) => void;
  /** Migration 099. Filtered to this channel. */
  onPinEvent?: (event: RealtimeEvent<SembangPinRow>) => void;
  /** Migration 099. Filtered to this channel. */
  onTaskEvent?: (event: RealtimeEvent<SembangTaskRow>) => void;
  /** Migration 107. Unfiltered (see `SembangLinkPreviewRow`'s doc comment). */
  onLinkPreviewEvent?: (event: RealtimeEvent<SembangLinkPreviewRow>) => void;
  enabled?: boolean;
  /** Distinguishes a second subscription to the same channel's messages
   *  (e.g. thread-panel.tsx alongside channel-thread.tsx) so both can be
   *  open at once without fighting over one realtime channel name. */
  topicSuffix?: string;
}

/** Realtime for the open channel's message list (plus, since migration 099,
 *  its reactions/pins/tasks) — one hook, several SSE table subscriptions. */
export function useSembangChannelRealtime({
  channelId,
  onMessageEvent,
  onReactionEvent,
  onPinEvent,
  onTaskEvent,
  onLinkPreviewEvent,
  enabled = true,
}: UseSembangChannelRealtimeOptions): { isConnected: boolean } {
  const onMessageRef = useRef(onMessageEvent);
  const onReactionRef = useRef(onReactionEvent);
  const onPinRef = useRef(onPinEvent);
  const onTaskRef = useRef(onTaskEvent);
  const onLinkPreviewRef = useRef(onLinkPreviewEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onReactionRef.current = onReactionEvent;
    onPinRef.current = onPinEvent;
    onTaskRef.current = onTaskEvent;
    onLinkPreviewRef.current = onLinkPreviewEvent;
  });

  const active = enabled && !!channelId;

  useAccountSse(
    "sembang_messages",
    active
      ? (payload: SsePayload) => {
          const cid = (payload.new as { channel_id?: string }).channel_id ?? (payload.old as { channel_id?: string }).channel_id;
          if (cid !== channelId) return;
          onMessageRef.current?.({ eventType: payload.eventType, new: payload.new as SembangMessageRow, old: payload.old as Partial<SembangMessageRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_reactions",
    active
      ? (payload: SsePayload) => {
          onReactionRef.current?.({ eventType: payload.eventType, new: payload.new as SembangReactionRow, old: payload.old as Partial<SembangReactionRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_pins",
    active
      ? (payload: SsePayload) => {
          const cid = (payload.new as { channel_id?: string }).channel_id ?? (payload.old as { channel_id?: string }).channel_id;
          if (cid !== channelId) return;
          onPinRef.current?.({ eventType: payload.eventType, new: payload.new as SembangPinRow, old: payload.old as Partial<SembangPinRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_tasks",
    active
      ? (payload: SsePayload) => {
          const cid = (payload.new as { channel_id?: string }).channel_id ?? (payload.old as { channel_id?: string }).channel_id;
          if (cid !== channelId) return;
          onTaskRef.current?.({ eventType: payload.eventType, new: payload.new as SembangTaskRow, old: payload.old as Partial<SembangTaskRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_link_previews",
    active
      ? (payload: SsePayload) => {
          onLinkPreviewRef.current?.({ eventType: payload.eventType, new: payload.new as SembangLinkPreviewRow, old: payload.old as Partial<SembangLinkPreviewRow> });
        }
      : undefined,
    active,
  );

  return { isConnected: active };
}

interface UseSembangSidebarRealtimeOptions {
  onChannelEvent?: (event: RealtimeEvent<SembangChannelRow>) => void;
  onMemberEvent?: (event: RealtimeEvent<SembangChannelMemberRow>) => void;
  /** Unfiltered messages across every channel the caller can see — used
   *  only to know "something changed, re-sort/refetch", not to render
   *  message bodies (the open thread has its own filtered subscription
   *  for that). */
  onMessageEvent?: (event: RealtimeEvent<SembangMessageRow>) => void;
  enabled?: boolean;
}

/** Account-wide realtime for the channel-list sidebar. */
export function useSembangSidebarRealtime({
  onChannelEvent,
  onMemberEvent,
  onMessageEvent,
  enabled = true,
}: UseSembangSidebarRealtimeOptions): { isConnected: boolean } {
  const { accountId } = useAuth();

  const onChannelRef = useRef(onChannelEvent);
  const onMemberRef = useRef(onMemberEvent);
  const onMessageRef = useRef(onMessageEvent);
  useEffect(() => {
    onChannelRef.current = onChannelEvent;
    onMemberRef.current = onMemberEvent;
    onMessageRef.current = onMessageEvent;
  });

  const active = enabled && !!accountId;

  useAccountSse(
    "sembang_channels",
    active
      ? (payload: SsePayload) => {
          onChannelRef.current?.({ eventType: payload.eventType, new: payload.new as SembangChannelRow, old: payload.old as Partial<SembangChannelRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_channel_members",
    active
      ? (payload: SsePayload) => {
          onMemberRef.current?.({ eventType: payload.eventType, new: payload.new as SembangChannelMemberRow, old: payload.old as Partial<SembangChannelMemberRow> });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "sembang_messages",
    active
      ? (payload: SsePayload) => {
          onMessageRef.current?.({ eventType: payload.eventType, new: payload.new as SembangMessageRow, old: payload.old as Partial<SembangMessageRow> });
        }
      : undefined,
    active,
  );

  return { isConnected: active };
}
