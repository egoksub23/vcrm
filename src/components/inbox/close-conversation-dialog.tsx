"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { EmojiTextarea } from "@/components/emoji/emoji-textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";

const NOTE_MAX_LEN = 1000;

export interface SuggestedLabel {
  id: string;
  name: string;
}

interface CloseConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `label` is the AI-suggested label the agent chose to apply, if any. */
  onConfirm: (note: string, label?: SuggestedLabel | null) => void;
  busy: boolean;
  /** >1 when closing several conversations at once (bulk close) — one
   *  shared note is applied to each. */
  count?: number;
  /** The conversation being closed. When set (single close), the dialog
   *  offers an AI-drafted note and label. */
  conversationId?: string | null;
}

/**
 * Shown when closing a conversation — klink.cloud parity
 * (docs.klink.cloud/settings/dispositions-and-wrap-up): closing requires
 * a wrap-up note. Unlike HandoffNoteDialog's note, this one is required —
 * "Close" stays disabled until there's non-whitespace text — matching the
 * `conversation_events_close_requires_note` DB CHECK (migration 065) that
 * enforces the same rule server-side.
 *
 * With AI set up, opening it asks the "closing note" job for a draft note
 * and one suggested existing label. The agent edits (or ignores) both
 * before closing, so the required note and the audit trail are unchanged.
 */
export function CloseConversationDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
  count = 1,
  conversationId = null,
}: CloseConversationDialogProps) {
  const t = useTranslations("Inbox.closeDialog");
  const locale = useLocale();
  const [note, setNote] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(true);
  const [aiError, setAiError] = useState<string | null>(null);
  const [label, setLabel] = useState<SuggestedLabel | null>(null);
  const [applyLabel, setApplyLabel] = useState(true);
  const noteRef = useRef("");
  noteRef.current = note;
  const seq = useRef(0);

  const aiEligible = count === 1 && !!conversationId && aiAvailable;

  async function draft(replaceExisting: boolean) {
    if (!conversationId) return;
    const mine = ++seq.current;
    setDrafting(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/closing-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, locale }),
      });
      const data = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) {
        // Not set up (or the job is off): quietly hide the AI bits.
        if (data.code === "ai_not_configured") setAiAvailable(false);
        else if (data.code !== "no_messages") setAiError(data.code === "budget_exceeded" ? t("aiBudget") : t("aiFailed"));
        return;
      }
      // Never overwrite something the agent already typed on open.
      if (replaceExisting || !noteRef.current.trim()) setNote(String(data.note ?? ""));
      setLabel(data.label ?? null);
      setApplyLabel(true);
    } catch {
      if (mine === seq.current) setAiError(t("aiFailed"));
    } finally {
      if (mine === seq.current) setDrafting(false);
    }
  }

  // Each time the dialog opens: start clean, then ask for a draft.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setNote("");
      setLabel(null);
      setAiError(null);
    }
  }
  useEffect(() => {
    if (open && aiEligible) void draft(false);
    return () => {
      // Abandon an in-flight draft when the dialog closes or the chat changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId]);

  const canConfirm = note.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {count > 1 ? t("titleBulk", { count }) : t("title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {count > 1 ? t("descriptionBulk", { count }) : t("description")}
          </DialogDescription>
        </DialogHeader>

        {aiEligible && (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5 text-primary" />}
              {drafting ? t("aiDrafting") : t("aiHint")}
            </span>
            <button
              type="button"
              onClick={() => void draft(true)}
              disabled={drafting || busy}
              className="font-medium text-primary hover:underline disabled:opacity-50"
            >
              {t("aiRedo")}
            </button>
          </div>
        )}

        <EmojiTextarea
          value={note}
          onValueChange={setNote}
          maxLength={NOTE_MAX_LEN}
          rows={4}
          placeholder={t("notePlaceholder")}
          disabled={busy}
          autoFocus
          className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60"
        />

        {aiError && <p className="text-xs text-amber-600 dark:text-amber-400">{aiError}</p>}

        {label && (
          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <input type="checkbox" checked={applyLabel} onChange={(e) => setApplyLabel(e.target.checked)} disabled={busy} />
            <span className="text-foreground">{t("applyLabel", { name: label.name })}</span>
          </label>
        )}

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => onConfirm(note.trim(), label && applyLabel ? label : null)} disabled={!canConfirm}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("closing")}
              </>
            ) : (
              t("close")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
