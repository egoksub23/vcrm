import type { ChannelType, Message } from "@/types";
import type { KbAttachmentKind, KnowledgeAttachment } from "@/lib/knowledge-types";

// ============================================================
// Pure helpers behind the agent's knowledge base tools in the inbox:
// the search text built from the chat, the `/kb` trigger, the files that
// travel with an inserted article, and the internal "AI answered from"
// note. Kept free of React so they can be tested on their own.
// ============================================================

/** What the knowledge search runs on until the agent types something: the
 *  customer's last three messages, up to about 500 characters in all. */
export function buildKnowledgeQuery(
  messages: Pick<Message, "sender_type" | "is_internal" | "content_text">[],
): string {
  const picked: string[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < 3; i--) {
    const m = messages[i];
    const text = (m.content_text ?? "").trim();
    if (m.sender_type !== "customer" || m.is_internal || !text) continue;
    if (picked.length > 0 && chars + text.length > 500) break;
    picked.unshift(text.slice(0, 500));
    chars += text.length;
  }
  return picked.join("\n");
}

/** Typing `/kb` or `/kb yearly` (and nothing else) in the reply box opens
 *  the article picker. Returns the search text after it, or null when the
 *  box holds anything else. The whole box must be the command so a normal
 *  message that merely mentions "/kb" later is never hijacked. */
export function parseKbCommand(text: string): { query: string } | null {
  const m = /^\s*\/kb(?:\s([^\n]*))?$/i.exec(text);
  return m ? { query: (m[1] ?? "").trim() } : null;
}

// ---- Files that travel with an article ------------------------------

/** A knowledge base file staged above the reply box, sent after the text. */
export interface StagedKbFile {
  /** Stable id: the attachment id, or its URL. */
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Public chat-media URL. The object is shared with the article, so it is
   *  never deleted from the composer, even when a send fails. */
  url: string;
  /** Object path in the chat-media bucket (for the send payload only). */
  storagePath: string;
  kind: KbAttachmentKind;
  /** "kb" = the agent inserted an article; "ai" = the AI draft cited it;
   *  "paste" = the agent pasted or dropped an image into the reply box (its
   *  object is the agent's own, so removing the chip deletes it). */
  origin: "kb" | "ai" | "paste";
  /** An image's caption: the media caption when it is sent. */
  caption?: string | null;
  /** true = shown inside the article text (only ever set for an article's
   *  own images). */
  inline?: boolean;
  /** Still uploading: no `url` yet, and the message cannot be sent. */
  uploading?: boolean;
  /** A local picture to show while it uploads. */
  previewUrl?: string;
}

/** Adds an article's files to what is already staged, skipping any file
 *  that is already there (same URL), and keeping the order they were added. */
export function stageKbFiles(
  current: StagedKbFile[],
  attachments: (Pick<
    KnowledgeAttachment,
    "id" | "file_name" | "mime_type" | "size_bytes" | "url" | "storage_path" | "kind"
  > &
    Partial<Pick<KnowledgeAttachment, "inline" | "caption">>)[],
  origin: StagedKbFile["origin"],
  opts: { skipInline?: boolean } = {},
): StagedKbFile[] {
  const seen = new Set(current.map((f) => f.url));
  const next = [...current];
  for (const a of attachments) {
    if (!a.url || seen.has(a.url)) continue;
    // An email keeps an article's images inside its text: not attached again.
    if (opts.skipInline && a.inline) continue;
    seen.add(a.url);
    next.push({
      key: a.id || a.url,
      fileName: a.file_name,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      url: a.url,
      storagePath: a.storage_path ?? "",
      kind: a.kind,
      origin,
      caption: a.caption ?? null,
      inline: a.inline === true,
    });
  }
  return next;
}

export type KbSendKind = "image" | "video" | "audio" | "document";

/** How one staged file leaves on a channel: as a media message of `kind`,
 *  or as a link line in the text when the channel cannot carry it. */
export type KbFilePlan =
  | { mode: "media"; kind: KbSendKind }
  | { mode: "link" };

// What WhatsApp Cloud accepts per media kind; anything else goes as a
// document, which takes any file type.
const WA_IMAGE = new Set(["image/jpeg", "image/png"]);
const WA_VIDEO = new Set(["video/mp4", "video/3gpp"]);
const WA_AUDIO = new Set(["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"]);

/** Decides how to deliver one file on a channel. Never drops a file: when
 *  the channel has no way to carry it, the answer is a link. */
export function planKbFile(
  channel: ChannelType,
  file: Pick<StagedKbFile, "kind" | "mimeType">,
): KbFilePlan {
  const mime = file.mimeType.toLowerCase().split(";")[0].trim();
  switch (channel) {
    case "web_widget":
      // The widget has no media pipeline: text only.
      return { mode: "link" };
    case "instagram":
      // Instagram DMs carry image, video and audio, but not documents.
      return file.kind === "document" ? { mode: "link" } : { mode: "media", kind: file.kind };
    case "whatsapp":
      if (file.kind === "image") return { mode: "media", kind: WA_IMAGE.has(mime) ? "image" : "document" };
      if (file.kind === "video") return { mode: "media", kind: WA_VIDEO.has(mime) ? "video" : "document" };
      if (file.kind === "audio") return { mode: "media", kind: WA_AUDIO.has(mime) ? "audio" : "document" };
      return { mode: "media", kind: "document" };
    default:
      // Messenger, and email/Gmail (a real attachment on its own message).
      return { mode: "media", kind: file.kind };
  }
}

/** Appends "name: url" lines for files that cannot travel as media (an image
 *  with a caption is named by it). */
export function appendLinkLines(
  text: string,
  files: Pick<StagedKbFile, "fileName" | "url" | "caption">[],
): string {
  if (files.length === 0) return text;
  const lines = files.map((f) => `${f.caption?.trim() || f.fileName}: ${f.url}`).join("\n");
  const base = text.trimEnd();
  return base ? `${base}\n\n${lines}` : lines;
}

/** Joins new text under what the agent has already typed. */
export function appendBelow(prev: string, addition: string): string {
  return prev && !/\s$/.test(prev) ? `${prev}\n${addition}` : `${prev}${addition}`;
}

// ---- "AI answered from ..." internal note ----------------------------

export interface AiSourcesNote {
  sources: { title: string; id: string | null }[];
}

const NOTE_PREFIX = /^\s*(?:internal:\s*)?ai answered from\s*:?\s*/i;
const LINKED = /\[([^\]]+)\]\(\s*(?:kb:|\/knowledge\/)([0-9a-f-]{8,})\s*\)/gi;

/** Reads the internal comment the AI leaves after an auto-reply. Accepts
 *  `AI answered from: [Title](kb:<id>), [Other](kb:<id>)` (linkable) and the
 *  plain `AI answered from: Title, Other`. Null for any other comment. */
export function parseAiSourcesNote(text: string | null | undefined): AiSourcesNote | null {
  if (!text) return null;
  const m = NOTE_PREFIX.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length).trim();
  if (!rest) return null;

  const sources: AiSourcesNote["sources"] = [];
  for (const link of rest.matchAll(LINKED)) sources.push({ title: link[1].trim(), id: link[2] });
  if (sources.length > 0) return { sources };

  for (const part of rest.split(/\s*[,;]\s*/)) {
    const title = part.replace(/^["'“‘]+|["'”’.]+$/g, "").trim();
    if (title) sources.push({ title, id: null });
  }
  return sources.length > 0 ? { sources } : null;
}
