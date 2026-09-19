"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { ContactNote } from "@/types";

/** A note longer than this (or with more lines) is folded until expanded. */
const COLLAPSE_CHARS = 180;
const COLLAPSE_LINES = 4;
const NOTE_MAX_CHARS = 5000;

const isLong = (text: string) => text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
const stamp = (iso: string) => format(new Date(iso), "MMM d, yyyy HH:mm");

/**
 * Session notes for the contact in the open chat, in the lower half of
 * the column beside the chat. Each note carries who wrote it and when;
 * long notes fold until expanded; the author (or an admin) can edit or
 * delete. The add box stays pinned at the top while the notes scroll.
 */
export function ContactNotesPanel({ contactId }: { contactId: string | null }) {
  const t = useTranslations("Inbox.sidebar");
  const tn = useTranslations("Inbox.notesPanel");
  const { accountId, user, profile } = useAuth();
  const canWrite = useCan("send-messages");
  const isAdmin = useCan("edit-settings");

  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [authors, setAuthors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!contactId) return;
    const supabase = createClient();
    const [notesRes, profilesRes] = await Promise.all([
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
      supabase.from("profiles").select("user_id, full_name, email"),
    ]);
    if (notesRes.error) console.error("[ContactNotesPanel] load failed:", notesRes.error);
    setNotes((notesRes.data as ContactNote[]) ?? []);
    setAuthors(
      new Map(
        (profilesRes.data ?? []).map((p) => [
          p.user_id as string,
          ((p.full_name as string | null) || (p.email as string | null) || "").trim(),
        ]),
      ),
    );
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    if (!contactId) return;
    // A different contact starts from a clean, loading list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setNotes([]);
    setDraft("");
    void load();
  }, [contactId, load]);

  const authorName = (userId: string | null | undefined) =>
    (userId && authors.get(userId)) ||
    (userId && userId === user?.id ? profile?.full_name || profile?.email : "") ||
    tn("unknownAuthor");

  async function handleAdd() {
    const text = draft.trim();
    if (!contactId || !accountId || !user || !text || adding) return;
    setAdding(true);
    const { data, error } = await createClient()
      .from("contact_notes")
      .insert({ contact_id: contactId, account_id: accountId, user_id: user.id, note_text: text })
      .select()
      .single();
    setAdding(false);
    if (error || !data) {
      console.error("[ContactNotesPanel] add failed:", error);
      toast.error(tn("addFailed"));
      return;
    }
    setNotes((prev) => [data as ContactNote, ...prev]);
    setDraft("");
  }

  async function handleSave(id: string, text: string): Promise<boolean> {
    const { data, error } = await createClient()
      .from("contact_notes")
      .update({ note_text: text })
      .eq("id", id)
      .select()
      .single();
    if (error || !data) {
      console.error("[ContactNotesPanel] update failed:", error);
      toast.error(tn("saveFailed"));
      return false;
    }
    // The database stamps edited_at / edited_by; take its row as the truth.
    setNotes((prev) => prev.map((n) => (n.id === id ? (data as ContactNote) : n)));
    return true;
  }

  async function handleDelete(id: string): Promise<boolean> {
    const { error } = await createClient().from("contact_notes").delete().eq("id", id);
    if (error) {
      console.error("[ContactNotesPanel] delete failed:", error);
      toast.error(tn("deleteFailed"));
      return false;
    }
    setNotes((prev) => prev.filter((n) => n.id !== id));
    return true;
  }

  // The author can change their own note; an admin can change anyone's.
  const canManage = (note: ContactNote) => (note.user_id === user?.id ? canWrite : isAdmin);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <StickyNote className="h-4 w-4 text-primary" />
        <h3 className="flex-1 text-sm font-semibold text-foreground">{t("notes")}</h3>
        {notes.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">{notes.length}</span>
        ) : null}
      </div>

      {contactId && canWrite ? (
        <div className="flex gap-2 border-b border-border p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter adds, so Enter alone still makes a new line.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void handleAdd();
              }
            }}
            maxLength={NOTE_MAX_CHARS}
            placeholder={t("addNotePlaceholder")}
            rows={2}
            className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
          />
          <Button
            size="sm"
            className="h-auto bg-primary px-2 hover:bg-primary/90"
            onClick={() => void handleAdd()}
            disabled={!draft.trim() || adding}
            aria-label={tn("add")}
            title={tn("add")}
          >
            {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!contactId ? null : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          </div>
        ) : notes.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">{tn("empty")}</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((note) => (
              <NoteItem
                key={note.id}
                note={note}
                author={authorName(note.user_id)}
                editorName={note.edited_by ? authorName(note.edited_by) : null}
                canManage={canManage(note)}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NoteItem({
  note,
  author,
  editorName,
  canManage,
  onSave,
  onDelete,
}: {
  note: ContactNote;
  author: string;
  editorName: string | null;
  canManage: boolean;
  onSave: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const tn = useTranslations("Inbox.notesPanel");
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const long = isLong(note.note_text);

  async function save() {
    const text = draft.trim();
    if (!text || busy) return;
    if (text === note.note_text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const ok = await onSave(note.id, text);
    setBusy(false);
    if (ok) setEditing(false);
  }

  async function remove() {
    setBusy(true);
    const ok = await onDelete(note.id);
    // On success the row is removed from the list; on failure stay put.
    if (!ok) setBusy(false);
  }

  return (
    <li className="rounded-lg bg-muted px-3 py-2">
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-foreground">{author}</p>
          <p className="text-[10px] text-muted-foreground">
            {stamp(note.created_at)}
            {note.edited_at ? (
              <span
                className="ml-1 italic"
                title={tn("editedTitle", { time: stamp(note.edited_at), name: editorName ?? author })}
              >
                · {tn("edited")}
              </span>
            ) : null}
          </p>
        </div>
        {canManage && !editing && !confirming ? (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => {
                setDraft(note.note_text);
                setEditing(true);
              }}
              aria-label={tn("edit")}
              title={tn("edit")}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={tn("delete")}
              title={tn("delete")}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            maxLength={NOTE_MAX_CHARS}
            rows={Math.min(8, Math.max(3, draft.split("\n").length))}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(false)} disabled={busy}>
              <X className="h-3 w-3" />
              {tn("cancel")}
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => void save()} disabled={busy || !draft.trim()}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {tn("save")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={cn(
              "mt-1.5 whitespace-pre-wrap break-words text-xs text-foreground",
              long && !expanded && "line-clamp-4",
            )}
          >
            {note.note_text}
          </p>
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 text-[11px] font-medium text-primary hover:underline"
            >
              {expanded ? tn("showLess") : tn("showMore")}
            </button>
          ) : null}
        </>
      )}

      {confirming ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
          <span className="text-[11px] text-foreground">{tn("deleteConfirm")}</span>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setConfirming(false)} disabled={busy}>
              {tn("cancel")}
            </Button>
            <Button variant="destructive" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void remove()} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : tn("delete")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
