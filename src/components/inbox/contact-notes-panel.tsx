"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { toast } from "sonner";
import { Loader2, Plus, StickyNote } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import type { ContactNote } from "@/types";

/**
 * Customer notes for the contact in the open chat: an add box pinned at
 * the top and the notes below it, newest first, scrolling on their own.
 * Lives under the ticket history in the column beside the chat, so an
 * agent can read a customer's tickets and notes while talking to them.
 */
export function ContactNotesPanel({ contactId }: { contactId: string | null }) {
  const t = useTranslations("Inbox.sidebar");
  const tn = useTranslations("Inbox.notesPanel");
  const { accountId } = useAuth();
  const canWrite = useCan("send-messages");

  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!contactId) return;
    const { data, error } = await createClient()
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false });
    if (error) console.error("[ContactNotesPanel] load failed:", error);
    setNotes((data as ContactNote[]) ?? []);
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

  async function handleAdd() {
    const text = draft.trim();
    if (!contactId || !accountId || !text || adding) return;
    setAdding(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: session?.user?.id,
        note_text: text,
      })
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
              <li key={note.id} className="rounded-lg bg-muted px-3 py-2">
                <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                  {note.note_text}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
