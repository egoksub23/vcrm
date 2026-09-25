"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckSquare,
  Hash,
  Loader2,
  Lock,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Search as SearchIcon,
  Users,
  Video,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { useAuth } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import { hasMinRole } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { useSembangChannelRealtime } from "@/hooks/use-sembang-realtime";
import { MessageComposer, type PendingSembangAttachment } from "./message-composer";
import { MembersPanel } from "./members-panel";
import { MessageRow } from "./message-row";
import { ThreadPanel } from "./thread-panel";
import { PinsPanel } from "./pins-panel";
import { TasksPanel } from "./tasks-panel";
import { ChannelResourcesPanel } from "./channel-resources-panel";
import {
  addMessageToTask,
  editMessage,
  reactToMessage,
  removeMessage,
  toggleMessagePin,
  toggleMessageStar,
} from "@/lib/sembang/message-actions";
import type {
  SembangChannel,
  SembangMember,
  SembangMessage,
  SembangPin,
  SembangReactionSummary,
  SembangTask,
  SembangTaskStatus,
} from "@/types";

const MESSAGES_PAGE_SIZE = 50;
const MEETING_URL = "https://meet.google.com/new";
const SEARCH_DEBOUNCE_MS = 300;

/** Bolds the first case-insensitive match of `query` inside `text` — used
 *  for the search popover's result snippets (server does no ranking or
 *  highlighting, per SPEC-P1.md's frontend item 8). */
function boldMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <strong className="font-semibold text-foreground">{text.slice(idx, idx + q.length)}</strong>
      {text.slice(idx + q.length)}
    </>
  );
}

interface ChannelThreadProps {
  channelId: string | null;
  /** Mobile back button — deselects the active channel. `lg:hidden`,
   *  exactly like message-thread.tsx's `onBack`. */
  onBack?: () => void;
  /** Fired once the channel is marked read server-side, so the page can
   *  optimistically zero the sidebar's unread badge. */
  onChannelRead?: (channelId: string) => void;
  /** Migration 100. Fired once "Archive channel" succeeds — the page
   *  drops the channel from the sidebar list and clears the selection
   *  (same shape as an existing "channel no longer accessible" path). */
  onChannelArchived?: (channelId: string) => void;
}

export function ChannelThread({ channelId, onBack, onChannelRead, onChannelArchived }: ChannelThreadProps) {
  const t = useTranslations("Sembang.thread");
  const tTasksPanel = useTranslations("Sembang.tasksPanel");
  const { user, accountRole } = useAuth();
  const { members: accountMembers } = useAccountMembers();

  const [channel, setChannel] = useState<SembangChannel | null>(null);
  const [channelError, setChannelError] = useState(false);
  const [messages, setMessages] = useState<SembangMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [members, setMembers] = useState<SembangMember[] | null>(null);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [joining, setJoining] = useState(false);

  // ---- P1: pins / tasks / thread / search / topic editing --------------
  const [pins, setPins] = useState<SembangPin[] | null>(null);
  const [pinsPanelOpen, setPinsPanelOpen] = useState(false);
  const [unpinningId, setUnpinningId] = useState<string | null>(null);

  const [tasks, setTasks] = useState<SembangTask[] | null>(null);
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  // ---- P4: Files/Links/Bookmarks — self-fetched inside the panel, this
  // component only owns whether it's open. -------------------------------
  const [resourcesPanelOpen, setResourcesPanelOpen] = useState(false);

  // Only `.id` is ever read from the open thread's parent (ThreadPanel
  // fetches the full parent + replies itself from `parentMessageId`), so
  // this holds just the id rather than a full `SembangMessage` — which
  // lets the "↪ replied to a thread" context line (migration 101) open a
  // thread it only has a `parentPreview.id` for, without needing a full
  // message object to satisfy the state's type.
  const [threadParentId, setThreadParentId] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SembangMessage[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [savingTopic, setSavingTopic] = useState(false);

  // ---- P2: DM header label / archive channel ----------------------------
  const [archiving, setArchiving] = useState(false);

  // ---- P3: mute toggle ----------------------------------------------------
  const [muting, setMuting] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const suppressAutoScrollRef = useRef(false);

  // ---- Channel detail --------------------------------------------------
  useEffect(() => {
    if (!channelId) {
      setChannel(null);
      return;
    }
    let cancelled = false;
    setChannelError(false);
    (async () => {
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setChannel(null);
          setChannelError(true);
          return;
        }
        setChannel(data.channel as SembangChannel);
      } catch {
        if (!cancelled) {
          setChannel(null);
          setChannelError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    setEditingTopic(false);
    setThreadParentId(null);
    setSearchOpen(false);
  }, [channelId]);

  // ---- Members -----------------------------------------------------------
  const fetchMembers = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/members`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMembers((data.members as SembangMember[]) ?? []);
    } catch {
      // Best-effort — the members button/panel just stays at its last value.
    }
  }, [channelId]);

  useEffect(() => {
    setMembers(null);
    void fetchMembers();
  }, [fetchMembers]);

  // ---- Pins / tasks --------------------------------------------------------
  const fetchPins = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/pins`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setPins((data.pins as SembangPin[]) ?? []);
    } catch {
      // Best-effort — the Pinned button/panel just stays at its last value.
    }
  }, [channelId]);

  const fetchTasks = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/tasks`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setTasks((data.tasks as SembangTask[]) ?? []);
    } catch {
      // Best-effort — the Tasks button/panel just stays at its last value.
    }
  }, [channelId]);

  useEffect(() => {
    setPins(null);
    setTasks(null);
    void fetchPins();
    void fetchTasks();
  }, [fetchPins, fetchTasks]);

  const pinnedMessageIds = useMemo(() => new Set((pins ?? []).map((p) => p.messageId)), [pins]);

  // ---- Messages -----------------------------------------------------------
  const fetchMessages = useCallback(
    async (before?: string): Promise<SembangMessage[]> => {
      if (!channelId) return [];
      const params = new URLSearchParams({ limit: String(MESSAGES_PAGE_SIZE) });
      if (before) params.set("before", before);
      const res = await fetch(`/api/sembang/channels/${channelId}/messages?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return (data.messages as SembangMessage[]) ?? [];
    },
    [channelId],
  );

  const mergeMessages = useCallback((incoming: SembangMessage[]) => {
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      return Array.from(map.values()).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    });
  }, []);

  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      setHasMoreEarlier(false);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(false);
    fetchMessages()
      .then((fresh) => {
        if (cancelled) return;
        setMessages(fresh);
        setHasMoreEarlier(fresh.length >= MESSAGES_PAGE_SIZE);
      })
      .catch(() => {
        if (!cancelled) setMessagesError(true);
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, fetchMessages]);

  const handleLoadEarlier = useCallback(async () => {
    if (!channelId || messages.length === 0 || loadingEarlier) return;
    setLoadingEarlier(true);
    suppressAutoScrollRef.current = true;
    try {
      const older = await fetchMessages(messages[0].createdAt);
      mergeMessages(older);
      setHasMoreEarlier(older.length >= MESSAGES_PAGE_SIZE);
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoadingEarlier(false);
    }
  }, [channelId, messages, loadingEarlier, fetchMessages, mergeMessages, t]);

  // Auto-scroll to bottom on new messages — suppressed right after
  // "load earlier" prepends older ones (that shouldn't yank the view).
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---- Realtime: messages (+ replies), reactions, pins, tasks ------------
  useSembangChannelRealtime({
    channelId,
    onMessageEvent: (event) => {
      if (event.eventType === "INSERT") {
        const row = event.new;
        if (row.parent_message_id) {
          // A reply to a top-level message — replies never show inline
          // (see the backend's `.is('parent_message_id', null)` filter),
          // so just keep the "N replies" affordance live. Our own reply is
          // bumped by `handleReplyPosted` instead, mirroring the existing
          // "skip self-authored inserts" convention below (the realtime
          // payload has no author/reactions join to render with either way).
          if (row.author_id === user?.id) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === row.parent_message_id
                ? { ...m, replyCount: (m.replyCount ?? 0) + 1, lastReplyAt: row.created_at }
                : m,
            ),
          );
          return;
        }
        // Our own sends are appended straight from the POST response;
        // only refetch for messages that arrived from someone else (the
        // realtime payload has no author/attachments join to render with).
        if (row.author_id === user?.id) return;
        void fetchMessages()
          .then(mergeMessages)
          .catch(() => {});
      } else if (event.eventType === "UPDATE") {
        const row = event.new;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === row.id
              ? {
                  ...m,
                  body: row.body,
                  editedAt: row.edited_at ?? m.editedAt,
                  deletedAt: row.deleted_at,
                  deletedBy: row.deleted_by,
                }
              : m,
          ),
        );
      }
    },
    onReactionEvent: (event) => {
      const row = event.eventType === "DELETE" ? event.old : event.new;
      const messageId = row?.message_id;
      const actorId = row?.user_id;
      if (!messageId || actorId === user?.id) return; // our own toggle already patched local state
      if (messages.some((m) => m.id === messageId)) {
        void fetchMessages()
          .then(mergeMessages)
          .catch(() => {});
      }
    },
    onPinEvent: () => {
      void fetchPins();
    },
    onTaskEvent: () => {
      void fetchTasks();
    },
  });

  // ---- Mark read: on open, and whenever the message list grows while
  // the thread stays open. Skipped for a public channel the caller can
  // see but hasn't joined — there's no membership row to mark read yet. --
  const onChannelReadRef = useRef(onChannelRead);
  useEffect(() => {
    onChannelReadRef.current = onChannelRead;
  });
  useEffect(() => {
    if (!channelId || !channel || !channel.memberRole) return;
    fetch(`/api/sembang/channels/${channelId}/read`, { method: "POST" }).catch(() => {});
    onChannelReadRef.current?.(channelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, channel?.memberRole, messages.length]);

  // ---- Join (public channel, not yet a member) --------------------------
  const handleJoin = useCallback(async () => {
    if (!channelId || !user?.id || joining) return;
    setJoining(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [user.id] }),
      });
      // The route can return 200 OR 207 (partial) — both are `res.ok`
      // (207 is a 2xx status), so success must be read from `added`,
      // not the HTTP status alone.
      const data = (await res.json().catch(() => ({}))) as {
        added?: string[];
        failed?: { userId: string; error: string }[];
        error?: string;
      };
      if (!res.ok || !data.added?.includes(user.id)) {
        toast.error(data.failed?.[0]?.error || data.error || t("joinFailed"));
        return;
      }
      setChannel((prev) => (prev ? { ...prev, memberRole: "member" } : prev));
      void fetchMembers();
    } catch {
      toast.error(t("joinFailed"));
    } finally {
      setJoining(false);
    }
  }, [channelId, user?.id, joining, t, fetchMembers]);

  // ---- Send / edit / remove message ---------------------------------------
  const handleSendMessage = useCallback(
    async (
      body: string,
      mentions: string[],
      attachments: PendingSembangAttachment[],
      parentMessageId?: string,
      alsoInChannel?: boolean,
    ): Promise<boolean> => {
      if (!channelId) return false;
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body,
            mentions,
            attachments: attachments.length > 0 ? attachments : undefined,
            parentMessageId,
            alsoInChannel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error || t("sendFailed"));
          return false;
        }
        const message = data.message as SembangMessage | undefined;
        if (message) {
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        } else {
          void fetchMessages().then(mergeMessages).catch(() => {});
        }
        return true;
      } catch {
        toast.error(t("sendFailed"));
        return false;
      }
    },
    [channelId, t, fetchMessages, mergeMessages],
  );

  /** action: 'edit' — author-only, PATCH .../messages/[id]. Resolves to the
   *  updated message on success so callers (this list, and thread-panel.tsx
   *  for the same message shown in an open thread) can patch local state. */
  const handleEditMessage = useCallback(
    async (messageId: string, body: string): Promise<SembangMessage | null> => {
      if (!channelId) return null;
      const result = await editMessage(channelId, messageId, body);
      if (!result.ok) {
        toast.error(result.error || t("editFailed"));
        return null;
      }
      setMessages((prev) => prev.map((m) => (m.id === messageId ? result.message : m)));
      return result.message;
    },
    [channelId, t],
  );

  /** action: 'remove' — soft-delete. Works for either the author deleting
   *  their own message or a moderator/admin removing someone else's; RLS
   *  (migration 099) sorts out which policy applied, this just attempts the
   *  PATCH and surfaces a 403 if neither matched. */
  const handleRemoveMessage = useCallback(
    async (messageId: string): Promise<SembangMessage | null> => {
      if (!channelId) return null;
      const result = await removeMessage(channelId, messageId);
      if (!result.ok) {
        toast.error(result.error || t("removeMessageFailed"));
        return null;
      }
      if (result.message) {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? result.message! : m)));
        return result.message;
      }
      // Fallback for a route that doesn't echo the message back.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), deletedBy: user?.id ?? null } : m,
        ),
      );
      return null;
    },
    [channelId, t, user?.id],
  );

  // ---- Reactions -----------------------------------------------------------
  const handleReact = useCallback(
    async (messageId: string, emoji: string): Promise<SembangReactionSummary[] | null> => {
      if (!channelId) return null;
      const result = await reactToMessage(channelId, messageId, emoji);
      if (!result.ok) {
        toast.error(result.error || t("reactFailed"));
        return null;
      }
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: result.reactions } : m)));
      return result.reactions;
    },
    [channelId, t],
  );

  // ---- Pins -----------------------------------------------------------
  const handleTogglePin = useCallback(
    async (message: SembangMessage, pinned: boolean) => {
      if (!channelId) return;
      const result = await toggleMessagePin(channelId, message.id, pinned);
      if (!result.ok) {
        toast.error(result.error || (pinned ? t("unpinFailed") : t("pinFailed")));
        return;
      }
      void fetchPins();
    },
    [channelId, t, fetchPins],
  );

  const handleUnpinFromPanel = useCallback(
    async (messageId: string) => {
      if (!channelId || unpinningId) return;
      setUnpinningId(messageId);
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/messages/${messageId}/pin`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(data?.error || t("unpinFailed"));
          return;
        }
        setPins((prev) => (prev ?? []).filter((p) => p.messageId !== messageId));
      } catch {
        toast.error(t("unpinFailed"));
      } finally {
        setUnpinningId(null);
      }
    },
    [channelId, unpinningId, t],
  );

  // ---- Tasks -----------------------------------------------------------
  const handleAddToTask = useCallback(
    async (message: SembangMessage) => {
      if (!channelId) return;
      const result = await addMessageToTask(channelId, message);
      if (!result.ok) {
        toast.error(result.error || t("addToTasksFailed"));
        return;
      }
      if (result.task) setTasks((prev) => [...(prev ?? []), result.task!]);
      setTasksPanelOpen(true);
      toast.success(t("addedToTasks"));
    },
    [channelId, t],
  );

  const handleCreateTask = useCallback(
    async (title: string) => {
      if (!channelId) return;
      setCreatingTask(true);
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data?.error || tTasksPanel("createFailed"));
          return;
        }
        const task = data.task as SembangTask | undefined;
        if (task) setTasks((prev) => [...(prev ?? []), task]);
      } catch {
        toast.error(tTasksPanel("createFailed"));
      } finally {
        setCreatingTask(false);
      }
    },
    [channelId, tTasksPanel],
  );

  const handleToggleTaskStatus = useCallback(
    async (task: SembangTask) => {
      if (!channelId) return;
      const nextStatus: SembangTaskStatus = task.status === "open" ? "done" : "open";
      // Optimistic: flip immediately, revert on failure.
      setTasks((prev) => (prev ?? []).map((tk) => (tk.id === task.id ? { ...tk, status: nextStatus } : tk)));
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "failed");
        const updated = data.task as SembangTask | undefined;
        if (updated) setTasks((prev) => (prev ?? []).map((tk) => (tk.id === task.id ? updated : tk)));
      } catch {
        setTasks((prev) => (prev ?? []).map((tk) => (tk.id === task.id ? task : tk)));
        toast.error(tTasksPanel("updateFailed"));
      }
    },
    [channelId, tTasksPanel],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      if (!channelId || deletingTaskId) return;
      setDeletingTaskId(taskId);
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/tasks/${taskId}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(data?.error || tTasksPanel("deleteFailed"));
          return;
        }
        setTasks((prev) => (prev ?? []).filter((tk) => tk.id !== taskId));
      } catch {
        toast.error(tTasksPanel("deleteFailed"));
      } finally {
        setDeletingTaskId(null);
      }
    },
    [channelId, deletingTaskId, tTasksPanel],
  );

  // ---- Migration 103: task -> ticket bridge -----------------------------
  // TasksPanel already did the PATCH itself (it owns the CreateTicketDialog
  // and needs the response to show a friendly error); this just patches
  // local state once that PATCH has already succeeded.
  const handleTicketLinked = useCallback((taskId: string, ticketId: string, ticketNumber: number) => {
    setTasks((prev) =>
      (prev ?? []).map((tk) => (tk.id === taskId ? { ...tk, ticketId, ticketNumber } : tk)),
    );
  }, []);

  // ---- Thread -----------------------------------------------------------
  const handleOpenThread = useCallback((message: SembangMessage) => {
    setThreadParentId(message.id);
  }, []);

  // Migration 101 — the "↪ replied to a thread" context line on a reply
  // mixed into the main timeline via `alsoInChannel` opens the thread for
  // its PARENT (`message.parentPreview.id`), not the reply's own id.
  const handleOpenParentThread = useCallback((parentMessageId: string) => {
    setThreadParentId(parentMessageId);
  }, []);

  const handleReplyPosted = useCallback((parentId: string, reply: SembangMessage) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === parentId ? { ...m, replyCount: (m.replyCount ?? 0) + 1, lastReplyAt: reply.createdAt } : m,
      ),
    );
  }, []);

  // ---- Meeting quick link -------------------------------------------------
  const handleStartMeeting = useCallback(async () => {
    await handleSendMessage(t("meetingMessage", { url: MEETING_URL }), [], []);
  }, [handleSendMessage, t]);

  // ---- Search (within this channel) ---------------------------------------
  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery("");
      setSearchResults(null);
      setSearching(false);
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || !channelId) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/sembang/channels/${channelId}/messages?q=${encodeURIComponent(q)}`,
          { cache: "no-store" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "search failed");
        setSearchResults((data.messages as SembangMessage[]) ?? []);
      } catch {
        toast.error(t("searchFailed"));
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchOpen, channelId, searchQuery, t]);

  // ---- Topic editing ---------------------------------------------------
  const handleTopicSave = useCallback(async () => {
    if (!channelId || savingTopic) return;
    setSavingTopic(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topicDraft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("topicSaveFailed"));
        return;
      }
      setChannel(data.channel as SembangChannel);
      setEditingTopic(false);
    } catch {
      toast.error(t("topicSaveFailed"));
    } finally {
      setSavingTopic(false);
    }
  }, [channelId, savingTopic, topicDraft, t]);

  const peopleNames = useMemo(() => accountMembers.map((m) => m.full_name), [accountMembers]);

  // ---- Migration 100: DM header label -------------------------------
  // `SembangChannel` (GET .../channels/[id]) doesn't carry
  // `dmParticipantNames` — only `SembangChannelSummary` (the sidebar RPC)
  // does. `members` is already fetched for every channel regardless of
  // type, so the DM header derives its label from that instead of
  // threading the summary row's fields down from page.tsx.
  const dmOtherMembers = useMemo(
    () => (members ?? []).filter((m) => m.userId !== user?.id),
    [members, user?.id],
  );
  // Header title AND the composer's "Message #<name>" placeholder both need
  // a non-null string — `SembangChannel.name` is nullable for a DM
  // (migration 100), so this is the one place that resolves it either way.
  const channelDisplayName = channel?.isDm
    ? dmOtherMembers.map((m) => m.fullName).join(", ") || t("directMessageFallback")
    : (channel?.name ?? "");

  // ---- Migration 100: star toggle ----------------------------------------
  const handleToggleStar = useCallback(
    (message: SembangMessage, starred: boolean) => {
      if (!channelId) return;
      const nextStarred = !starred;
      // Optimistic — `starredByMe` lives on the message itself (not a
      // separately fetched list like pins), so flip it locally right away
      // and revert on failure; same idea as handleToggleTaskStatus above.
      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, starredByMe: nextStarred } : m)),
      );
      void toggleMessageStar(channelId, message.id, starred).then((result) => {
        if (!result.ok) {
          setMessages((prev) =>
            prev.map((m) => (m.id === message.id ? { ...m, starredByMe: starred } : m)),
          );
          toast.error(starred ? t("unstarFailed") : t("starFailed"));
        }
      });
    },
    [channelId, t],
  );

  // ---- Migration 100: archive channel (channels only, not DMs) ----------
  const handleArchiveChannel = useCallback(async () => {
    if (!channelId || !channel || archiving) return;
    if (!window.confirm(t("archiveConfirm", { name: channel.name ?? "" }))) return;
    setArchiving(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("archiveFailed"));
        return;
      }
      toast.success(t("archived"));
      onChannelArchived?.(channelId);
    } catch {
      toast.error(t("archiveFailed"));
    } finally {
      setArchiving(false);
    }
  }, [channelId, channel, archiving, t, onChannelArchived]);

  // ---- Migration 101: mute toggle (both channels and DMs — muting a
  // noisy DM makes just as much sense as muting a noisy channel, so this
  // is NOT gated on `!isDm` the way Archive is). Same optimistic-flip/
  // revert-on-failure shape as `handleToggleStar` above; `set_sembang_
  // channel_muted` is a self-scoped RPC, so this needs no extra guard
  // beyond "we have a channel and aren't already mid-toggle." -----------
  const handleToggleMute = useCallback(async () => {
    if (!channelId || !channel || muting) return;
    const nextMuted = !channel.muted;
    setChannel((prev) => (prev ? { ...prev, muted: nextMuted } : prev));
    setMuting(true);
    try {
      const res = await fetch(`/api/sembang/channels/${channelId}/mute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: nextMuted }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      setChannel((prev) => (prev ? { ...prev, muted: !nextMuted } : prev));
      toast.error(nextMuted ? t("muteFailed") : t("unmuteFailed"));
    } finally {
      setMuting(false);
    }
  }, [channelId, channel, muting, t]);

  const canManageMembers = channel?.memberRole === "moderator" || hasMinRole(accountRole ?? "viewer", "admin");
  const canRemoveMessages = canManageMembers;
  const isMember = !!channel?.memberRole;
  const openTaskCount = (tasks ?? []).filter((tk) => tk.status === "open").length;

  // ---- Empty state: no channel selected ----------------------------------
  if (!channelId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Hash className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">{t("selectChannel")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("selectChannelHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col bg-background",
          threadParentId ? "hidden sm:flex" : "flex",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-b border-border bg-card px-3 py-3 sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {onBack && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="lg:hidden"
                onClick={onBack}
                aria-label={t("backAriaLabel")}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {channel?.isDm ? (
              <PersonAvatar
                name={dmOtherMembers[0]?.fullName}
                avatarUrl={dmOtherMembers[0]?.avatarUrl}
                size="sm"
              />
            ) : channel?.isPrivate ? (
              <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {channel ? channelDisplayName : "…"}
              </p>
              {/* DM membership is fixed at creation — no topic to show/edit
                  (migration 100, frontend item 3). */}
              {channel?.isDm ? null : editingTopic ? (
                <div className="mt-0.5 flex items-center gap-1">
                  <Input
                    autoFocus
                    value={topicDraft}
                    onChange={(e) => setTopicDraft(e.target.value)}
                    placeholder={t("topicPlaceholder")}
                    aria-label={t("editTopicAriaLabel")}
                    className="h-6 text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleTopicSave();
                      } else if (e.key === "Escape") {
                        setEditingTopic(false);
                      }
                    }}
                  />
                  <Button size="icon-xs" onClick={handleTopicSave} disabled={savingTopic} aria-label={t("topicSave")}>
                    {savingTopic ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setEditingTopic(false)}
                    aria-label={t("topicCancel")}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={
                    canManageMembers
                      ? () => {
                          setTopicDraft(channel?.topic ?? "");
                          setEditingTopic(true);
                        }
                      : undefined
                  }
                  className={cn(
                    "group/topic flex min-w-0 items-center gap-1 text-left",
                    canManageMembers ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span className="truncate text-xs text-muted-foreground">{channel?.topic || t("noTopic")}</span>
                  {canManageMembers && (
                    <Pencil
                      className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover/topic:opacity-100"
                      aria-hidden
                    />
                  )}
                </button>
              )}
            </div>
          </div>
          {channel && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setPinsPanelOpen(true)}>
                <Pin className="h-4 w-4" />
                {t("pinnedButton", { count: pins?.length ?? 0 })}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setTasksPanelOpen(true)}>
                <CheckSquare className="h-4 w-4" />
                {t("tasksButton", { count: openTaskCount })}
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t("resourcesAriaLabel")}
                title={t("resourcesAriaLabel")}
                onClick={() => setResourcesPanelOpen(true)}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t("startMeeting")}
                title={t("startMeeting")}
                onClick={handleStartMeeting}
              >
                <Video className="h-4 w-4" />
              </Button>
              <Popover open={searchOpen} onOpenChange={setSearchOpen}>
                <PopoverTrigger
                  aria-label={t("searchAriaLabel")}
                  title={t("searchAriaLabel")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30"
                >
                  <SearchIcon className="h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 gap-2 p-2.5">
                  <Input
                    autoFocus
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t("searchPlaceholder")}
                    aria-label={t("searchPlaceholder")}
                    className="h-8"
                  />
                  <div className="max-h-72 overflow-y-auto">
                    {searching ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      </div>
                    ) : searchResults === null ? null : searchResults.length === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">{t("searchNoResults")}</p>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {searchResults.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            // Jumping to the message in its full history is
                            // deferred past P1 (SPEC-P1.md's frontend item
                            // 8) — closing the popover is the whole
                            // interaction for now.
                            onClick={() => setSearchOpen(false)}
                            className="rounded-md px-2 py-1.5 text-left hover:bg-muted"
                          >
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-xs font-semibold text-foreground">
                                {m.author?.fullName ?? t("unknownAuthor")}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {format(new Date(m.createdAt), "MMM d, HH:mm")}
                              </span>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">{boldMatch(m.body, searchQuery)}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              {/* DM participants are fixed at creation — no manage controls
                  needed, so the whole button is hidden rather than shown
                  read-only (migration 100, frontend item 3). */}
              {!channel.isDm && (
                <Button variant="outline" size="sm" onClick={() => setMembersPanelOpen(true)}>
                  <Users className="h-4 w-4" />
                  {t("membersButton", { count: members?.length ?? 0 })}
                </Button>
              )}
              {/* Mute (migration 101) is available to any member of either a
                  channel or a DM. Archive stays channel-only, not built for
                  DMs this pass — a DM's `archived_at` is shared between both
                  participants, so one person archiving it would hide it for
                  the other too (migration 100, frontend item 3/7) — and
                  stays gated on `canManageMembers`, unlike Mute. Both live in
                  this one kebab menu rather than a second menu. */}
              {isMember && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t("moreActions")}
                    title={t("moreActions")}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52 border-border bg-popover">
                    <DropdownMenuItem onClick={handleToggleMute} disabled={muting}>
                      {channel.muted ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                      {channel.muted ? t("unmuteChannel") : t("muteChannel")}
                    </DropdownMenuItem>
                    {!channel.isDm && canManageMembers && (
                      <DropdownMenuItem variant="destructive" onClick={handleArchiveChannel} disabled={archiving}>
                        <Archive className="h-3.5 w-3.5" />
                        {t("archiveChannel")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        {channelError ? (
          <div className="flex flex-1 flex-col items-center justify-center">
            <p className="text-sm text-destructive">{t("channelLoadFailed")}</p>
          </div>
        ) : !channel ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
            {hasMoreEarlier && (
              <div className="flex justify-center py-2">
                <Button variant="outline" size="sm" onClick={handleLoadEarlier} disabled={loadingEarlier}>
                  {loadingEarlier && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t("loadEarlier")}
                </Button>
              </div>
            )}

            {messagesLoading && messages.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : messagesError && messages.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-destructive">{t("loadFailed")}</p>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">{t("noMessages")}</p>
              </div>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  currentUserId={user?.id}
                  peopleNames={peopleNames}
                  isPinned={pinnedMessageIds.has(m.id)}
                  canRemoveOthers={canRemoveMessages}
                  onReplyInThread={handleOpenThread}
                  onOpenThread={handleOpenThread}
                  onOpenParentThread={handleOpenParentThread}
                  onReact={handleReact}
                  onTogglePin={handleTogglePin}
                  onToggleStar={handleToggleStar}
                  onEdit={handleEditMessage}
                  onRemove={handleRemoveMessage}
                  onAddToTask={handleAddToTask}
                />
              ))
            )}
          </div>
        )}

        {channel && isMember ? (
          <MessageComposer channelId={channel.id} channelName={channelDisplayName} onSend={handleSendMessage} />
        ) : channel && !channel.isPrivate && !channel.isDm ? (
          <div className="border-t border-border bg-card p-3.5 text-center">
            <Button onClick={handleJoin} disabled={joining}>
              {joining && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("joinChannel")}
            </Button>
          </div>
        ) : null}
      </div>

      {/* Thread column — a flex sibling of the channel content above, not a
          Sheet, so it sits alongside the messages/composer like Slack's
          thread pane rather than floating over them. */}
      {channel && (
        <ThreadPanel
          open={!!threadParentId}
          onOpenChange={(open) => {
            if (!open) setThreadParentId(null);
          }}
          channelId={channel.id}
          channelName={channelDisplayName}
          parentMessageId={threadParentId}
          currentUserId={user?.id}
          peopleNames={peopleNames}
          canRemoveMessages={canRemoveMessages}
          pinnedMessageIds={pinnedMessageIds}
          onReact={handleReact}
          onTogglePin={handleTogglePin}
          onToggleStar={handleToggleStar}
          onEditMessage={handleEditMessage}
          onRemoveMessage={handleRemoveMessage}
          onAddToTask={handleAddToTask}
          onReplyPosted={handleReplyPosted}
        />
      )}

      {channel && (
        <>
          {!channel.isDm && (
            <MembersPanel
              open={membersPanelOpen}
              onOpenChange={setMembersPanelOpen}
              channelId={channel.id}
              isPrivate={channel.isPrivate}
              canManage={canManageMembers}
              members={members}
              onMembersChange={setMembers}
            />
          )}
          <PinsPanel
            open={pinsPanelOpen}
            onOpenChange={setPinsPanelOpen}
            pins={pins}
            peopleNames={peopleNames}
            onUnpin={handleUnpinFromPanel}
            unpinningId={unpinningId}
          />
          <TasksPanel
            open={tasksPanelOpen}
            onOpenChange={setTasksPanelOpen}
            channelId={channel.id}
            channelName={channelDisplayName}
            tasks={tasks}
            onCreate={handleCreateTask}
            onToggleStatus={handleToggleTaskStatus}
            onDelete={handleDeleteTask}
            onTicketLinked={handleTicketLinked}
            creating={creatingTask}
            deletingId={deletingTaskId}
          />
          <ChannelResourcesPanel
            open={resourcesPanelOpen}
            onOpenChange={setResourcesPanelOpen}
            channelId={channel.id}
          />
        </>
      )}
    </div>
  );
}
