"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  X,
  Loader2,
  Sparkles,
  MessageSquareDashed,
  Zap,
  Lock,
  BookOpen,
  AtSign,
  ChevronDown,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton, readOnlyTitle } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload, interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";
import type { ChannelType, InteractiveMessagePayload, Profile, QuickReply } from "@/types";
import type {
  ArticleDraftSeed,
  KnowledgeAttachment,
  KnowledgeSearchResult,
  KnowledgeSource,
} from "@/lib/knowledge-types";
import { kbHtmlToChannelText, plainTextToKbHtml } from "@/lib/knowledge-format";
import {
  appendBelow,
  appendLinkLines,
  parseKbCommand,
  planKbFile,
  stageKbFiles,
  type StagedKbFile,
} from "@/lib/inbox/kb-agent";
import { onKbDraft, onKbInsert } from "@/lib/inbox/kb-bus";
import { dragHasFiles, droppedImages, pastedImages } from "@/lib/media/clipboard-images";
import { ImagePrepareError, prepareImageForUpload } from "@/lib/media/prepare-image";
import { KnowledgePanel } from "./knowledge-panel";
import { FileChip, KnowledgeCard, useKnowledgeSearch } from "./knowledge-shared";
import { PastedImageChip } from "./pasted-image-chip";
import { RecordingBar } from "./recording-bar";
import {
  activeMicrophoneId,
  listMicrophones,
  openMicrophone,
  readSavedMicrophone,
  saveMicrophone,
  type MicrophoneOption,
} from "@/lib/media/microphone";
import { CHANNEL_ICONS } from "./channel-icons";
import { RichTextEditor } from "./rich-text-editor";
import { EmojiPicker } from "@/components/emoji/emoji-picker";
import { useEmojiShortcut } from "@/components/emoji/use-emoji-shortcut";
import type { Editor } from "@tiptap/react";
import { escapeHtml } from "@/lib/email/build-quote-html";

/** Media content types an agent can send from the composer. */
export type ComposerMediaKind = "image" | "video" | "document" | "audio";

/** Supabase Storage bucket holding agent-sent chat attachments (migration 023). */
export const CHAT_MEDIA_BUCKET = "chat-media";

/** Meta caps media captions at 1024 chars. Enforced here and in the send route. */
export const MEDIA_CAPTION_MAX = 1024;

/** Hard cap on a single voice recording so it can't blow the upload/
 *  transcode limits — auto-stops the recorder when reached. */
const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  /** Public chat-media URL Meta fetches at send time. */
  mediaUrl: string;
  /** Storage object path — lets the caller GC the object if the send fails. */
  path: string;
  /** Optional caption (image/video/document only). */
  caption?: string;
  /** Original file name — surfaced to the recipient for documents. */
  filename?: string;
  replyToId?: string;
  /** The object belongs to something else (a knowledge base article), so a
   *  failed send must NOT delete it from the bucket. */
  keepObject?: boolean;
}

interface ReplyDraft {
  /** Internal UUID of the message being replied to — sent back through onSend. */
  id: string;
  authorLabel: string;
  preview: string;
}

// Mirrors the chat-media bucket's allowed_mime_types (migration 023) for
// the file picker so unsupported files are rejected before upload rather
// than failing with a confusing Storage error. Audio has no picker — it's
// captured via the recorder.
const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  /** Storage path — used to GC the object if the draft is discarded. */
  path: string;
  filename: string;
  caption: string;
}

/** "Message" goes to the selected channel; "Comment" posts internally,
 *  teammates only (respond.io's "Comment" mode, P0 gap-analysis item);
 *  "Snippets" and "Knowledge" open a panel that slides up over the chat
 *  (the reply box stays put). */
type ComposerMode = "message" | "comment" | "snippets" | "knowledge";

interface MessageComposerProps {
  conversationId: string;
  /** The conversation's current channel (last_channel_type rollup) —
   *  the channel selector's default pick. Also gates the WhatsApp/Meta-
   *  only affordances (templates, interactive buttons/lists, media
   *  attach) together with whatever the agent actually selects below. */
  channelType: ChannelType;
  /** Every channel this conversation has a message on (migration 048's
   *  merge-by-contact can span several) — offered in the channel
   *  selector so the agent can pick which one a reply goes out on,
   *  instead of it always following `channelType`. A single-entry list
   *  hides the selector entirely (nothing to choose between). */
  availableChannels: ChannelType[];
  sessionExpired: boolean;
  /** `html` is only ever set for an Email(MS365)/Gmail send made with
   *  the WYSIWYG editor — the plain-text `text` is still always sent
   *  as the fallback every other caller/channel already relies on. */
  onSend: (
    text: string,
    replyToId?: string,
    channel?: ChannelType,
    html?: string,
  ) => void | boolean | Promise<boolean | void>;
  onSendMedia: (
    payload: SendMediaPayload,
    channel?: ChannelType,
  ) => void | boolean | Promise<boolean | void>;
  onSendInteractive: (
    payload: InteractiveMessagePayload,
    replyToId?: string,
    channel?: ChannelType,
  ) => void;
  onSendComment: (text: string, mentions: string[]) => void;
  /** Account teammates offered by the @mention autocomplete. */
  mentionCandidates?: Profile[];
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  /** The customer's recent messages — what the Knowledge tab searches on
   *  until the agent types something. */
  knowledgeQuery?: string;
  /** The contact's language code, so answers in it rank first. */
  contactLanguage?: string | null;
  /** Opens the "Add to knowledge base" dialog (owned by the thread). */
  onAddToKnowledge?: (seed: ArticleDraftSeed) => void;
}

const NO_FILES: StagedKbFile[] = [];
const NO_SOURCES: KnowledgeSource[] = [];

/** Plain text as email paragraphs: one <p> per blank-line-separated block,
 *  single newlines kept as <br>. */
function plainToParagraphHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Worker that encodes mic input to Ogg/Opus entirely in the browser
 *  (vendored from opus-recorder into /public). Recording client-side in a
 *  Meta-accepted format means no server ffmpeg / transcode step. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  channelType,
  availableChannels,
  sessionExpired: whatsappSessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onSendComment,
  mentionCandidates = [],
  onOpenTemplates,
  replyTo,
  onClearReply,
  knowledgeQuery = "",
  contactLanguage,
  onAddToKnowledge,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");
  const tk = useTranslations("Knowledge.agent");
  const canWriteKnowledge = useCapability("knowledge.draft");

  // ---- Channel selector ------------------------------------------------
  // Defaults to the conversation's rollup channel; the agent can pick a
  // different one this conversation has also used (respond.io-style).
  //
  // Two things need to reset this, independently:
  //  - The conversation itself changes (switching threads) — always
  //    re-snap to the new thread's rollup channel, discarding whatever
  //    was picked in the previous one.
  //  - `channelType` (the rollup) changes WHILE the same conversation
  //    stays open — e.g. the customer sends a new inbound message on a
  //    different channel than the one the agent had this open on.
  //    Without this, the agent could see a fresh WhatsApp message land
  //    in an already-open thread and still have their reply silently
  //    go out on whatever channel was selected before (issue: a
  //    contact's reply defaulted to Web Widget right after they'd just
  //    messaged in on WhatsApp). This only applies when the agent
  //    hasn't manually picked a channel for THIS conversation yet —
  //    once they have, their choice is respected until they switch
  //    threads, so an incoming message never clobbers an intentional
  //    pick mid-reply.
  const [selectedChannel, setSelectedChannel] = useState<ChannelType>(channelType);
  // The 24-hour customer-service window is a WhatsApp rule. Email, web chat,
  // Messenger and Instagram have no template fallback, so never lock them.
  const sessionExpired = whatsappSessionExpired && selectedChannel === "whatsapp";
  const manualChannelPickRef = useRef(false);
  useEffect(() => {
    manualChannelPickRef.current = false;
    setSelectedChannel(channelType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);
  useEffect(() => {
    if (!manualChannelPickRef.current) {
      setSelectedChannel(channelType);
    }
  }, [channelType]);
  const handleSelectChannel = useCallback((ch: ChannelType) => {
    manualChannelPickRef.current = true;
    setSelectedChannel(ch);
  }, []);

  // Media attach works on every channel, the web widget included (Web
  // Widget v2: photos, video, voice notes and files reach the visitor as
  // ordinary message rows). Templates and interactive buttons/lists are
  // Meta concepts with no Messenger/Instagram/widget equivalent (different
  // quick-reply shape, no pre-approved template system at all) —
  // WhatsApp-only until that's built out separately.
  const supportsMedia = true;
  const supportsTemplatesAndInteractive = selectedChannel === "whatsapp";

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  // Which article an AI draft is being written from (its card shows the spinner).
  const [draftingId, setDraftingId] = useState<string | null>(null);
  // Knowledge base files staged above the box, and the articles the last AI
  // draft was based on. Tied to a conversation so switching threads never
  // carries one chat's files into another.
  const [kb, setKb] = useState<{ cid: string; files: StagedKbFile[]; sources: KnowledgeSource[] }>({
    cid: conversationId,
    files: NO_FILES,
    sources: NO_SOURCES,
  });
  const kbFiles = kb.cid === conversationId ? kb.files : NO_FILES;
  const draftSources = kb.cid === conversationId ? kb.sources : NO_SOURCES;
  const updateKb = useCallback(
    (fn: (cur: { files: StagedKbFile[]; sources: KnowledgeSource[] }) => {
      files: StagedKbFile[];
      sources: KnowledgeSource[];
    }) => {
      setKb((prev) => {
        const cur = prev.cid === conversationId ? prev : { files: NO_FILES, sources: NO_SOURCES };
        return { cid: conversationId, ...fn(cur) };
      });
    },
    [conversationId],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const kbRef = useRef(kb);
  useEffect(() => {
    kbRef.current = kb;
  }, [kb]);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // ---- Message vs. Comment vs. Snippets mode --------------------------
  const [mode, setMode] = useState<ComposerMode>("message");
  const isComment = mode === "comment";
  const isSnippets = mode === "snippets";
  const isKnowledge = mode === "knowledge";
  /** Snippets and Knowledge both replace the textarea with a list. */
  const isPicker = isSnippets || isKnowledge;
  const composerRef = useRef<HTMLDivElement>(null);

  // ---- WYSIWYG editor for Email(MS365)/Gmail replies -------------------
  // Only these two channels have anything resembling formatted HTML mail
  // to compose — every other channel is plain text (WhatsApp/Messenger/
  // Instagram have no rich-formatting concept, and the web widget renders
  // customer-facing text only). `text` still tracks the editor's plain-
  // text derivation (via onChangeHtml's second arg) so the rest of the
  // send path — validation, the optimistic bubble, every non-email
  // channel — keeps working exactly as before without a parallel state.
  const isEmailChannel =
    !isComment && (selectedChannel === "email" || selectedChannel === "gmail");
  const [emailHtml, setEmailHtml] = useState("");
  const emailEditorRef = useRef<Editor | null>(null);
  const handleEmailChange = useCallback((html: string, plain: string) => {
    setEmailHtml(html);
    setText(plain);
  }, []);
  // Ids the agent picked from the @mention dropdown. Best-effort: if they
  // hand-edit the inserted "@Name" text afterward, this can drift from
  // what's literally in the textarea — an accepted simplification rather
  // than building a token-aware rich-text editor for this.
  const [mentionedIds, setMentionedIds] = useState<Set<string>>(new Set());
  // Non-null (possibly empty string) while the cursor sits right after an
  // unterminated "@query" — drives the autocomplete dropdown below.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  const switchMode = useCallback(
    (next: ComposerMode) => {
      if (next === mode) return;
      setMode(next);
      setMentionQuery(null);
      // A reply-to draft only makes sense for a WhatsApp message; carrying
      // it into Comment mode would silently vanish since comments don't
      // thread, which is more confusing than just clearing it up front.
      if (next === "comment") onClearReply?.();
    },
    [mode, onClearReply],
  );

  // Detect an unterminated "@query" right before the caret whenever the
  // text changes in Comment mode, and drive the autocomplete off it.
  useEffect(() => {
    if (!isComment) {
      setMentionQuery(null);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const match = before.match(/(?:^|\s)@(\w*)$/);
    setMentionQuery(match ? match[1] : null);
  }, [text, isComment]);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return mentionCandidates
      .filter((p) => p.full_name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, mentionCandidates]);

  const insertMention = useCallback((candidate: Profile) => {
    const el = textareaRef.current;
    setText((prev) => {
      const cursor = el?.selectionStart ?? prev.length;
      const before = prev.slice(0, cursor);
      const after = prev.slice(cursor);
      const atIndex = before.lastIndexOf("@");
      if (atIndex === -1) return prev;
      const newBefore = `${before.slice(0, atIndex)}@${candidate.full_name} `;
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(newBefore.length, newBefore.length);
      });
      return newBefore + after;
    });
    setMentionedIds((prev) => new Set(prev).add(candidate.user_id));
    setMentionQuery(null);
  }, []);

  // Manual trigger for agents who'd rather click than type "@" — inserts
  // "@" at the caret (or appends it) and opens the same dropdown.
  const openMentionPicker = useCallback(() => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = `${needsSpace ? " " : ""}@`;
    const next = before + insert + text.slice(cursor);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = before.length + insert.length;
      el?.setSelectionRange(pos, pos);
    });
    setMentionQuery("");
  }, [text]);

  // Interactive-message builder dialog + quick-reply picker.
  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);

  // ---- Inline snippet panel (Snippets mode) ---------------------------
  // Fetched on demand rather than eagerly — most composer sessions never
  // open it, and it can change between visits (someone else added one).
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
  const snippetListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isSnippets) return;
    let cancelled = false;
    setQuickRepliesLoading(true);
    void (async () => {
      try {
        // usable=1: only approved snippets. A proposal that waits for a
        // reviewer (migration 084) is never offered for sending.
        const res = await fetch("/api/quick-replies?usable=1", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setQuickReplies((data.quick_replies as QuickReply[]) ?? []);
        }
      } finally {
        if (!cancelled) setQuickRepliesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSnippets]);

  // Always open the list scrolled to the top — a taller list from a
  // prior session (or the composer's own layout shifting as it grows
  // into Snippets mode) shouldn't leave the agent looking at whatever
  // happened to be scrolled into view.
  useEffect(() => {
    if (isSnippets && snippetListRef.current) {
      snippetListRef.current.scrollTop = 0;
    }
  }, [isSnippets, quickReplies]);

  // Media attachment state. `draft` holds an uploaded-but-not-yet-sent
  // attachment; `busy` covers the upload/transcode window.
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  // Mirror of `draft` for the unmount cleanup, which can't read render
  // state. Kept in sync below so navigating away with a staged-but-unsent
  // attachment GCs the orphaned object.
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Best-effort GC of a staged object the user never sent. Fire-and-forget.
  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  // Voice recording state. The recorder encodes Ogg/Opus in-browser
  // (opus-recorder) so there's no server-side transcode.
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The microphone stream and audio graph are opened here (not by the
  // recorder) so the agent can pick the input and see a live level.
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [micDevices, setMicDevices] = useState<MicrophoneOption[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);

  // Viewers (read-only role) can browse the inbox but never send.
  // For solo users this is always true — single-owner accounts pass
  // every capability — so the disabled branch is a no-op there.
  const canSend = useCapability("messages.send");
  // Internal comments (notes) are conversation work, not a customer message: conversations.manage.
  const canComment = useCapability("conversations.manage");
  // "Draft with AI" calls the AI draft route: ai.use.
  const canUseAi = useCapability("ai.use");
  // Saving a snippet: snippets.manage (goes live) or snippets.propose (waits
  // for a reviewer, migration 084).
  const canManageSnippets = useCapability("snippets.manage");
  const canProposeSnippets = useCapability("snippets.propose");
  const tApprovals = useTranslations("Approvals");
  // Source chips open the Knowledge page: only link them with menu.knowledge.
  const canOpenKnowledge = useCapability("menu.knowledge");
  const readOnly = isComment ? !canComment : !canSend;
  const sendGateReason = isComment ? "add internal notes" : "send messages";
  // Media (like free-form text) is only allowed inside the 24h window.
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Turns the microphone off (the browser's recording indicator goes away).
  const releaseMic = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    void ctx?.close().catch(() => {});
    setMicAnalyser(null);
  }, []);

  // Pasted images the agent never sent are the agent's own uploads: switching
  // to another conversation or leaving the page deletes them (an article's
  // files are shared with the article and are never deleted here).
  useEffect(() => {
    const cid = conversationId;
    return () => {
      const cur = kbRef.current;
      if (cur.cid !== cid) return;
      for (const f of cur.files) {
        if (f.origin !== "paste") continue;
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
        removeStaged(f.storagePath);
      }
    };
  }, [conversationId, removeStaged]);

  // Tear down any live recording + timer on unmount so a mid-record
  // navigation doesn't leak the mic, and GC a staged-but-unsent
  // attachment so it doesn't orphan in the bucket.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      void recorderRef.current?.stop().catch(() => {});
      releaseMic();
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, releaseMic, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max 4 lines (~96px)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  // ---- Knowledge base: insert an article, and the /kb picker ----------

  // An article picked from the Knowledge tab, the right-hand column or /kb:
  // its text lands in the reply box (formatted for the channel) and its
  // files are staged as chips. Nothing is sent. `replace` swaps out the whole
  // box, used when the box only held the "/kb …" command.
  const insertKnowledge = useCallback(
    (r: KnowledgeSearchResult, replace = false) => {
      const channel = selectedChannel;
      const emailish = channel === "email" || channel === "gmail";
      const editor = emailEditorRef.current;
      switchMode("message");
      // An email reply keeps the article's pictures inside the text, so they
      // are not staged again as attachments; every other channel gets the text
      // and then each picture as its own message, in order.
      const inlineInText = emailish && mode !== "comment" && !!editor;
      if (emailish && mode !== "comment" && editor) {
        // Email keeps the article's formatting: its HTML goes into the editor.
        const html = r.body_html || plainTextToKbHtml(r.body);
        if (replace || !editor.getText().trim()) editor.commands.setContent(html);
        else editor.chain().focus("end").insertContent(html).run();
        setEmailHtml(editor.getHTML());
        setText(editor.getText());
        editor.commands.focus("end");
      } else {
        const body = kbHtmlToChannelText(r.body_html, r.body, emailish ? "web_widget" : channel);
        setText((prev) => (replace ? body : appendBelow(prev, body)));
        requestAnimationFrame(() => {
          adjustHeight();
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
      }
      updateKb((cur) => ({
        files: stageKbFiles(cur.files, r.attachments ?? [], "kb", { skipInline: inlineInText }),
        sources: replace ? NO_SOURCES : cur.sources,
      }));
    },
    [selectedChannel, mode, switchMode, adjustHeight, updateKb],
  );

  // Typing "/kb" (optionally with a search) as the whole message opens the
  // same article picker; Escape closes it until the text changes.
  const kbCommand = mode === "message" ? parseKbCommand(text) : null;
  const [kbDismissedFor, setKbDismissedFor] = useState<string | null>(null);
  const kbSlashOpen = kbCommand !== null && kbDismissedFor !== text;
  const kbSlash = useKnowledgeSearch({
    query: kbCommand?.query || knowledgeQuery,
    contactLanguage,
    enabled: kbSlashOpen,
  });
  useEffect(() => {
    if (!kbSlashOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setKbDismissedFor(text);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [kbSlashOpen, text]);

  // Emoji: the ":" shortcut and the smiley button. The box is disabled exactly
  // when it already was (read-only role, expired session outside a comment);
  // the /kb list owns Enter while it is open, so ":" stays quiet then. An email
  // reply is a Tiptap editor, so it only gets the button.
  const emojiFieldDisabled = (!isComment && sessionExpired) || readOnly;
  const emoji = useEmojiShortcut({
    fieldRef: textareaRef,
    value: text,
    onValueChange: setText,
    enabled: !emojiFieldDisabled && !isEmailChannel && !kbSlashOpen,
    onAfter: adjustHeight,
  });

  // Sends the text, then each staged knowledge base file as its own message,
  // in that order. Files a channel cannot carry go as link lines in the text
  // instead, so none is ever dropped. If the text fails, the files stay
  // staged (nothing lost); a file that fails goes back to staging to retry.
  const sendWithKbFiles = useCallback(
    (
      trimmed: string,
      files: StagedKbFile[],
      opts: { replyToId?: string; channel: ChannelType; html?: string },
    ) => {
      const plans = files.map((file) => ({ file, plan: planKbFile(opts.channel, file) }));
      const linked = plans.filter((p) => p.plan.mode === "link").map((p) => p.file);
      const outText = appendLinkLines(trimmed, linked);
      // A linked file changes the plain text; the email HTML only matters
      // when the channel is email, which always carries real attachments.
      void (async () => {
        if (outText) {
          const ok = await Promise.resolve(onSend(outText, opts.replyToId, opts.channel, opts.html));
          if (ok === false) {
            updateKb((cur) => ({ ...cur, files: [...files, ...cur.files.filter((f) => !files.includes(f))] }));
            return;
          }
        }
        const failed: StagedKbFile[] = [];
        for (const { file, plan } of plans) {
          if (plan.mode !== "media") continue;
          const ok = await Promise.resolve(
            onSendMedia(
              {
                kind: plan.kind,
                mediaUrl: file.url,
                path: file.storagePath,
                filename: plan.kind === "document" ? file.fileName : undefined,
                // An article image's caption goes out as the media caption.
                caption: plan.kind === "image" ? file.caption?.trim() || undefined : undefined,
                // The object stays put on a failed send: the chip goes back to
                // staging and is retried (a pasted image is deleted only when its
                // chip is discarded).
                keepObject: true,
              },
              opts.channel,
            ),
          );
          if (ok === false) failed.push(file);
        }
        if (failed.length > 0) {
          updateKb((cur) => ({
            ...cur,
            files: [...cur.files, ...failed.filter((f) => !cur.files.some((c) => c.url === f.url))],
          }));
        }
      })();
    },
    [onSend, onSendMedia, updateKb],
  );

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    const files = isComment ? NO_FILES : kbFiles;
    // Comments bypass the 24h WhatsApp session window entirely — they
    // never leave the account, so there's nothing for that window to gate.
    if ((!trimmed && files.length === 0) || sending || (!isComment && sessionExpired)) return;
    // A pasted image that is still uploading has no link to send yet.
    if (files.some((f) => f.uploading)) return;

    setSending(true);
    try {
      if (isComment) {
        onSendComment(trimmed, Array.from(mentionedIds));
        setMentionedIds(new Set());
      } else if (files.length > 0) {
        sendWithKbFiles(trimmed, files, {
          replyToId: replyTo?.id,
          channel: selectedChannel,
          html: isEmailChannel ? emailHtml : undefined,
        });
      } else {
        onSend(trimmed, replyTo?.id, selectedChannel, isEmailChannel ? emailHtml : undefined);
      }
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      if (isEmailChannel) {
        emailEditorRef.current?.commands.clearContent();
        setEmailHtml("");
      }
      if (!isComment) updateKb(() => ({ files: NO_FILES, sources: NO_SOURCES }));
    } finally {
      setSending(false);
    }
  }, [
    text,
    sending,
    sessionExpired,
    isComment,
    kbFiles,
    onSend,
    onSendComment,
    sendWithKbFiles,
    updateKb,
    mentionedIds,
    replyTo?.id,
    selectedChannel,
    isEmailChannel,
    emailHtml,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // The ":emoji" list, while open, owns Up/Down/Enter/Tab/Escape.
      if (emoji.handleKeyDown(e)) return;
      // While the mention dropdown is open, Enter/Tab picks the top
      // match instead of sending — standard autocomplete behavior.
      if (mentionQuery !== null && mentionMatches.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        insertMention(mentionMatches[0]);
        return;
      }
      if (e.key === "Escape" && mentionQuery !== null) {
        setMentionQuery(null);
        return;
      }
      // While the /kb picker is open, Enter inserts the top match instead
      // of sending "/kb …" to the customer.
      if (e.key === "Enter" && !e.shiftKey && kbSlashOpen) {
        e.preventDefault();
        const top = kbSlash.results[0];
        if (top) insertKnowledge(top, true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [emoji, handleSend, mentionQuery, mentionMatches, insertMention, kbSlashOpen, kbSlash.results, insertKnowledge]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      emoji.handleChange(e);
      adjustHeight();
    },
    [emoji, adjustHeight]
  );

  // Ask the AI assistant for a suggested reply and drop it into the
  // composer for the agent to edit + send. Read-only server-side —
  // nothing is sent until the agent hits Send.
  const handleDraft = useCallback(async (articleId?: string) => {
    if (drafting) return;
    setDrafting(true);
    setDraftingId(articleId ?? null);
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `article_id` asks the AI to write from that one article.
        body: JSON.stringify({
          conversation_id: conversationId,
          ...(articleId ? { article_id: articleId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("draftFailed"));
        }
        return;
      }
      const draftText = typeof data.draft === "string" ? data.draft.trim() : "";
      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }
      // The articles the draft was based on, and the files of those that are
      // sent along with an AI answer: shown as chips and staged like Insert.
      // A new draft replaces the previous draft's files but keeps any the
      // agent inserted by hand.
      const sources = Array.isArray(data.sources)
        ? (data.sources as KnowledgeSource[]).filter(
            (src) => src && typeof src.id === "string" && typeof src.title === "string",
          )
        : [];
      const draftFiles = Array.isArray(data.attachments)
        ? (data.attachments as KnowledgeAttachment[]).filter((a) => a && a.url && a.send_with_ai !== false)
        : [];
      updateKb((cur) => ({
        files: stageKbFiles(
          cur.files.filter((f) => f.origin !== "ai"),
          draftFiles,
          "ai",
        ),
        sources,
      }));
      if (isEmailChannel) {
        // The plain textarea's ref/height logic below doesn't apply —
        // drop the draft into the Tiptap doc instead, one <p> per
        // blank-line-separated paragraph so multi-paragraph drafts
        // don't collapse into a single run-on line.
        const html = plainToParagraphHtml(draftText);
        emailEditorRef.current?.commands.setContent(html);
        emailEditorRef.current?.commands.focus("end");
        setEmailHtml(html);
        setText(draftText);
        return;
      }
      setText(draftText);
      // Let the textarea grow to fit and drop the cursor at the end so
      // the agent can tweak immediately.
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
      setDraftingId(null);
    }
  }, [drafting, conversationId, adjustHeight, t, isEmailChannel, updateKb]);

  // The right-hand Knowledge tab hands articles over through window events.
  // A read-only viewer has no reply box to put them in.
  useEffect(() => {
    if (readOnly) return;
    const offInsert = onKbInsert((article) => insertKnowledge(article));
    const offDraft = onKbDraft((articleId) => {
      switchMode("message");
      void handleDraft(articleId);
    });
    return () => {
      offInsert();
      offDraft();
    };
  }, [readOnly, insertKnowledge, switchMode, handleDraft]);

  // ---- Interactive message + quick replies --------------------------

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    [],
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onSendInteractive(interactivePayload, replyTo?.id, selectedChannel);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply, selectedChannel]);

  // Persist the current builder payload as a reusable interactive snippet.
  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const title = window
      .prompt(t("quickReplyNamePrompt"))
      ?.trim();
    if (!title) return;
    setSavingQuickReply(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }
      toast.success(data.pending ? tApprovals("sentForApproval") : t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t, tApprovals]);

  // A picked quick reply: text fills the composer; interactive opens the
  // builder pre-filled so the agent can tweak before sending.
  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      switchMode("message");
      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }
      const body = qr.content_text ?? "";
      // Separate the snippet from any existing draft with a newline so the
      // words don't run together ("Thanks" + "we'll…" → "Thankswe'll…").
      setText((prev) =>
        prev && !/\s$/.test(prev) ? `${prev}\n${body}` : `${prev}${body}`,
      );
      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [switchMode, openInteractiveBuilder, adjustHeight],
  );

  // Upload a captured file to chat-media and stage it as a draft.
  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      // Per-kind ceiling mirrors Meta's caps (image 5 MB, etc.) so we
      // reject before upload rather than orphaning an object that Meta
      // would then refuse at send.
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];
      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024,
          )} MB.`,
        );
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        // Replacing an existing draft? GC the previous object first.
        removeStaged(draftRef.current?.path);
        setDraft({ kind, mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged],
  );

  const handlePicked = useCallback(
    (kind: "image" | "video" | "document", file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload],
  );

  // ---- Pasted / dropped images ------------------------------------------

  // Takes a picture off the clipboard (or a drop) into the same chips as an
  // article's files: a thumbnail above the box, uploaded to chat-media (the
  // flat folder, not the article's kb/ one) after being shrunk, and sent as its
  // own image message after the text. Several stack in the order pasted.
  const explainPasteError = useCallback(
    (err: unknown): string => {
      if (err instanceof ImagePrepareError) {
        if (err.code === "unsupported") return tk("pasteUnsupported");
        if (err.code === "tooLarge") {
          return tk("pasteTooLarge", { max: Math.round((err.maxBytes ?? MEDIA_MAX_BYTES_BY_KIND.image) / 1024 / 1024) });
        }
        return tk("pasteUnreadable");
      }
      return err instanceof Error && err.message ? err.message : tk("pasteFailed");
    },
    [tk],
  );

  const stagePastedImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || inputsDisabled || isComment) return;
      const cid = conversationId;
      const items = files.map((file) => ({
        file,
        key: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        preview: URL.createObjectURL(file),
      }));
      const chips: StagedKbFile[] = items.map((i) => ({
        key: i.key,
        fileName: tk("pastedImage"),
        mimeType: i.file.type || "image/png",
        sizeBytes: i.file.size,
        url: "",
        storagePath: "",
        kind: "image",
        origin: "paste",
        uploading: true,
        previewUrl: i.preview,
      }));
      updateKb((cur) => ({ ...cur, files: [...cur.files, ...chips] }));

      const patchChip = (key: string, fields: Partial<StagedKbFile>) =>
        setKb((prev) =>
          prev.cid !== cid ? prev : { ...prev, files: prev.files.map((f) => (f.key === key ? { ...f, ...fields } : f)) },
        );
      const dropChip = (key: string) =>
        setKb((prev) => (prev.cid !== cid ? prev : { ...prev, files: prev.files.filter((f) => f.key !== key) }));

      // One after the other so the chips stay in the order they were pasted.
      for (const { file, key, preview } of items) {
        try {
          const prepared = await prepareImageForUpload(file, { maxBytes: MEDIA_MAX_BYTES_BY_KIND.image });
          const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, prepared);
          const stillWanted =
            conversationIdRef.current === cid && kbRef.current.files.some((f) => f.key === key);
          if (!stillWanted) {
            // The chip was discarded, or the agent moved to another chat, while it uploaded.
            removeStaged(path);
            continue;
          }
          patchChip(key, {
            url: publicUrl,
            storagePath: path,
            fileName: prepared.name,
            mimeType: prepared.type,
            sizeBytes: prepared.size,
            uploading: false,
            previewUrl: undefined,
          });
        } catch (err) {
          dropChip(key);
          toast.error(explainPasteError(err));
        } finally {
          URL.revokeObjectURL(preview);
        }
      }
    },
    [inputsDisabled, isComment, conversationId, tk, updateKb, removeStaged, explainPasteError],
  );

  // Discarding a chip: a pasted image is the agent's own upload and is deleted
  // (best-effort); an article's file is shared with the article and stays.
  const discardKbFile = useCallback(
    (f: StagedKbFile) => {
      if (f.origin === "paste") {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
        removeStaged(f.storagePath);
      }
      updateKb((cur) => ({ ...cur, files: cur.files.filter((x) => x.key !== f.key) }));
    },
    [removeStaged, updateKb],
  );

  // A paste anywhere in the composer that carries a picture and no text. The
  // email editor handles its own paste (below), so it is skipped here.
  const handleComposerPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (inputsDisabled || isComment || isPicker) return;
      if ((e.target as HTMLElement).closest?.('[contenteditable="true"]')) return;
      const images = pastedImages(e.clipboardData?.files, e.clipboardData?.getData("text/plain"));
      if (images.length === 0) return;
      e.preventDefault();
      void stagePastedImages(images);
    },
    [inputsDisabled, isComment, isPicker, stagePastedImages],
  );
  const handleComposerDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (inputsDisabled || isComment || isPicker || !dragHasFiles(e.dataTransfer?.types)) return;
      // Allow the drop (the browser would otherwise open the picture).
      e.preventDefault();
    },
    [inputsDisabled, isComment, isPicker],
  );
  const handleComposerDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (inputsDisabled || isComment || isPicker) return;
      // Any dropped file is ours to take (otherwise the browser would open it
      // in place of the inbox); only pictures are staged.
      if (!dragHasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      const images = droppedImages(e.dataTransfer?.files);
      if (images.length === 0) {
        if ((e.dataTransfer?.files.length ?? 0) > 0) toast.error(tk("dropNotImage"));
        return;
      }
      void stagePastedImages(images);
    },
    [inputsDisabled, isComment, isPicker, stagePastedImages, tk],
  );

  // ---- Voice recording (client-side Ogg/Opus, no server transcode) ---

  // The encoded Ogg/Opus file from opus-recorder → upload as an audio
  // draft. WhatsApp renders Ogg/Opus as a playable voice note.
  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
      // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return; // cancelled / empty take
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }
      setBusy(true);
      try {
        const { publicUrl, path } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        removeStaged(draftRef.current?.path);
        setDraft({ kind: "audio", mediaUrl: publicUrl, path, filename: file.name, caption: "" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t],
  );

  // `micId` is a device picked in the recording bar; otherwise the last
  // remembered choice, otherwise the browser default.
  const startRecording = useCallback(
    async (micId?: string) => {
      if (inputsDisabled || busy) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
        toast.error(t("recordingUnsupported"));
        return;
      }
      try {
        const stream = await openMicrophone(micId ?? readSavedMicrophone());
        micStreamRef.current = stream;
        // If the device is unplugged mid-take, say so instead of sending silence.
        stream.getAudioTracks()[0]?.addEventListener("ended", () => {
          if (micStreamRef.current !== stream) return;
          toast.error(t("microphoneLost"));
          cancelledRef.current = true;
          clearTimer();
          setRecording(false);
          void recorderRef.current?.stop().catch(() => {});
          releaseMic();
        });
        // Labels are only readable now that access has been granted.
        setMicDevices(await listMicrophones().catch(() => []));
        setMicDeviceId(activeMicrophoneId(stream));

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        setMicAnalyser(analyser);

        // Lazy-load the encoder (≈400 KB worker) only when the user records,
        // keeping it out of the main bundle.
        const { default: Recorder } = await import("opus-recorder");
        const recorder = new Recorder({
          encoderPath: OPUS_ENCODER_PATH,
          numberOfChannels: 1,
          encoderApplication: 2048, // VOIP — tuned for speech
          encoderSampleRate: 48000,
          streamPages: false, // one callback with the complete file on stop
          sourceNode: source, // our own stream, so the chosen microphone is used
        });
        cancelledRef.current = false;
        recorder.ondataavailable = (bytes) => {
          if (cancelledRef.current) return;
          void finalizeRecording(bytes);
        };
        recorderRef.current = recorder;
        await recorder.start();
        setRecording(true);
        setRecordSeconds(0);
        timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
      } catch {
        void recorderRef.current?.stop().catch(() => {});
        recorderRef.current = null;
        releaseMic();
        toast.error(t("microphoneDenied"));
      }
    },
    [inputsDisabled, busy, finalizeRecording, clearTimer, releaseMic, t],
  );

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    // Turn the mic off once the encoder has flushed the take.
    void (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve()).finally(releaseMic);
  }, [clearTimer, releaseMic]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve()).finally(releaseMic);
  }, [clearTimer, releaseMic]);

  // Picking another microphone restarts the take on it (the abandoned take is
  // discarded) and remembers the choice for next time.
  const switchMicrophone = useCallback(
    async (id: string) => {
      if (!id || id === micDeviceId) return;
      saveMicrophone(id);
      cancelledRef.current = true;
      clearTimer();
      setRecording(false);
      await (recorderRef.current?.stop().catch(() => {}) ?? Promise.resolve());
      releaseMic();
      await startRecording(id);
    },
    [micDeviceId, clearTimer, releaseMic, startRecording],
  );

  // Auto-stop at the cap so a forgotten recording can't blow the
  // upload size limit.
  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  // ---- Draft send / discard -----------------------------------------

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia(
      {
        kind: draft.kind,
        mediaUrl: draft.mediaUrl,
        path: draft.path,
        // Audio takes no caption (Meta rejects it). Everything else: the
        // trimmed caption, or undefined when blank.
        caption:
          draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
        filename: draft.kind === "document" ? draft.filename : undefined,
        replyToId: replyTo?.id,
      },
      selectedChannel,
    );
    // The object is now owned by the sent message — clear without GC.
    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply, selectedChannel]);

  // Discard GCs the staged object — it was uploaded but never sent.
  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  // Clicking Reply on an email puts the cursor straight into the reply box
  // (at the top, Outlook style); the quoted chain sits below it.
  const replyToId = replyTo?.id;
  useEffect(() => {
    if (replyToId && isEmailChannel) emailEditorRef.current?.commands.focus("start");
  }, [replyToId, isEmailChannel]);

  // The slide-up panel closes on Escape or a click anywhere outside the
  // composer (the tab buttons live inside it, so they still work).
  useEffect(() => {
    if (!isPicker) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") switchMode("message");
    };
    const onDown = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
        switchMode("message");
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [isPicker, switchMode]);

  // ---- Render --------------------------------------------------------

  return (
    <div
      ref={composerRef}
      className="relative border-t border-border bg-card p-3.5"
      onPaste={handleComposerPaste}
      onDragOver={handleComposerDragOver}
      onDrop={handleComposerDrop}
    >
      {/* Snippets / Knowledge: a panel that slides UP from the reply box
          (over the chat) instead of replacing the textarea and pushing the
          composer taller. Closes on Escape, a click outside, or picking. */}
      {(isPicker || kbSlashOpen) && (
        <div className="absolute inset-x-0 bottom-full z-30 px-3.5 pb-2 duration-200 animate-in fade-in-0 slide-in-from-bottom-4">
          <div className="overflow-hidden rounded-xl bg-popover shadow-xl ring-1 ring-border">
            {isKnowledge ? (
        <KnowledgePanel
              suggestQuery={knowledgeQuery}
              contactLanguage={contactLanguage}
              canAdd={canWriteKnowledge && !!onAddToKnowledge}
              onInsert={(article) => insertKnowledge(article)}
              onDraft={(article) => {
                switchMode("message");
                void handleDraft(article.id);
              }}
              draftingId={draftingId}
              onAdd={() =>
                onAddToKnowledge?.({
                  content: text.trim() || undefined,
                  sourceConversationId: conversationId,
                })
              }
            />
            ) : isSnippets ? (
        <div
            ref={snippetListRef}
            className="max-h-72 overflow-y-auto"
          >
            {quickRepliesLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : quickReplies.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t("quickRepliesEmpty")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 p-1.5">
                {quickReplies.map((qr) => (
                  <li key={qr.id}>
                    <button
                      type="button"
                      onClick={() => handlePickQuickReply(qr)}
                      className="flex w-full items-start gap-2 rounded-md border border-transparent bg-card p-2 text-left hover:border-primary/50"
                    >
                      {qr.kind === "interactive" ? (
                        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {qr.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {qr.kind === "interactive" && qr.interactive_payload
                            ? interactivePayloadPreviewText(qr.interactive_payload)
                            : qr.content_text}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <p className="sticky top-0 z-10 border-b border-border bg-muted/90 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
                  {kbCommand?.query ? tk("slashHint") : tk("slashSuggested")}
                </p>
                {kbSlash.loading && kbSlash.results.length === 0 ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : !(kbCommand?.query || knowledgeQuery) ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tk("slashEmpty")}</p>
                ) : kbSlash.failed ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tk("loadFailed")}</p>
                ) : kbSlash.results.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tk("slashNoResults")}</p>
                ) : (
                  <ul className="flex flex-col gap-1 p-1.5">
                    {kbSlash.results.map((r) => (
                      <li key={r.id}>
                        <KnowledgeCard result={r} onInsert={(article) => insertKnowledge(article, true)} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* For email the quoted message goes BELOW the reply box (Outlook
          style: you type on top and scroll the chain underneath). */}
      {replyTo && !isEmailChannel && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}
      {sessionExpired && !isComment && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      {/* Message / Comment / Snippets mode toggle — a comment never
          reaches the customer, so it's kept visually and functionally
          distinct from the send path below; Snippets swaps the textarea
          for an inline, scrollable quick-reply list instead of opening a
          separate dialog. Hidden once a media draft or a live recording
          takes over the composer — those are always customer-facing
          sends. */}
      {!draft && !recording && (canSend || canComment) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
            <button
              type="button"
              onClick={() => switchMode("message")}
              disabled={!canSend}
              className={cn(
                "disabled:cursor-not-allowed disabled:opacity-50",
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                mode === "message" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("modeMessage")}
            </button>
            <button
              type="button"
              onClick={() => switchMode("comment")}
              disabled={!canComment}
              title={canComment ? undefined : readOnlyTitle("add internal notes")}
              className={cn(
                "disabled:cursor-not-allowed disabled:opacity-50",
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors",
                isComment
                  ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Lock className="h-3 w-3" />
              {t("modeComment")}
            </button>
            <button
              type="button"
              onClick={() => switchMode(isSnippets ? "message" : "snippets")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors",
                isSnippets
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Zap className="h-3 w-3" />
              {t("modeSnippets")}
            </button>
            <button
              type="button"
              onClick={() => switchMode(isKnowledge ? "message" : "knowledge")}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors",
                isKnowledge
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <BookOpen className="h-3 w-3" />
              {t("modeKnowledge")}
            </button>
          </div>

          {/* Channel selector — only when this conversation has actually
              used more than one channel; nothing to pick between
              otherwise. Hidden in Comment/Snippets mode, same as the
              rest of the send-path affordances below. */}
          {!isComment && availableChannels.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/70">
                {(() => {
                  const Icon = CHANNEL_ICONS[selectedChannel];
                  return <Icon className="size-3.5 shrink-0" />;
                })()}
                {t(`channel.${selectedChannel}`)}
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-border bg-popover">
                {availableChannels.map((ct) => {
                  const Icon = CHANNEL_ICONS[ct];
                  return (
                    <DropdownMenuItem key={ct} onClick={() => handleSelectChannel(ct)}>
                      <Icon className="mr-2 size-3.5 shrink-0" />
                      {t(`channel.${ct}`)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* Hidden file inputs driven by the attach menu. */}
      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {/* The articles an AI draft was based on, and the knowledge base files
          that go out after the text. Never shown for an internal comment. */}
      {!isComment && !recording && (draftSources.length > 0 || kbFiles.length > 0) && (
        <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
          {draftSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <BookOpen className="h-3 w-3 shrink-0 text-primary" />
              <span className="text-muted-foreground">{tk("basedOn")}</span>
              {draftSources.map((src) => {
                const chipBody = (
                  <>
                    <span className="shrink-0">{src.n}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{src.title}</span>
                  </>
                );
                return canOpenKnowledge ? (
                  <a
                    key={src.id}
                    href={`/knowledge/${src.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/15"
                    title={tk("openArticle")}
                  >
                    {chipBody}
                  </a>
                ) : (
                  <span
                    key={src.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                  >
                    {chipBody}
                  </span>
                );
              })}
            </div>
          )}
          {kbFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {kbFiles.map((f) =>
                f.origin === "paste" ? (
                  <PastedImageChip
                    key={f.key}
                    src={f.previewUrl || f.url}
                    label={tk("pastedImage")}
                    sizeBytes={f.sizeBytes}
                    uploading={!!f.uploading}
                    uploadingLabel={tk("pasteUploading")}
                    onRemove={() => discardKbFile(f)}
                    removeLabel={tk("removePastedImage")}
                  />
                ) : (
                  <FileChip
                    key={f.key}
                    file={{ file_name: f.fileName, kind: f.kind, size_bytes: f.sizeBytes }}
                    prefix={f.origin === "ai" ? tk("willAttach") : f.inline ? tk("articleImage") : tk("fromKnowledge")}
                    onRemove={() => discardKbFile(f)}
                    removeLabel={tk("removeFile", { name: f.fileName })}
                  />
                ),
              )}
            </div>
          )}
          {kbFiles.some((f) => planKbFile(selectedChannel, f).mode === "link") && (
            <p className="text-[10px] text-muted-foreground">{tk("linkFallback")}</p>
          )}
        </div>
      )}

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : recording ? (
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
        />
      ) : (
        <div className="relative flex items-end gap-2">
          {!isComment && (
            <>
              {/* Attach menu — photo / video / document / voice. Every
                  channel supports media now (the web widget since Web
                  Widget v2); `supportsMedia` stays the one switch to turn
                  the menu off for a future channel that cannot. */}
              {supportsMedia && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={inputsDisabled || busy}
                    title={
                      readOnly
                        ? t("readOnlyTitle")
                        : inputsDisabled
                          ? undefined
                          : t("attachMedia")
                    }
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Paperclip className="h-4 w-4" />
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="border-border bg-popover">
                    <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                      <ImageIcon className="mr-2 h-4 w-4" />
                      {t("photo")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                      <Video className="mr-2 h-4 w-4" />
                      {t("video")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => documentInputRef.current?.click()}>
                      <FileText className="mr-2 h-4 w-4" />
                      {t("document")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void startRecording()}>
                      <Mic className="mr-2 h-4 w-4" />
                      {t("voiceNote")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Interactive message builder — WhatsApp-only. Quick
                  replies moved to the Snippets tab above (no longer
                  behind this "+" menu). */}
              {supportsTemplatesAndInteractive && (
                <GatedButton
                  variant="ghost"
                  size="sm"
                  canAct={!readOnly}
                  gateReason={sendGateReason}
                  disabled={inputsDisabled}
                  title={readOnly ? undefined : t("interactiveMessage")}
                  className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => openInteractiveBuilder()}
                >
                  <MessageSquareDashed className="h-4 w-4" />
                </GatedButton>
              )}

              {supportsTemplatesAndInteractive && (
                <GatedButton
                  variant="ghost"
                  size="sm"
                  canAct={!readOnly}
                  gateReason={sendGateReason}
                  title={readOnly ? undefined : t("sendTemplate")}
                  className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  onClick={onOpenTemplates}
                >
                  <LayoutTemplate className="h-4 w-4" />
                </GatedButton>
              )}

              <GatedButton
                variant="ghost"
                size="sm"
                canAct={!readOnly && canUseAi}
                gateReason={readOnly ? sendGateReason : "use AI"}
                disabled={drafting}
                title={readOnly ? undefined : t("draftWithAI")}
                className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
                onClick={() => void handleDraft()}
              >
                {drafting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
              </GatedButton>
            </>
          )}

          {isComment && mentionCandidates.length > 0 && (
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={!readOnly}
              gateReason={sendGateReason}
              title={readOnly ? undefined : t("mentionSomeone")}
              className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
              onClick={openMentionPicker}
            >
              <AtSign className="h-4 w-4" />
            </GatedButton>
          )}

          {/* Emoji button. An email reply has its own in the editor toolbar. */}
          {!isEmailChannel && (
            <EmojiPicker
              disabled={emojiFieldDisabled}
              onPick={emoji.insertEmoji}
              returnFocusTo={() => textareaRef.current}
            />
          )}

          <div className="relative flex-1">
            {mentionQuery !== null && mentionMatches.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-56 overflow-hidden rounded-lg border border-border bg-popover shadow-md">
                {mentionMatches.map((p) => (
                  <button
                    key={p.user_id}
                    type="button"
                    onMouseDown={(e) => {
                      // mousedown (not click) fires before the textarea's
                      // blur, so the caret position insertMention reads is
                      // still valid.
                      e.preventDefault();
                      insertMention(p);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
                  >
                    <AtSign className="h-3 w-3 text-muted-foreground" />
                    <span className="truncate">{p.full_name}</span>
                  </button>
                ))}
              </div>
            )}
            {emoji.suggestions}
            {isEmailChannel ? (
              <RichTextEditor
                key={conversationId}
                emojiPicker
                onChangeHtml={handleEmailChange}
                onEditorReady={(editor) => {
                  emailEditorRef.current = editor;
                }}
                // A pasted picture becomes an attachment chip, not part of the text.
                onImageFiles={inputsDisabled ? undefined : (files) => void stagePastedImages(files)}
                placeholder={sessionExpired ? t("sessionExpiredPlaceholder") : t("typeEmailPlaceholder")}
                disabled={sessionExpired || readOnly}
              />
            ) : (
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onSelect={emoji.handleSelect}
                onBlur={emoji.handleBlur}
                placeholder={
                  readOnly
                    ? t("readOnlyPlaceholder")
                    : isComment
                      ? t("commentPlaceholder")
                      : sessionExpired
                        ? t("sessionExpiredPlaceholder")
                        : t("typeMessagePlaceholder")
                }
                disabled={(!isComment && sessionExpired) || readOnly}
                rows={1}
                // Textarea keeps its own inline title — the GatedButton
                // wrapping pattern doesn't apply to non-button inputs.
                // The placeholder text also surfaces the read-only state.
                title={readOnly ? t("readOnlyTitle") : undefined}
                className={cn(
                  "w-full resize-none rounded-xl border px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors",
                  isComment
                    ? "border-amber-500/40 bg-amber-500/5 focus:border-amber-500/70"
                    : "border-border bg-muted focus:border-primary/50",
                  ((!isComment && sessionExpired) || readOnly) && "cursor-not-allowed opacity-50"
                )}
              />
            )}
          </div>

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason={sendGateReason}
            disabled={
              (!text.trim() && (isComment || kbFiles.length === 0)) ||
              (!isComment && sessionExpired) ||
              sending ||
              (!isComment && kbFiles.some((f) => f.uploading))
            }
            onClick={handleSend}
            className={cn(
              "h-9 w-9 shrink-0 p-0 disabled:opacity-40",
              isComment ? "bg-amber-500 hover:bg-amber-500/90" : "bg-primary hover:bg-primary/90",
            )}
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {/* Hint sits outside the flex row so its height doesn't push
          `items-end` buttons below the textarea. Indented to line up
          under the textarea left edge. */}
      {!draft && !recording && !isComment && (
        <p className="mt-1 pl-[5.5rem] text-[10px] text-muted-foreground">
          {t("draftHint")}
        </p>
      )}
      {replyTo && isEmailChannel && (
        <div className="mt-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
            previewMaxHeightClass="max-h-[min(16rem,30vh)]"
          />
        </div>
      )}
      {!draft && !recording && isComment && (
        <p className="mt-1 pl-2 text-[10px] text-amber-600 dark:text-amber-400">
          {t("commentHint")}
        </p>
      )}

      {/* Interactive-message builder dialog. */}
      <Dialog open={interactiveOpen} onOpenChange={setInteractiveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("interactiveMessage")}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>
          <DialogFooter>
            {/* Saving a quick reply creates a snippet: snippets.manage, or a
                proposal for a reviewer with snippets.propose. */}
            {canManageSnippets || canProposeSnippets ? (
              <Button
                variant="outline"
                disabled={savingQuickReply}
                onClick={saveAsQuickReply}
              >
                {savingQuickReply ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="mr-1 h-4 w-4" />
                )}
                {t("saveAsQuickReply")}
              </Button>
            ) : null}
            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Staged-attachment preview with caption + send/discard. Declared at
 * module scope (not nested in MessageComposer) so React keeps it mounted
 * across the parent's re-renders — a nested component would remount the
 * caption input on every keystroke and drop focus.
 */
function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}
          {draft.kind === "video" && (
            <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />
          )}
          {draft.kind === "audio" && (
            <audio src={draft.mediaUrl} controls className="w-full" />
          )}
          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">{draft.filename}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) => onCaptionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}
        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto",
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
