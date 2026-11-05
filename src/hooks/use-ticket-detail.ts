"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import { attachFileToTicket, removeTicketAttachment } from "@/lib/tickets/attachment-actions";
import { TICKET_MAX_ATTACHMENTS, checkTicketFile, formatBytes } from "@/lib/tickets/attachments";
import { linkRowFor, type LinkGroupKey } from "@/lib/tickets/links";
import { buildTicketPatch } from "@/lib/tickets/patch";
import { postTicketCommentRequest } from "@/lib/tickets/mention-actions";
import type { MentionKind } from "@/lib/tickets/mentions";
import { updateTicketResult } from "@/lib/tickets/update";
import { ImagePrepareError } from "@/lib/media/prepare-image";
import type {
  Contact,
  Ticket,
  TicketActivity,
  TicketAttachment,
  TicketComment,
  TicketLink,
  TicketWatcher,
} from "@/types";

/** The bits of another ticket a link shows. */
export type LinkedTicket = Pick<Ticket, "id" | "ticket_number" | "subject" | "status" | "category">;

export interface UploadingFile {
  key: string;
  name: string;
}

/**
 * Everything the ticket view needs about one ticket: the ticket itself, its
 * comments, history, watchers, links and attachments, kept live over
 * realtime, plus every write (edit a field, comment, watch, link, attach,
 * delete) with optimistic UI and a toast on failure. Shared by the modal, the
 * full-page route and any future surface, so they behave identically.
 */
export function useTicketDetail(
  ticketId: string | null,
  {
    onChanged,
    onDeleted,
  }: {
    /** A field changed (with the patch), a comment was added / removed, etc. */
    onChanged?: (id: string, patch?: Partial<Ticket>) => void;
    onDeleted?: (id: string) => void;
  } = {},
) {
  const t = useTranslations("Tickets.detail");
  const tLinks = useTranslations("Tickets.links");
  const tAtt = useTranslations("Tickets.attachments");
  const tMention = useTranslations("Tickets.detail.mention");
  const tResolution = useTranslations("Tickets.resolution");
  const { user, accountId } = useAuth();

  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [activity, setActivity] = useState<TicketActivity[]>([]);
  const [watchers, setWatchers] = useState<TicketWatcher[]>([]);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [linked, setLinked] = useState<Record<string, LinkedTicket>>({});
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [saving, setSaving] = useState(false);

  const ticketRef = useRef<Ticket | null>(null);
  useEffect(() => {
    ticketRef.current = ticket;
  }, [ticket]);
  const linkedRef = useRef(linked);
  useEffect(() => {
    linkedRef.current = linked;
  }, [linked]);

  const loading = !!ticketId && loadedId !== ticketId;
  const notFound = !!ticketId && loadedId === ticketId && !ticket;

  // ---- Loading -----------------------------------------------------------
  const loadLinks = useCallback(async (id: string) => {
    const res = await fetch(`/api/tickets/${encodeURIComponent(id)}`).catch(() => null);
    if (!res?.ok) return;
    const json = (await res.json().catch(() => null)) as {
      links?: TicketLink[];
      linked?: Record<string, LinkedTicket>;
    } | null;
    setLinks((json?.links ?? []) as TicketLink[]);
    setLinked((prev) => ({ ...prev, ...((json?.linked ?? {}) as Record<string, LinkedTicket>) }));
  }, []);

  const load = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/tickets/${encodeURIComponent(id)}`).catch(() => null);
      const json = res?.ok
        ? ((await res.json().catch(() => null)) as {
            ticket?: Ticket;
            contact?: Contact;
            comments?: TicketComment[];
            activity?: TicketActivity[];
            watchers?: TicketWatcher[];
            attachments?: TicketAttachment[];
            links?: TicketLink[];
            linked?: Record<string, LinkedTicket>;
          } | null)
        : null;
      setTicket(json?.ticket ?? null);
      setContact(json?.contact ?? null);
      setComments(json?.comments ?? []);
      setActivity(json?.activity ?? []);
      setWatchers(json?.watchers ?? []);
      setAttachments(json?.attachments ?? []);
      setLinks((json?.links ?? []) as TicketLink[]);
      setLinked((json?.linked ?? {}) as Record<string, LinkedTicket>);
      setLoadedId(id);
    },
    [],
  );

  useEffect(() => {
    if (!ticketId) return;
    void load(ticketId);
  }, [ticketId, load]);

  // ---- Realtime --------------------------------------------------------------
  useAccountSse(
    "tickets",
    ticketId
      ? (payload: SsePayload) => {
          if (payload.eventType !== "UPDATE") return;
          if ((payload.new as { id?: string }).id !== ticketId) return;
          setTicket((prev) => (prev ? { ...prev, ...(payload.new as Ticket) } : prev));
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_activity",
    ticketId
      ? (payload: SsePayload) => {
          if (payload.eventType !== "INSERT") return;
          const row = payload.new as TicketActivity;
          if (row.ticket_id !== ticketId) return;
          setActivity((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_comments",
    ticketId
      ? (payload: SsePayload) => {
          const row = payload.new as TicketComment;
          const oldRow = payload.old as { id?: string };
          if (payload.eventType === "INSERT") {
            if (row.ticket_id !== ticketId) return;
            setComments((prev) => (prev.some((c) => c.id === row.id) ? prev : [...prev, row]));
          } else if (payload.eventType === "UPDATE") {
            if (row.ticket_id !== ticketId) return;
            setComments((prev) => prev.map((c) => (c.id === row.id ? { ...c, ...row } : c)));
          } else if (payload.eventType === "DELETE") {
            if (oldRow.id) setComments((prev) => prev.filter((c) => c.id !== oldRow.id));
          }
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_watchers",
    ticketId
      ? (payload: SsePayload) => {
          const row = payload.new as { ticket_id?: string };
          const old = payload.old as { ticket_id?: string };
          const tid = row.ticket_id ?? old.ticket_id;
          if (tid !== ticketId) return;
          void fetch(`/api/tickets/${encodeURIComponent(ticketId)}/watchers`)
            .then((r) => (r.ok ? r.json() : null))
            .then((json: { watchers?: TicketWatcher[] } | null) => {
              if (json?.watchers) setWatchers(json.watchers);
            })
            .catch(() => undefined);
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_attachments",
    ticketId
      ? (payload: SsePayload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as TicketAttachment;
            if (row.ticket_id !== ticketId) return;
            setAttachments((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
          } else if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string }).id;
            if (id) setAttachments((prev) => prev.filter((a) => a.id !== id));
          }
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_links",
    ticketId && accountId
      ? (_payload: SsePayload) => void loadLinks(ticketId)
      : undefined,
    !!(ticketId && accountId),
  );

  // ---- Writes ------------------------------------------------------------------
  /** Save fields: optimistic, rolled back with a toast if the write fails. */
  const update = useCallback(
    async (patch: Partial<Ticket>): Promise<boolean> => {
      const current = ticketRef.current;
      if (!current) return false;
      const full = buildTicketPatch(patch);
      setTicket({ ...current, ...full });
      setSaving(true);
      const result = await updateTicketResult(current.id, full);
      setSaving(false);
      if (!result.ok) {
        setTicket((prev) => (prev && prev.id === current.id ? current : prev));
        // Migration 096: the workspace needs a resolution to resolve or close a ticket.
        toast.error(
          result.code === "resolution_required"
            ? tResolution("required")
            : result.code === "resolution_invalid"
              ? tResolution("invalid")
              : t("updateFailed"),
        );
        return false;
      }
      onChanged?.(current.id, full);
      return true;
    },
    [onChanged, t, tResolution],
  );

  /**
   * Post a comment through the server (migration 095): it expands @teams into
   * their members, makes them watchers and, for "needs a response", records who
   * has to answer. `options` is left out for a plain comment.
   */
  const addComment = useCallback(
    async (body: string, mentions: string[], options?: { teams?: string[]; kind?: MentionKind }): Promise<boolean> => {
      const current = ticketRef.current;
      const text = body.trim();
      if (!current || !text) return false;
      const result = await postTicketCommentRequest(current.id, {
        body: text,
        mentions,
        teams: options?.teams ?? [],
        kind: options?.kind ?? "response",
      });
      if (!result.ok) {
        toast.error(result.error || t("commentFailed"));
        return false;
      }
      const { comment, skippedNoAccess, warnings } = result.data;
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
      onChanged?.(current.id);
      if (skippedNoAccess > 0) toast.info(tMention("skippedNoAccess", { count: skippedNoAccess }));
      if (warnings.includes("requests_failed")) toast.error(tMention("requestsFailed"));
      else if (warnings.includes("ticket_closed")) toast.info(tMention("ticketClosedNoRequests"));
      return true;
    },
    [onChanged, t, tMention],
  );

  const editComment = useCallback(
    async (id: string, body: string): Promise<boolean> => {
      const text = body.trim();
      if (!text) return false;
      const current = ticketRef.current;
      if (!current) return false;
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(current.id)}/comments/${encodeURIComponent(id)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text }) },
      ).catch(() => null);
      if (!res?.ok) {
        toast.error(t("commentEditFailed"));
        return false;
      }
      const json = (await res.json().catch(() => null)) as { comment?: TicketComment } | null;
      if (json?.comment) setComments((prev) => prev.map((c) => (c.id === id ? json.comment! : c)));
      return true;
    },
    [t],
  );

  const deleteComment = useCallback(
    async (id: string): Promise<boolean> => {
      const current = ticketRef.current;
      if (!current) return false;
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(current.id)}/comments/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ).catch(() => null);
      if (!res?.ok) {
        toast.error(t("commentDeleteFailed"));
        return false;
      }
      setComments((prev) => prev.filter((c) => c.id !== id));
      onChanged?.(current.id);
      return true;
    },
    [onChanged, t],
  );

  const watching = !!user && watchers.some((w) => w.user_id === user.id);
  const toggleWatch = useCallback(async () => {
    const current = ticketRef.current;
    if (!current || !user) return;
    if (watching) {
      const before = watchers;
      setWatchers((prev) => prev.filter((w) => w.user_id !== user.id));
      const res = await fetch(`/api/tickets/${encodeURIComponent(current.id)}/watchers`, { method: "DELETE" }).catch(() => null);
      if (!res?.ok) {
        setWatchers(before);
        toast.error(t("watchFailed"));
      }
    } else {
      const row: TicketWatcher = {
        ticket_id: current.id,
        user_id: user.id,
        account_id: current.account_id,
        created_at: new Date().toISOString(),
      };
      setWatchers((prev) => [...prev, row]);
      const res = await fetch(`/api/tickets/${encodeURIComponent(current.id)}/watchers`, { method: "POST" }).catch(() => null);
      if (!res?.ok) {
        setWatchers((prev) => prev.filter((w) => w.user_id !== user.id));
        toast.error(t("watchFailed"));
      }
    }
  }, [user, watching, watchers, t]);

  const addLink = useCallback(
    async (group: LinkGroupKey, other: LinkedTicket): Promise<boolean> => {
      const current = ticketRef.current;
      if (!current) return false;
      const linkRow = linkRowFor(group, current.id, other.id);
      const res = await fetch(`/api/tickets/${encodeURIComponent(current.id)}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(linkRow),
      }).catch(() => null);
      if (!res?.ok) {
        const json = res ? ((await res.json().catch(() => null)) as { code?: string } | null) : null;
        toast.error(json?.code === "23505" || res?.status === 409 ? tLinks("exists") : tLinks("addFailed"));
        return false;
      }
      const json = (await res.json().catch(() => null)) as { link?: TicketLink } | null;
      if (json?.link) {
        setLinked((prev) => ({ ...prev, [other.id]: other }));
        setLinks((prev) => (prev.some((l) => l.id === json.link!.id) ? prev : [...prev, json.link!]));
      }
      return true;
    },
    [tLinks],
  );

  const removeLink = useCallback(
    async (id: string) => {
      const current = ticketRef.current;
      const before = links;
      setLinks((prev) => prev.filter((l) => l.id !== id));
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(current?.id ?? "_")}/links/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ).catch(() => null);
      if (!res?.ok) {
        setLinks(before);
        toast.error(tLinks("removeFailed"));
      }
    },
    [links, tLinks],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const current = ticketRef.current;
      if (!current || !user || files.length === 0) return;
      let count = attachments.length;
      // One after the other: keeps the order of the drop and spares the bucket.
      for (const file of files) {
        const rejection = checkTicketFile(file, count);
        if (rejection) {
          toast.error(
            rejection.reason === "tooMany"
              ? tAtt("tooMany", { max: TICKET_MAX_ATTACHMENTS })
              : tAtt("tooLarge", { name: file.name, max: formatBytes(rejection.maxBytes) }),
          );
          if (rejection.reason === "tooMany") break;
          continue;
        }
        count += 1;
        const key = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setUploading((prev) => [...prev, { key, name: file.name || "image" }]);
        try {
          const row = await attachFileToTicket(current, file, user.id);
          setAttachments((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
        } catch (err) {
          count -= 1;
          if (err instanceof ImagePrepareError) {
            toast.error(
              err.code === "unsupported"
                ? tAtt("unsupported")
                : err.code === "tooLarge"
                  ? tAtt("imageTooLarge", { max: formatBytes(err.maxBytes ?? 0) })
                  : tAtt("unreadable"),
            );
          } else {
            toast.error(err instanceof Error && err.message ? err.message : tAtt("uploadFailed"));
          }
        } finally {
          setUploading((prev) => prev.filter((u) => u.key !== key));
        }
      }
    },
    [attachments.length, user, tAtt],
  );

  const removeAttachment = useCallback(
    async (att: TicketAttachment) => {
      const before = attachments;
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      if (!(await removeTicketAttachment(att))) {
        setAttachments(before);
        toast.error(tAtt("removeFailed"));
      }
    },
    [attachments, tAtt],
  );

  const deleteTicket = useCallback(async (): Promise<boolean> => {
    const current = ticketRef.current;
    if (!current) return false;
    const res = await fetch(`/api/tickets/${encodeURIComponent(current.id)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error(t("deleteFailed"));
      return false;
    }
    onDeleted?.(current.id);
    return true;
  }, [onDeleted, t]);

  return {
    loading,
    notFound,
    ticket,
    contact,
    comments,
    activity,
    watchers,
    watching,
    links,
    linked,
    attachments,
    uploading,
    saving,
    update,
    addComment,
    editComment,
    deleteComment,
    toggleWatch,
    addLink,
    removeLink,
    addFiles,
    removeAttachment,
    deleteTicket,
  };
}

/** Search tickets to link to: by key / number or words in the summary. */
export async function searchTicketsForLink(query: string, excludeId: string): Promise<LinkedTicket[]> {
  const params = new URLSearchParams({ q: query, exclude: excludeId });
  const res = await fetch(`/api/tickets/link-search?${params.toString()}`).catch(() => null);
  if (!res?.ok) return [];
  const json = (await res.json().catch(() => null)) as { tickets?: LinkedTicket[] } | null;
  return json?.tickets ?? [];
}
