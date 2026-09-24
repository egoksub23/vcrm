"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileText,
  Hash,
  Loader2,
  Lock,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { highlightMentions } from "@/lib/tickets/mention-highlight";
import { useAuth } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import { hasMinRole } from "@/lib/auth/roles";
import { useSembangChannelRealtime } from "@/hooks/use-sembang-realtime";
import { MessageComposer, type PendingSembangAttachment } from "./message-composer";
import { MembersPanel } from "./members-panel";
import type { SembangChannel, SembangMember, SembangMessage } from "@/types";

const MESSAGES_PAGE_SIZE = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ChannelThreadProps {
  channelId: string | null;
  /** Mobile back button — deselects the active channel. `lg:hidden`,
   *  exactly like message-thread.tsx's `onBack`. */
  onBack?: () => void;
  /** Fired once the channel is marked read server-side, so the page can
   *  optimistically zero the sidebar's unread badge. */
  onChannelRead?: (channelId: string) => void;
}

export function ChannelThread({ channelId, onBack, onChannelRead }: ChannelThreadProps) {
  const t = useTranslations("Sembang.thread");
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

  // ---- Realtime: new messages / soft-deletes in this channel -----------
  useSembangChannelRealtime({
    channelId,
    onMessageEvent: (event) => {
      if (event.eventType === "INSERT") {
        const row = event.new;
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
            m.id === row.id ? { ...m, deletedAt: row.deleted_at, deletedBy: row.deleted_by } : m,
          ),
        );
      }
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

  // ---- Send / remove message ---------------------------------------------
  const handleSendMessage = useCallback(
    async (body: string, mentions: string[], attachments: PendingSembangAttachment[]): Promise<boolean> => {
      if (!channelId) return false;
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body,
            mentions,
            attachments: attachments.length > 0 ? attachments : undefined,
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

  const handleRemoveMessage = useCallback(
    async (messageId: string) => {
      if (!channelId) return;
      try {
        const res = await fetch(`/api/sembang/channels/${channelId}/messages/${messageId}`, {
          method: "PATCH",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(data?.error || t("removeMessageFailed"));
          return;
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, deletedAt: new Date().toISOString(), deletedBy: user?.id ?? null }
              : m,
          ),
        );
      } catch {
        toast.error(t("removeMessageFailed"));
      }
    },
    [channelId, t, user?.id],
  );

  const peopleNames = useMemo(() => accountMembers.map((m) => m.full_name), [accountMembers]);

  const canManageMembers = channel?.memberRole === "moderator" || hasMinRole(accountRole ?? "viewer", "admin");
  const canRemoveMessages = canManageMembers;
  const isMember = !!channel?.memberRole;

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
    <div className="flex min-w-0 flex-1 flex-col bg-background">
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
          {channel?.isPrivate ? (
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{channel?.name ?? "…"}</p>
            <p className="truncate text-xs text-muted-foreground">{channel?.topic || t("noTopic")}</p>
          </div>
        </div>
        {channel && (
          <Button variant="outline" size="sm" onClick={() => setMembersPanelOpen(true)}>
            <Users className="h-4 w-4" />
            {t("membersButton", { count: members?.length ?? 0 })}
          </Button>
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
            messages.map((m) => {
              const isDeleted = !!m.deletedAt;
              return (
                <div
                  key={m.id}
                  className="group flex gap-2.5 px-3 py-1.5 hover:bg-muted/30 sm:px-4"
                >
                  <PersonAvatar name={m.author?.fullName} avatarUrl={m.author?.avatarUrl} size="md" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {m.author?.fullName ?? t("unknownAuthor")}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {format(new Date(m.createdAt), "HH:mm")}
                      </span>
                    </div>
                    {isDeleted ? (
                      <p className="text-sm text-muted-foreground italic">{t("messageRemoved")}</p>
                    ) : (
                      <>
                        <p className="text-sm whitespace-pre-wrap break-words text-foreground">
                          {highlightMentions(m.body, peopleNames, []).map((seg, i) =>
                            seg.kind === "text" ? (
                              <span key={i}>{seg.text}</span>
                            ) : (
                              <span key={i} className="rounded-sm bg-primary/15 px-0.5">
                                {seg.text}
                              </span>
                            ),
                          )}
                        </p>
                        {m.attachments.length > 0 && (
                          <div className="mt-1 flex flex-col gap-1">
                            {m.attachments.map((a) => (
                              <a
                                key={a.id}
                                href={a.url}
                                target="_blank"
                                rel="noreferrer"
                                className="flex w-fit items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
                              >
                                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="max-w-56 truncate">{a.filename}</span>
                                <span className="text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {!isDeleted && canRemoveMessages && (
                    <button
                      type="button"
                      onClick={() => handleRemoveMessage(m.id)}
                      className="shrink-0 self-start text-xs text-destructive opacity-0 group-hover:opacity-100 hover:underline"
                    >
                      {t("removeMessage")}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {channel && isMember ? (
        <MessageComposer channelId={channel.id} channelName={channel.name} onSend={handleSendMessage} />
      ) : channel && !channel.isPrivate ? (
        <div className="border-t border-border bg-card p-3.5 text-center">
          <Button onClick={handleJoin} disabled={joining}>
            {joining && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("joinChannel")}
          </Button>
        </div>
      ) : null}

      {channel && (
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
    </div>
  );
}
