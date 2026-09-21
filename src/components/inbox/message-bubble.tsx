"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
  Lock,
  ChevronDown,
  BookOpen,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { EmailHtmlView } from "./email-html-view";
import { useTranslations } from "next-intl";
import { useCapability } from "@/hooks/use-auth";
import { CHANNEL_ICONS } from "./channel-icons";
import { FailedMessageNotice } from "./failed-message-notice";
import { parseAiSourcesNote } from "@/lib/inbox/kb-agent";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /** Resolved display name of `message.sender_id`, for internal comments
   *  only — every other bubble conveys "who" through left/right alignment
   *  alone, but a full-width comment card needs an explicit author line. */
  authorLabel?: string;
  /**
   * Sender's display name (contact name for a customer bubble, agent/bot
   * name for an outbound one) shown just above the bubble. The parent
   * only passes this on the first bubble of a same-sender run, so it
   * reads as a group header rather than repeating on every message.
   */
  senderLabel?: string;
  /** True for the most recently received/sent Email(MS365)/Gmail
   *  message in this thread — it defaults expanded; every earlier one
   *  defaults collapsed to a one-line preview (EmailBodyContent). */
  isLatestEmail?: boolean;
  /** Sends a failed outbound message again. Only passed for a saved
   *  failed row; a bubble that was never saved has nothing to resend. */
  onResend?: () => void;
  /** Removes a failed outbound message from the chat. */
  onDeleteFailed?: () => void;
  /** A resend of this message is in flight. */
  resending?: boolean;
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3 w-3 text-red-400" />
        </span>
      );
    default:
      return null;
  }
}

/** An Email(MS365)/Gmail message whose source was HTML (migration 061)
 *  — defaults to the rendered view, with a toggle down to the plain-
 *  text fallback (useful for copy/paste, or if the rendering looks
 *  off for a particular email). For every message except the thread's
 *  most recent one, collapsed to a one-line preview — the way a real
 *  email client keeps older history out of the way until you open it.
 *  Rendered inside the full-width "email card" shell in MessageBubble
 *  below, not a chat bubble — the card's own left accent already
 *  carries the sender color-coding. */
function EmailBodyContent({
  message,
  t,
  isLatestEmail,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  isLatestEmail: boolean;
}) {
  const [expanded, setExpanded] = useState(isLatestEmail);
  const [showHtml, setShowHtml] = useState(true);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 py-0.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {message.content_text || t("unsupported")}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setShowHtml((v) => !v)}
        className="mb-1 text-[10px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {showHtml ? t("viewPlainText") : t("viewFormatted")}
      </button>
      {showHtml ? (
        <EmailHtmlView html={message.content_html!} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
          {message.content_text}
        </p>
      )}
    </div>
  );
}

function MessageContent({
  message,
  t,
  isAgent,
  isLatestEmail,
  onOpenMedia,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  /** Outbound bubbles sit on the primary fill — badges must invert. */
  isAgent: boolean;
  isLatestEmail: boolean;
  onOpenMedia?: (messageId: string) => void;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case "text":
      if (message.content_html) {
        return <EmailBodyContent message={message} t={t} isLatestEmail={isLatestEmail} />;
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case "template":
      // Templates are almost always outbound, where the bubble fill IS
      // `primary` — so the old `bg-primary/20 text-primary` chip was
      // primary-on-primary and invisible. Paired with a null
      // content_text (issue #483) that rendered a bubble with nothing
      // in it at all. Invert on the primary fill, and fall back to the
      // template's name when we have no stored body (legacy rows sent
      // before the fix).
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              isAgent
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          ) : (
            message.template_name && (
              <p className="mt-1 break-words text-sm italic opacity-80">
                {message.template_name}
              </p>
            )
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  authorLabel,
  senderLabel,
  isLatestEmail = false,
  onResend,
  onDeleteFailed,
  resending = false,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");
  // Reuses the same channel labels the thread header's badge already
  // uses — no new i18n keys needed across the 4 locale files.
  const tChannel = useTranslations("Inbox.messageThread");
  const tKnowledge = useTranslations("Knowledge.agent");
  // Source links open the Knowledge page: only offer them with menu.knowledge.
  const canOpenKnowledge = useCapability("menu.knowledge");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;
  const notSent = isAgent && message.status === "failed";

  // Internal comments are deliberately NOT a left/right chat bubble —
  // that shape reads as "part of the WhatsApp conversation," which is
  // exactly what a comment isn't. A full-width amber card makes it
  // unmistakable at a glance that this never reached the customer.
  if (message.is_internal) {
    // The note the AI leaves after an auto-reply: which articles it
    // answered from. Internal rows never reach the customer, so this is
    // for agents only.
    const sourcesNote = parseAiSourcesNote(message.content_text);
    if (sourcesNote) {
      return (
        <div className="flex justify-center px-2">
          <div className="flex w-full max-w-[85%] flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{tKnowledge("aiAnsweredFrom")}</span>
            {sourcesNote.sources.map((source, i) => (
              <span key={`${source.id ?? source.title}-${i}`} className="inline-flex items-center">
                {source.id && canOpenKnowledge ? (
                  <a
                    href={`/knowledge/${source.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    {source.title}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{source.title}</span>
                )}
                {i < sourcesNote.sources.length - 1 ? "," : ""}
              </span>
            ))}
            <span className="ml-auto text-[10px] text-amber-600/70 dark:text-amber-400/70">{time}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center px-2">
        <div className="w-full max-w-[85%] rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <Lock className="h-3 w-3" />
            {t("internalComment")}
            {authorLabel && <span className="normal-case">· {authorLabel}</span>}
            <span className="ml-auto normal-case text-amber-600/70 dark:text-amber-400/70">
              {time}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
            {message.content_text}
          </p>
          {message.status === "failed" && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-red-400">
              <XCircle className="h-3 w-3" />
              {t("commentNotPosted")}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Rendered-HTML email (migration 061) gets its own full-width "email
  // card" shell instead of a colored chat bubble — a stacked reading
  // pane like a real email client's thread view, not a WhatsApp-style
  // left/right bubble. Color-identifies the sender via a left accent
  // bar (blue for the customer, the app's primary color for you)
  // instead of a filled background, since the card itself stays a
  // neutral surface so the HTML body renders with its own true colors.
  if (message.content_type === "text" && message.content_html) {
    const accentColor = isAgent ? "var(--primary)" : "#2f6fed";
    return (
      <div
        className={cn(
          "w-full overflow-hidden rounded-lg border bg-card",
          notSent ? "border-red-500/50" : "border-border",
        )}
        style={{ borderLeft: `3px solid ${accentColor}` }}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
            {senderLabel ?? (isAgent ? t("you") : t("customer"))}
          </span>
          {message.ai_generated && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          {(() => {
            const ChannelIcon = CHANNEL_ICONS[message.channel_type];
            return (
              <span title={tChannel(`channel.${message.channel_type}`)} className="shrink-0">
                <ChannelIcon className="h-3 w-3 text-muted-foreground" />
              </span>
            );
          })()}
          <span className="shrink-0 text-[10px] text-muted-foreground">{time}</span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
        <div className="px-3 py-2">
          <EmailBodyContent message={message} t={t} isLatestEmail={isLatestEmail} />
        </div>
        {notSent && (
          <FailedMessageNotice
            message={message}
            onResend={onResend}
            onDelete={onDeleteFailed}
            resending={resending}
            wide
          />
        )}
        {reactions && reactions.length > 0 && onToggleReaction && (
          <div className="border-t border-border/60 px-3 py-1.5">
            <MessageReactions
              reactions={reactions}
              currentUserId={currentUserId}
              onToggle={onToggleReaction}
            />
          </div>
        )}
      </div>
    );
  }

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      {senderLabel && (
        <span className="mb-0.5 px-1 text-[10px] font-medium text-muted-foreground">
          {senderLabel}
        </span>
      )}
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
          notSent && "ring-2 ring-red-500/60",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        <MessageContent
          message={message}
          t={t}
          isAgent={isAgent}
          isLatestEmail={isLatestEmail}
          onOpenMedia={onOpenMedia}
        />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          {/* Per-message channel icon (migration 048) — a merged
              conversation can interleave WhatsApp and Web Widget
              messages, so each bubble needs its own indicator rather
              than relying on the thread-level badge alone. */}
          {(() => {
            const ChannelIcon = CHANNEL_ICONS[message.channel_type];
            return (
              <span title={tChannel(`channel.${message.channel_type}`)}>
                <ChannelIcon
                  className={cn(
                    "h-2.5 w-2.5",
                    isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
                  )}
                />
              </span>
            );
          })()}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
      </div>
      {notSent && (
        <FailedMessageNotice
          message={message}
          onResend={onResend}
          onDelete={onDeleteFailed}
          resending={resending}
        />
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
