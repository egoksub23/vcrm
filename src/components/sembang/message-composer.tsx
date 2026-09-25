"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Bold, Code2, Italic, List, Loader2, Mic, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MentionTextarea, type MentionTextareaHandle } from "@/components/tickets/ticket-mention-textarea";
import { useAccountMembers } from "@/hooks/use-account-members";
import { SEMBANG_MAX_BYTES, uploadSembangFile } from "@/lib/storage/upload-sembang-file";
import { readChannelDraft, readThreadDraft, writeChannelDraft, writeThreadDraft } from "@/lib/sembang/draft-storage";
import { RecordingBar } from "@/components/inbox/recording-bar";
import { useVoiceRecorder } from "@/lib/media/use-voice-recorder";

/** Hard cap on a single voice recording — mirrors the Inbox composer's cap. */
const MAX_RECORDING_SECONDS = 5 * 60;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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

  // Clear the composer when switching channels — a half-typed message in
  // one channel shouldn't bleed into another. Runs before the draft
  // restore below (declaration order — React fires effects in order),
  // so a saved draft for the NEW channel isn't wiped out by this clear.
  useEffect(() => {
    setText("");
    setMentionedIds(new Set());
    setAttachments([]);
    setAlsoInChannel(false);
  }, [channelId]);

  // Restore a saved draft for this channel (or this thread, if
  // `parentMessageId` is set) right after the clear above. Mentions/
  // attachments/alsoInChannel are deliberately NOT restored — only the
  // plain text is persisted (keeping this a "don't lose what I typed"
  // safety net, not a full compose-state snapshot).
  useEffect(() => {
    const saved = parentMessageId ? readThreadDraft(parentMessageId) : readChannelDraft(channelId);
    if (saved) setText(saved);
  }, [channelId, parentMessageId]);

  // Debounced save — every keystroke would be wasteful, and immediate
  // per-keystroke writes to localStorage can visibly jank on low-end
  // devices. 400ms mirrors the search debounce already used elsewhere
  // in Sembang (channel-thread.tsx's SEARCH_DEBOUNCE_MS).
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (parentMessageId) writeThreadDraft(parentMessageId, text);
      else writeChannelDraft(channelId, text);
    }, 400);
    return () => window.clearTimeout(id);
  }, [text, channelId, parentMessageId]);

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

  // Voice recording — same encode/mic state machine the Inbox composer
  // uses (src/lib/media/use-voice-recorder.ts), uploaded through the same
  // uploadSembangFile() helper any other attachment goes through. Stopping
  // attaches the take rather than sending it immediately, so it can be
  // reviewed/removed like any other attachment before Send.
  const {
    recording,
    recordSeconds,
    micAnalyser,
    micDevices,
    micDeviceId,
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
    switchDevice: switchMicrophone,
  } = useVoiceRecorder({
    disabled: disabled || uploading || sending,
    maxSeconds: MAX_RECORDING_SECONDS,
    maxBytes: SEMBANG_MAX_BYTES,
    onRecorded: async (file) => {
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
    onError: (kind) => {
      if (kind === "tooLong") toast.error(t("recordingTooLong"));
      else if (kind === "unsupported") toast.error(t("recordingUnsupported"));
      else if (kind === "lost") toast.error(t("microphoneLost"));
      else toast.error(t("microphoneDenied"));
    },
  });

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
        // Clear the saved draft immediately rather than waiting on the
        // debounced save effect above — a fast send-then-navigate could
        // otherwise leave a stale "already sent" draft behind (the
        // debounce's pending timeout gets cancelled by the channel/
        // thread switch before it ever fires).
        if (parentMessageId) writeThreadDraft(parentMessageId, "");
        else writeChannelDraft(channelId, "");
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
    channelId,
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

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />

      {recording ? (
        // Recording bar — replaces the composer while the mic is live.
        <RecordingBar
          analyser={micAnalyser}
          elapsed={formatDuration(recordSeconds)}
          max={formatDuration(MAX_RECORDING_SECONDS)}
          seconds={recordSeconds}
          devices={micDevices}
          deviceId={micDeviceId}
          onSwitchDevice={(id) => void switchMicrophone(id)}
          onCancel={cancelRecording}
          onStop={stopRecording}
          t={t}
        />
      ) : (
      /* The thread-reply composer (showAlsoInChannelOption is only ever
          true there) gets a taller layout: the formatting toolbar sits
          above a full-width textarea instead of squeezed into the same
          row, and Send moves to its own row below — there's real column
          width to spend here, unlike the main channel composer's
          space-constrained single-row layout, which is left unchanged. */
      showAlsoInChannelOption ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("attachAriaLabel")}
              onClick={handlePickFile}
              disabled={disabled || uploading}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("micAriaLabel")}
              title={t("micAriaLabel")}
              onClick={() => void startRecording()}
              disabled={disabled || uploading || sending}
            >
              <Mic className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("boldAriaLabel")}
              title={t("boldAriaLabel")}
              onClick={handleBold}
              disabled={disabled}
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
            >
              <Code2 className="h-4 w-4" />
            </Button>
          </div>

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
            className="field-sizing-content min-h-32 max-h-64 w-full resize-none overflow-y-auto"
          />

          <div className="flex justify-end">
            <Button
              type="button"
              size="icon"
              aria-label={t("sendAriaLabel")}
              onClick={handleSend}
              disabled={disabled || sending || uploading || (!text.trim() && attachments.length === 0)}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-2">
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
            aria-label={t("micAriaLabel")}
            title={t("micAriaLabel")}
            onClick={() => void startRecording()}
            disabled={disabled || uploading || sending}
            className="mb-0.5 shrink-0"
          >
            <Mic className="h-4 w-4" />
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
      ))}
    </div>
  );
}
