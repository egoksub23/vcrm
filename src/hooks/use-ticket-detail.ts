"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { attachFileToTicket, removeTicketAttachment } from "@/lib/tickets/attachment-actions";
import { TICKET_MAX_ATTACHMENTS, checkTicketFile, formatBytes } from "@/lib/tickets/attachments";
import { linkRowFor, type LinkGroupKey } from "@/lib/tickets/links";
import { buildTicketPatch } from "@/lib/tickets/patch";
import { updateTicket } from "@/lib/tickets/update";
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
const LINKED_COLUMNS = "id, ticket_number, subject, status, category";

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
  const { user } = useAuth();

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
    const supabase = createClient();
    const { data } = await supabase
      .from("ticket_links")
      .select("*")
      .or(`from_ticket_id.eq.${id},to_ticket_id.eq.${id}`)
      .order("created_at", { ascending: true });
    const rows = (data as TicketLink[]) ?? [];
    setLinks(rows);
    const missing = [
      ...new Set(rows.flatMap((l) => [l.from_ticket_id, l.to_ticket_id]).filter((x) => x !== id && !linkedRef.current[x])),
    ];
    if (missing.length > 0) {
      const { data: others } = await supabase.from("tickets").select(LINKED_COLUMNS).in("id", missing);
      setLinked((prev) => ({
        ...prev,
        ...Object.fromEntries(((others as LinkedTicket[]) ?? []).map((o) => [o.id, o])),
      }));
    }
  }, []);

  const load = useCallback(
    async (id: string) => {
      const supabase = createClient();
      const [ticketRes, commentRes, activityRes, watcherRes, attachmentRes] = await Promise.all([
        supabase.from("tickets").select("*").eq("id", id).maybeSingle(),
        supabase.from("ticket_comments").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
        supabase.from("ticket_activity").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
        supabase.from("ticket_watchers").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
        supabase.from("ticket_attachments").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
      ]);
      const row = (ticketRes.data as Ticket | null) ?? null;
      setTicket(row);
      setComments((commentRes.data as TicketComment[]) ?? []);
      setActivity((activityRes.data as TicketActivity[]) ?? []);
      setWatchers((watcherRes.data as TicketWatcher[]) ?? []);
      setAttachments((attachmentRes.data as TicketAttachment[]) ?? []);
      setLinked({});
      setLinks([]);
      setContact(null);
      setLoadedId(id);
      if (row) {
        void loadLinks(id);
        const { data: contactRow } = await supabase.from("contacts").select("*").eq("id", row.contact_id).maybeSingle();
        setContact((contactRow as Contact) ?? null);
      }
    },
    [loadLinks],
  );

  useEffect(() => {
    if (!ticketId) return;
    void load(ticketId);
  }, [ticketId, load]);

  // ---- Realtime --------------------------------------------------------------
  useEffect(() => {
    if (!ticketId) return;
    const supabase = createClient();
    const filter = `ticket_id=eq.${ticketId}`;
    const channel = supabase
      .channel(`ticket-detail-${ticketId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tickets", filter: `id=eq.${ticketId}` },
        (payload) => setTicket((prev) => (prev ? { ...prev, ...(payload.new as Ticket) } : prev)),
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ticket_activity", filter }, (payload) => {
        const row = payload.new as TicketActivity;
        setActivity((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ticket_comments", filter }, (payload) => {
        const row = payload.new as TicketComment;
        setComments((prev) => (prev.some((c) => c.id === row.id) ? prev : [...prev, row]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ticket_comments", filter }, (payload) => {
        const row = payload.new as TicketComment;
        setComments((prev) => prev.map((c) => (c.id === row.id ? { ...c, ...row } : c)));
      })
      // Deletes cannot be filtered by column; ids are matched against what is open.
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "ticket_comments" }, (payload) => {
        const id = (payload.old as { id?: string }).id;
        if (id) setComments((prev) => prev.filter((c) => c.id !== id));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "ticket_watchers", filter }, () => {
        void supabase
          .from("ticket_watchers")
          .select("*")
          .eq("ticket_id", ticketId)
          .order("created_at", { ascending: true })
          .then(({ data }) => setWatchers((data as TicketWatcher[]) ?? []));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "ticket_links" }, () => void loadLinks(ticketId))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ticket_attachments", filter }, (payload) => {
        const row = payload.new as TicketAttachment;
        setAttachments((prev) => (prev.some((a) => a.id === row.id) ? prev : [...prev, row]));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "ticket_attachments" }, (payload) => {
        const id = (payload.old as { id?: string }).id;
        if (id) setAttachments((prev) => prev.filter((a) => a.id !== id));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [ticketId, loadLinks]);

  // ---- Writes ------------------------------------------------------------------
  /** Save fields: optimistic, rolled back with a toast if the write fails. */
  const update = useCallback(
    async (patch: Partial<Ticket>): Promise<boolean> => {
      const current = ticketRef.current;
      if (!current) return false;
      const full = buildTicketPatch(patch);
      setTicket({ ...current, ...full });
      setSaving(true);
      const written = await updateTicket(current.id, full);
      setSaving(false);
      if (!written) {
        setTicket((prev) => (prev && prev.id === current.id ? current : prev));
        toast.error(t("updateFailed"));
        return false;
      }
      onChanged?.(current.id, full);
      return true;
    },
    [onChanged, t],
  );

  const addComment = useCallback(
    async (body: string, mentions: string[]): Promise<boolean> => {
      const current = ticketRef.current;
      const text = body.trim();
      if (!current || !text) return false;
      const { data, error } = await createClient()
        .from("ticket_comments")
        .insert({
          ticket_id: current.id,
          account_id: current.account_id,
          author_id: user?.id ?? null,
          body: text,
          mentions,
        })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(t("commentFailed"));
        return false;
      }
      setComments((prev) => (prev.some((c) => c.id === (data as TicketComment).id) ? prev : [...prev, data as TicketComment]));
      onChanged?.(current.id);
      return true;
    },
    [user?.id, onChanged, t],
  );

  const editComment = useCallback(
    async (id: string, body: string): Promise<boolean> => {
      const text = body.trim();
      if (!text) return false;
      const { data, error } = await createClient()
        .from("ticket_comments")
        .update({ body: text })
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error || !data) {
        toast.error(t("commentEditFailed"));
        return false;
      }
      setComments((prev) => prev.map((c) => (c.id === id ? (data as TicketComment) : c)));
      return true;
    },
    [t],
  );

  const deleteComment = useCallback(
    async (id: string): Promise<boolean> => {
      const { error } = await createClient().from("ticket_comments").delete().eq("id", id);
      if (error) {
        toast.error(t("commentDeleteFailed"));
        return false;
      }
      setComments((prev) => prev.filter((c) => c.id !== id));
      if (ticketRef.current) onChanged?.(ticketRef.current.id);
      return true;
    },
    [onChanged, t],
  );

  const watching = !!user && watchers.some((w) => w.user_id === user.id);
  const toggleWatch = useCallback(async () => {
    const current = ticketRef.current;
    if (!current || !user) return;
    const supabase = createClient();
    if (watching) {
      const before = watchers;
      setWatchers((prev) => prev.filter((w) => w.user_id !== user.id));
      const { error } = await supabase
        .from("ticket_watchers")
        .delete()
        .eq("ticket_id", current.id)
        .eq("user_id", user.id);
      if (error) {
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
      const { error } = await supabase
        .from("ticket_watchers")
        .insert({ ticket_id: current.id, user_id: user.id, account_id: current.account_id });
      if (error) {
        setWatchers((prev) => prev.filter((w) => w.user_id !== user.id));
        toast.error(t("watchFailed"));
      }
    }
  }, [user, watching, watchers, t]);

  const addLink = useCallback(
    async (group: LinkGroupKey, other: LinkedTicket): Promise<boolean> => {
      const current = ticketRef.current;
      if (!current) return false;
      const { data, error } = await createClient()
        .from("ticket_links")
        .insert({
          account_id: current.account_id,
          created_by: user?.id ?? null,
          ...linkRowFor(group, current.id, other.id),
        })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(error?.code === "23505" ? tLinks("exists") : tLinks("addFailed"));
        return false;
      }
      setLinked((prev) => ({ ...prev, [other.id]: other }));
      setLinks((prev) => (prev.some((l) => l.id === (data as TicketLink).id) ? prev : [...prev, data as TicketLink]));
      return true;
    },
    [user?.id, tLinks],
  );

  const removeLink = useCallback(
    async (id: string) => {
      const before = links;
      setLinks((prev) => prev.filter((l) => l.id !== id));
      const { error } = await createClient().from("ticket_links").delete().eq("id", id);
      if (error) {
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
    const { error } = await createClient().from("tickets").delete().eq("id", current.id);
    if (error) {
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
  const cleaned = query.replace(/[,()%*\\]/g, " ").trim();
  if (!cleaned) return [];
  const keyed = /^(?:[a-z][a-z0-9]{1,5}-|#)?(\d+)$/i.exec(cleaned);
  const filter = keyed
    ? `ticket_number.eq.${Number(keyed[1])},subject.ilike.%${cleaned}%`
    : `subject.ilike.%${cleaned}%`;
  const { data } = await createClient()
    .from("tickets")
    .select(LINKED_COLUMNS)
    .or(filter)
    .neq("id", excludeId)
    .order("updated_at", { ascending: false })
    .limit(8);
  return (data as LinkedTicket[]) ?? [];
}
