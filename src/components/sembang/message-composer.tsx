"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Code2, Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MentionTextarea, type MentionTextareaHandle } from "@/components/tickets/ticket-mention-textarea";
import { useAccountMembers } from "@/hooks/use-account-members";
import { SEMBANG_MAX_BYTES, uploadSembangFile } from "@/lib/storage/upload-sembang-file";

export interface PendingSembangAttachment {
  storagePath: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

interface MessageComposerProps {
  channelId: string;
  channelName: string;
  onSend: (
    body: string,
    mentions: string[],
    attachments: PendingSembangAttachment[],
    parentMessageId?: string,
  ) => Promise<boolean> | boolean;
  disabled?: boolean;
  /** Migration 099. Set when this composer posts thread replies instead of
   *  top-level channel messages (thread-panel.tsx) — threaded through to
   *  every `onSend` call so one handler can serve both cases. */
  parentMessageId?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wraps `MentionTextarea` with an attach-file button and a send button.
 *  Auto-grow behavior mirrors the Inbox composer's `min-h-16` convention
 *  (adjustHeight: grow from ~2 lines up to ~6 before scrolling). */
export function MessageComposer({
  channelId,
  channelName,
  onSend,
  disabled,
  parentMessageId,
}: MessageComposerProps) {
  const t = useTranslations("Sembang.composer");
  const { members } = useAccountMembers();

  const [text, setText] = useState("");
  const [mentionedIds, setMentionedIds] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<PendingSembangAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<MentionTextareaHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset the draft when switching channels — a half-typed message in one
  // channel shouldn't bleed into another.
  useEffect(() => {
    setText("");
    setMentionedIds(new Set());
    setAttachments([]);
  }, [channelId]);

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > SEMBANG_MAX_BYTES) {
        toast.error(t("fileTooLarge", { max: Math.round(SEMBANG_MAX_BYTES / 1024 / 1024) }));
        return;
      }
      setUploading(true);
      try {
        const uploaded = await uploadSembangFile(channelId, file);
        setAttachments((prev) => [
          ...prev,
          {
            storagePath: uploaded.path,
            filename: uploaded.filename,
            sizeBytes: uploaded.sizeBytes,
            mimeType: uploaded.mimeType,
          },
        ]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("uploadFailed"));
      } finally {
        setUploading(false);
      }
    },
    [channelId, t],
  );

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((a) => a.storagePath !== path));
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || sending || uploading) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed, Array.from(mentionedIds), attachments, parentMessageId);
      if (ok !== false) {
        setText("");
        setMentionedIds(new Set());
        setAttachments([]);
      }
    } finally {
      setSending(false);
    }
  }, [text, attachments, mentionedIds, sending, uploading, onSend, parentMessageId]);

  // Code-block button: `MentionTextareaHandle` only exposes `focus()`, not
  // a cursor/selection API, so this wraps the whole current draft in a
  // fence rather than inserting at the caret — see SPEC-P1.md's frontend
  // item 5 ("don't block on making this pixel-perfect"). A manually-typed
  // fence still renders correctly either way.
  const handleInsertCodeFence = useCallback(() => {
    setText((prev) => (prev.trim() ? "```\n" + prev + "\n```" : "```\n\n```"));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  return (
    <div className="border-t border-border bg-card p-3.5">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.storagePath}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-foreground"
            >
              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="max-w-40 truncate">{a.filename}</span>
              <span className="text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(a.storagePath)}
                aria-label={t("removeAttachmentAriaLabel", { filename: a.filename })}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled || uploading}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("attachAriaLabel")}
          onClick={handlePickFile}
          disabled={disabled || uploading}
          className="mb-0.5 shrink-0"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("codeBlockAriaLabel")}
          title={t("codeBlockAriaLabel")}
          onClick={handleInsertCodeFence}
          disabled={disabled}
          className="mb-0.5 shrink-0"
        >
          <Code2 className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <MentionTextarea
            ref={textareaRef}
            value={text}
            onValueChange={setText}
            onMention={(userId) => setMentionedIds((prev) => new Set(prev).add(userId))}
            members={members}
            placeholder={t("placeholder", { channel: channelName })}
            rows={1}
            disabled={disabled}
            onSubmit={handleSend}
            aria-label={t("inputAriaLabel")}
            // Auto-grow via CSS `field-sizing: content` — the same
            // mechanism the house Textarea component uses — rather than a
            // second, JS-driven adjustHeight() reimplementation, since
            // MentionTextarea's ref only exposes `focus()`. Resting height
            // (~2 lines) and the growth cap mirror the Inbox composer's
            // min-h-16 / ~140px constants.
            className="field-sizing-content min-h-16 max-h-36 resize-none overflow-y-auto"
          />
        </div>

        <Button
          type="button"
          size="icon"
          aria-label={t("sendAriaLabel")}
          onClick={handleSend}
          disabled={disabled || sending || uploading || (!text.trim() && attachments.length === 0)}
          className="mb-0.5 shrink-0"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
