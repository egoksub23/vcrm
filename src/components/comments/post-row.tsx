"use client";

import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { Megaphone } from "lucide-react";

import { cn } from "@/lib/utils";
import { authorLabel, snippet, type InboxPost } from "@/lib/comments/threads";

import { chip, TONE } from "./chips";
import { PROVIDER_ICONS, PROVIDER_NAMES } from "./provider-icons";

/**
 * One row of the Comments list: a POST, not a comment. Platform icon on the post's picture, the caption, how many comments still
 * need an answer, the newest customer comment and when, and a dot when something arrived since the viewer last opened the post.
 */
export function CommentPostRow({
  post,
  active,
  unread,
  onSelect,
}: {
  post: InboxPost;
  active: boolean;
  /** Already decided by the caller (the open post never shows a dot). */
  unread: boolean;
  onSelect: (postId: string) => void;
}) {
  const t = useTranslations("Comments");
  const Icon = PROVIDER_ICONS[post.provider];
  const who = authorLabel({ author_name: post.last_author_name, author_username: post.last_author_username }) ?? t("unknownAuthor");
  const latest = snippet(post.last_comment_text, 120) || t("attachment");
  const when = post.last_provider_created_at ? formatDistanceToNow(new Date(post.last_provider_created_at), { addSuffix: false }) : "";

  return (
    <button
      type="button"
      onClick={() => onSelect(post.post_id)}
      aria-current={active ? "true" : undefined}
      data-post-row={post.post_id}
      className={cn(
        "flex w-full gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
        active && "bg-muted",
      )}
    >
      <div className="relative h-11 w-11 shrink-0">
        {post.media_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.media_url} alt="" className="h-11 w-11 rounded-md object-cover" loading="lazy" />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
            {post.source === "ad" ? <Megaphone className="h-4 w-4 text-muted-foreground" /> : <Icon className="h-5 w-5" />}
          </div>
        )}
        <Icon
          className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full ring-2 ring-card"
          aria-label={PROVIDER_NAMES[post.provider]}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("min-w-0 truncate text-sm text-foreground", unread && "font-semibold")}>
            {post.message?.trim() ? snippet(post.message, 70) : t("noCaption")}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{when}</span>
        </div>
        <p className="line-clamp-2 break-words text-xs text-muted-foreground">
          {t("latestFrom", { author: who, text: latest })}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {post.open_count > 0 && <span className={cn(chip, TONE.primary)}>{t("toDoCount", { count: post.open_count })}</span>}
          <span className={cn(chip, TONE.muted)}>{t("commentCount", { count: post.total_count })}</span>
          {post.source === "ad" && <span className={cn(chip, TONE.warn)}>{t("adPost")}</span>}
          {post.has_test && <span className={cn(chip, TONE.sample)}>{t("sample")}</span>}
        </div>
      </div>

      {unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" role="img" aria-label={t("unreadDot")} />}
    </button>
  );
}
