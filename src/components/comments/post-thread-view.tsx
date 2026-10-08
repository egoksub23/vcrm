"use client";

import { forwardRef, useMemo, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, ExternalLink, Megaphone, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  blockOpenIds,
  buildThread,
  entryComments,
  firstNewEntryIndex,
  groupAuthorBlocks,
  resolveReplyTarget,
  type BulkOp,
  type ReplyTarget,
  type ThreadComment,
  type ThreadEntry,
  type ThreadNode,
  type ThreadPost,
} from "@/lib/comments/threads";

import { AuthorBlock } from "./author-block";
import { BulkBar } from "./bulk-bar";
import { chip, TONE } from "./chips";
import { PROVIDER_ICONS, PROVIDER_NAMES } from "./provider-icons";
import { ReplyComposer } from "./reply-composer";
import { ThreadCommentItem, type CommentItemHandlers } from "./thread-comment";

export interface ThreadFailure {
  id: string;
  who: string;
  text: string;
  error: string;
}

type GroupOp = Extract<BulkOp, "resolve" | "spam" | "hide">;

export interface PostThreadViewProps {
  post: ThreadPost;
  comments: ThreadComment[];
  truncated: boolean;
  /** Customer comments that are new to this person (they get the "New" tag and the divider above the first). */
  newIds: ReadonlySet<string>;
  /** The comment a link pointed at: scrolled to and outlined. */
  highlightId: string | null;
  selected: ReadonlySet<string>;
  target: ReplyTarget | null;
  text: string;
  /** Per comment: the action running on it. `bulk` = a group or bulk action is running. */
  busyByComment: Readonly<Record<string, string>>;
  bulkBusy: boolean;
  sending: boolean;
  canWrite: boolean;
  canDelete: boolean;
  failures: ThreadFailure[];
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onBack: () => void;
  onText: (v: string) => void;
  onSend: () => void;
  onCancelReply: () => void;
  onClearSelection: () => void;
  onBulk: (op: GroupOp, ids: string[]) => void;
  onDismissFailures: () => void;
  handlers: CommentItemHandlers;
  /** Tests: show a block open / a confirmation open. */
  expandBlocks?: boolean;
  initialBulkConfirm?: GroupOp | null;
}

/**
 * A post and its comments as one conversation: the post card, then every comment oldest first with replies under the comment they answer,
 * one person's many open comments folded into a block, a "New" divider where the unread ones start, and the reply box and bulk bar at the
 * bottom. Presentational: the fetching, the selection and the actions live in PostThread.
 */
export const PostThreadView = forwardRef<HTMLDivElement, PostThreadViewProps>(function PostThreadView(props, scrollRef) {
  const {
    post,
    comments,
    truncated,
    newIds,
    highlightId,
    selected,
    target,
    text,
    busyByComment,
    bulkBusy,
    sending,
    canWrite,
    canDelete,
    failures,
    composerRef,
    handlers,
  } = props;
  const t = useTranslations("Comments");
  const Icon = PROVIDER_ICONS[post.provider];

  const roots = useMemo(() => buildThread(comments), [comments]);
  const entries = useMemo(() => groupAuthorBlocks(roots), [roots]);
  const newAt = useMemo(() => firstNewEntryIndex(entries, newIds), [entries, newIds]);
  const resolved = useMemo(() => resolveReplyTarget(target, comments), [target, comments]);
  const customerCount = comments.filter((c) => c.direction === "inbound" && c.status !== "deleted").length;
  const orphanIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (nodes: ThreadNode[]) => nodes.forEach((n) => (n.orphan && ids.add(n.comment.id), walk(n.replies)));
    walk(roots);
    return ids;
  }, [roots]);

  const renderNode = (node: ThreadNode, depth: number): ReactNode => (
    <ThreadBranch key={node.comment.id}>
      <ThreadCommentItem
        comment={node.comment}
        depth={depth}
        isNew={newIds.has(node.comment.id)}
        highlighted={highlightId === node.comment.id}
        checked={selected.has(node.comment.id)}
        targeted={resolved?.comment.id === node.comment.id}
        orphan={orphanIds.has(node.comment.id)}
        canWrite={canWrite}
        canDelete={canDelete}
        busy={busyByComment[node.comment.id] ?? (bulkBusy ? "bulk" : null)}
        handlers={handlers}
      />
      {node.replies.map((r) => renderNode(r, Math.min(depth + 1, 2)))}
    </ThreadBranch>
  );

  const renderEntry = (entry: ThreadEntry): ReactNode => {
    if (entry.kind === "node") return renderNode(entry.node, 0);
    const ids = blockOpenIds(entry);
    return (
      <AuthorBlock
        key={`block-${entry.key}`}
        label={entry.label}
        count={ids.length}
        canWrite={canWrite}
        busy={bulkBusy}
        hasNew={entryComments(entry).some((c) => newIds.has(c.id))}
        defaultExpanded={props.expandBlocks || entryComments(entry).some((c) => c.id === highlightId)}
        initialConfirm={props.initialBulkConfirm}
        onGroupAction={(op) => props.onBulk(op, ids)}
      >
        {entry.nodes.map((n) => renderNode(n, 0))}
      </AuthorBlock>
    );
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={props.onBack}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          aria-label={t("back")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Icon className="h-5 w-5 shrink-0" aria-label={PROVIDER_NAMES[post.provider]} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{PROVIDER_NAMES[post.provider]}</p>
          <p className="text-xs text-muted-foreground">
            {t("commentCount", { count: customerCount })}
            {post.source === "ad" ? ` · ${t("adPost")}` : ""}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-thread-scroll>
        <div className="flex gap-3 rounded-xl border border-border bg-card p-3" data-post-card>
          {post.media_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted">
              {post.source === "ad" ? <Megaphone className="h-5 w-5 text-muted-foreground" /> : <Icon className="h-6 w-6" />}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("onThisPost")}</p>
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">{post.message || t("noCaption")}</p>
            {post.permalink_url && (
              <a
                href={post.permalink_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {t("viewPost")} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>

        {truncated && <p className="text-center text-xs text-muted-foreground">{t("truncated", { count: comments.length })}</p>}

        <ul className="space-y-2" data-thread>
          {entries.map((entry, i) => (
            <ThreadBranch key={entry.kind === "node" ? entry.node.comment.id : `block-${entry.key}`}>
              {i === newAt && <NewDivider />}
              {renderEntry(entry)}
            </ThreadBranch>
          ))}
        </ul>

        {failures.length > 0 && (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs" data-bulk-failures>
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-destructive">{t("bulkFailedTitle", { count: failures.length })}</p>
              <button
                type="button"
                onClick={props.onDismissFailures}
                className="inline-flex items-center gap-1 rounded-md px-1 text-muted-foreground hover:text-foreground"
                aria-label={t("dismiss")}
              >
                <X className="h-3 w-3" />
                {t("dismiss")}
              </button>
            </div>
            <ul className="mt-1 space-y-0.5 text-foreground">
              {failures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.who}</span>
                  {f.text ? <span className="text-muted-foreground"> “{f.text}”</span> : null}
                  <span>: {f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {canWrite && (
        <>
          <BulkBar
            count={selected.size}
            busy={bulkBusy}
            onRun={(op) => props.onBulk(op, [...selected])}
            onClear={props.onClearSelection}
            initialConfirm={props.initialBulkConfirm}
          />
          <ReplyComposer
            ref={composerRef}
            target={resolved}
            text={text}
            onText={props.onText}
            onSend={props.onSend}
            onCancel={props.onCancelReply}
            sending={sending}
          />
        </>
      )}
    </div>
  );
});

/** A fragment that carries a key (an entry plus the divider above it, a comment plus the replies under it). */
function ThreadBranch({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function NewDivider() {
  const t = useTranslations("Comments");
  return (
    <li role="separator" aria-label={t("newDivider")} data-new-divider className="flex items-center gap-2 py-1">
      <span className="h-px flex-1 bg-primary/40" />
      <span className={cn(chip, TONE.primary, "uppercase tracking-wide")}>{t("newDivider")}</span>
      <span className="h-px flex-1 bg-primary/40" />
    </li>
  );
}
