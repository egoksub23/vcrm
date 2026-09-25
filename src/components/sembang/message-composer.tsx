"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Bold, Code2, Italic, List, Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
    /** Migration 101. Only ever passed by the thread-reply composer
     *  instance (see `showAlsoInChannelOption` below) — a pure additive,
     *  backward-compatible extension; the main channel composer never
     *  passes a 5th argument. */
    alsoInChannel?: boolean,
  ) => Promise<boolean> | boolean;
  disabled?: boolean;
  /** Migration 099. Set when this composer posts thread replies instead of
   *  top-level channel messages (thread-panel.tsx) — threaded through to
   *  every `onSend` call so one handler can serve both cases. */
  parentMessageId?: string;
  /** Migration 101. Only set `true` by thread-panel.tsx's reply composer
   *  instance — a top-level message can't have `alsoInChannel` (the DB
   *  trigger rejects it), so the main channel composer never passes this.
   *  When true, renders a "Also send to #<channelName>" checkbox near the
   *  send button (Slack's own reply-composer affordance). */
  showAlsoInChannelOption?: boolean;
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
  showAlsoInChannelOption,
}: MessageComposerProps) {
  const t = useTranslations("Sembang.composer");
  const { members } = useAccountMembers();

  const [text, setText] = useState("");
  const [mentionedIds, setMentionedIds] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<PendingSembangAttachment[]>([]);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
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
    setAlsoInChannel(false);
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
      const ok = await onSend(
        trimmed,
        Array.from(mentionedIds),
        attachments,
        parentMessageId,
        showAlsoInChannelOption ? alsoInChannel : undefined,
      );
      if (ok !== false) {
        setText("");
        setMentionedIds(new Set());
        setAttachments([]);
        setAlsoInChannel(false);
      }
    } finally {
      setSending(false);
    }
  }, [
    text,
    attachments,
    mentionedIds,
    sending,
    uploading,
    onSend,
    parentMessageId,
    showAlsoInChannelOption,
    alsoInChannel,
  ]);

  // Code-block button: kept as a whole-draft wrap (not a cursor insertion)
  // per SPEC-P1.md's frontend item 5 — a manually-typed fence still renders
  // correctly either way, and it predates `MentionTextareaHandle` gaining
  // `wrapSelection`/`insertLinePrefix` (migration 101), which the three
  // buttons below use instead for real cursor-position insertion.
  const handleInsertCodeFence = useCallback(() => {
    setText((prev) => (prev.trim() ? "```\n" + prev + "\n```" : "```\n\n```"));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Migration 101 — rich-text-lite toolbar. Bold/italic wrap the current
  // selection (or insert a pre-selected placeholder word when nothing is
  // selected); list prefixes the current line. NOTE: this composer already
  // has a working emoji picker (`MentionTextarea` renders its own
  // `EmojiPicker`, wired to real cursor insertion via `useEmojiShortcut`) —
  // these three buttons are additional, not a second emoji button.
  const handleBold = useCallback(() => {
    textareaRef.current?.wrapSelection("**", "**", "bold");
  }, []);
  const handleItalic = useCallback(() => {
    textareaRef.current?.wrapSelection("_", "_", "italic");
  }, []);
  const handleList = useCallback(() => {
    textareaRef.current?.insertLinePrefix("- ");
  }, []);

  return (
    <div className="border-t border-border bg-card p-3.5">
      {showAlsoInChannelOption && (
        <label className="mb-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={alsoInChannel} onCheckedChange={(v) => setAlsoInChannel(v === true)} />
          {t("alsoInChannelLabel", { channel: channelName })}
        </label>
      )}
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
          aria-label={t("boldAriaLabel")}
          title={t("boldAriaLabel")}
          onClick={handleBold}
          disabled={disabled}
          className="mb-0.5 shrink-0"
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("italicAriaLabel")}
          title={t("italicAriaLabel")}
          onClick={handleItalic}
          disabled={disabled}
          className="mb-0.5 shrink-0"
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("listAriaLabel")}
          title={t("listAriaLabel")}
          onClick={handleList}
          disabled={disabled}
          className="mb-0.5 shrink-0"
        >
          <List className="h-4 w-4" />
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
            // min-h-16 / ~140px constants. The thread-reply instance
            // (showAlsoInChannelOption is only ever true there) rests
            // noticeably taller, matching Slack's own reply composer.
            className={
              showAlsoInChannelOption
                ? "field-sizing-content min-h-32 max-h-64 resize-none overflow-y-auto"
                : "field-sizing-content min-h-16 max-h-36 resize-none overflow-y-auto"
            }
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
