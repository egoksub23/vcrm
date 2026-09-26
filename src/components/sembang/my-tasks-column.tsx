'use client';

// Global "My Tasks" column — the middle-pane view for the sidebar's
// "My Tasks" entry, same layout convention as mentions-column.tsx: a
// list on the left, an open thread on the right when a row's origin
// message is clicked. Lists every `sembang_tasks` row assigned to the
// caller across every channel/DM (GET /api/sembang/my-tasks), open
// first, then done — the same split tasks-panel.tsx (the per-channel
// Tasks sheet) uses, just flattened across channels with a channel
// badge per row instead of one fixed channelId for the whole list.
//
// Per-task actions (toggle done, delete, link a ticket) reuse the
// existing per-channel PATCH/DELETE `/api/sembang/channels/[id]/tasks/
// [taskId]` routes — each hydrated task already carries its own
// `channelId`, so no new mutation route was needed for this view.
//
// Known, accepted simplifications (same spirit as mentions-column.tsx's
// own list):
// - A task with no origin message (typed straight into the per-channel
//   Tasks sheet, not created via "Add to tasks" on a message) has
//   nothing to open on the right — its title isn't clickable, same
//   `disabled={!item.task.messageId}` shape mentions uses for a
//   since-deleted message.
// - The sidebar's badge count is refreshed on mount and whenever this
//   view reports a change (`onChanged`) — it is NOT a live realtime
//   subscription (unlike the Mentions badge, which piggybacks on the
//   sidebar's existing per-message realtime refetch). Someone else
//   assigning you a task while you're elsewhere in the app won't bump
//   the badge until you revisit Sembang.
// - canRemoveMessages/pinnedMessageIds carry the same cross-channel
//   caveats documented in mentions-column.tsx.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  CheckSquare,
  Loader2,
  Ticket as TicketIcon,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CreateTicketDialog } from '@/components/tickets/create-ticket-dialog';
import { ThreadPanel } from './thread-panel';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useAccountMembers } from '@/hooks/use-account-members';
import { useTicketKeyPrefix } from '@/hooks/use-ticket-key-prefix';
import { hasMinRole } from '@/lib/auth/roles';
import {
  addMessageToTask,
  editMessage,
  reactToMessage,
  removeMessage,
  toggleMessagePin,
  toggleMessageStar,
} from '@/lib/sembang/message-actions';
import type {
  SembangMessage,
  SembangMyTaskItem,
  SembangReactionSummary,
  SembangTask,
  Ticket,
} from '@/types';

const EMPTY_PINNED_IDS = new Set<string>();

interface MyTasksColumnProps {
  /** Bumped whenever a task is toggled or deleted, so the sidebar's
   *  badge count (a separate fetch) can refresh. */
  onChanged?: () => void;
}

export function MyTasksColumn({ onChanged }: MyTasksColumnProps) {
  const t = useTranslations('Sembang.myTasksPanel');
  const tThread = useTranslations('Sembang.thread');
  const { user, accountRole } = useAuth();
  const { members: accountMembers } = useAccountMembers();
  const peopleNames = useMemo(
    () => accountMembers.map((m) => m.full_name),
    [accountMembers]
  );
  const canRemoveMessages = hasMinRole(accountRole ?? 'viewer', 'admin');
  const canCreateTicket = hasMinRole(accountRole ?? 'viewer', 'agent');
  const { keyOf } = useTicketKeyPrefix();

  const [results, setResults] = useState<SembangMyTaskItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<SembangMyTaskItem | null>(null);
  const [ticketItem, setTicketItem] = useState<SembangMyTaskItem | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/sembang/my-tasks', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setResults((data.results as SembangMyTaskItem[]) ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const openTasks = (results ?? []).filter((r) => r.task.status === 'open');
  const doneTasks = (results ?? []).filter((r) => r.task.status === 'done');

  const patchTask = async (
    task: SembangTask,
    body: Record<string, unknown>
  ) => {
    const res = await fetch(
      `/api/sembang/channels/${task.channelId}/tasks/${task.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      return { ok: false as const, error: data?.error as string | undefined };
    return { ok: true as const, task: data.task as SembangTask };
  };

  const handleToggleStatus = async (item: SembangMyTaskItem) => {
    const nextStatus = item.task.status === 'open' ? 'done' : 'open';
    setTogglingId(item.task.id);
    const result = await patchTask(item.task, { status: nextStatus });
    setTogglingId(null);
    if (!result.ok) {
      toast.error(result.error || t('updateFailed'));
      return;
    }
    setResults(
      (prev) =>
        prev?.map((r) =>
          r.task.id === item.task.id ? { ...r, task: result.task } : r
        ) ?? prev
    );
    onChanged?.();
  };

  const handleDelete = async (item: SembangMyTaskItem) => {
    setDeletingId(item.task.id);
    try {
      const res = await fetch(
        `/api/sembang/channels/${item.task.channelId}/tasks/${item.task.id}`,
        {
          method: 'DELETE',
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t('deleteFailed'));
        return;
      }
      setResults(
        (prev) => prev?.filter((r) => r.task.id !== item.task.id) ?? prev
      );
      if (openItem?.task.id === item.task.id) setOpenItem(null);
      onChanged?.();
    } finally {
      setDeletingId(null);
    }
  };

  const handleTicketCreated = async (ticket: Ticket) => {
    if (!ticketItem) return;
    const result = await patchTask(ticketItem.task, { ticketId: ticket.id });
    if (!result.ok) {
      toast.error(result.error || t('linkTicketFailed'));
      return;
    }
    setResults(
      (prev) =>
        prev?.map((r) =>
          r.task.id === ticketItem.task.id ? { ...r, task: result.task } : r
        ) ?? prev
    );
  };

  // ---- Thread actions, parametrized per click by openItem.channel.id ----
  const handleReact = useCallback(
    async (
      messageId: string,
      emoji: string
    ): Promise<SembangReactionSummary[] | null> => {
      if (!openItem) return null;
      const result = await reactToMessage(
        openItem.channel.id,
        messageId,
        emoji
      );
      if (!result.ok) {
        toast.error(result.error || tThread('reactFailed'));
        return null;
      }
      return result.reactions;
    },
    [openItem, tThread]
  );

  const handleTogglePin = useCallback(
    (message: SembangMessage, pinned: boolean) => {
      if (!openItem) return;
      void toggleMessagePin(openItem.channel.id, message.id, pinned).then(
        (result) => {
          if (!result.ok)
            toast.error(
              result.error ||
                (pinned ? tThread('unpinFailed') : tThread('pinFailed'))
            );
        }
      );
    },
    [openItem, tThread]
  );

  const handleToggleStar = useCallback(
    (message: SembangMessage, starred: boolean) => {
      if (!openItem) return;
      void toggleMessageStar(openItem.channel.id, message.id, starred).then(
        (result) => {
          if (!result.ok)
            toast.error(
              starred ? tThread('unstarFailed') : tThread('starFailed')
            );
        }
      );
    },
    [openItem, tThread]
  );

  const handleEditMessage = useCallback(
    async (messageId: string, body: string): Promise<SembangMessage | null> => {
      if (!openItem) return null;
      const result = await editMessage(openItem.channel.id, messageId, body);
      if (!result.ok) {
        toast.error(result.error || tThread('editFailed'));
        return null;
      }
      return result.message;
    },
    [openItem, tThread]
  );

  const handleRemoveMessage = useCallback(
    async (messageId: string): Promise<SembangMessage | null> => {
      if (!openItem) return null;
      const result = await removeMessage(openItem.channel.id, messageId);
      if (!result.ok) {
        toast.error(result.error || tThread('removeMessageFailed'));
        return null;
      }
      return result.message;
    },
    [openItem, tThread]
  );

  const handleAddToTask = useCallback(
    (message: SembangMessage) => {
      if (!openItem) return;
      void addMessageToTask(openItem.channel.id, message).then((result) => {
        if (!result.ok)
          toast.error(result.error || tThread('addToTasksFailed'));
        else toast.success(tThread('addedToTasks'));
      });
    },
    [openItem, tThread]
  );

  const handleReplyPosted = useCallback(() => {}, []);

  const renderItem = (item: SembangMyTaskItem) => {
    const { task } = item;
    const clickable = !!task.messageId;
    return (
      <div
        key={task.id}
        className={cn(
          'group flex items-start gap-2 rounded-lg border p-2',
          openItem?.task.id === task.id
            ? 'border-primary/40 bg-primary/5'
            : 'border-border hover:bg-muted/40'
        )}
      >
        <Checkbox
          checked={task.status === 'done'}
          onCheckedChange={() => void handleToggleStatus(item)}
          disabled={togglingId === task.id}
          className="mt-0.5"
        />
        <button
          type="button"
          onClick={() => clickable && setOpenItem(item)}
          disabled={!clickable}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
        >
          <p
            className={cn(
              'text-foreground text-sm',
              task.status === 'done' && 'text-muted-foreground line-through'
            )}
          >
            {task.title}
          </p>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="truncate">
              {item.channel.isDm
                ? item.channel.dmParticipantNames?.join(', ') ||
                  t('directMessage')
                : `#${item.channel.name ?? ''}`}
            </span>
            {task.dueAt && (
              <span className="bg-muted rounded-full px-1.5 py-0.5">
                {t('due', { date: format(new Date(task.dueAt), 'MMM d') })}
              </span>
            )}
          </div>
        </button>
        {task.ticketId ? (
          <a
            href={`/tickets?t=${task.ticketId}`}
            className="text-primary hover:bg-primary/10 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium opacity-0 group-hover:opacity-100"
          >
            <TicketIcon className="h-3 w-3" aria-hidden />
            {task.ticketNumber != null
              ? keyOf(task.ticketNumber)
              : t('viewTicket')}
          </a>
        ) : (
          canCreateTicket && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('createTicket')}
              title={t('createTicket')}
              onClick={() => setTicketItem(item)}
              className="shrink-0 opacity-0 group-hover:opacity-100"
            >
              <TicketIcon className="h-3.5 w-3.5" />
            </Button>
          )
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('deleteTask')}
          title={t('deleteTask')}
          onClick={() => void handleDelete(item)}
          disabled={deletingId === task.id}
          className="shrink-0 opacity-0 group-hover:opacity-100"
        >
          {deletingId === task.id ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="border-border flex h-full w-full min-w-0 flex-col border-r sm:w-[360px] sm:shrink-0">
        <div className="border-border bg-card flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <CheckSquare className="text-muted-foreground h-4 w-4" aria-hidden />
          <span className="font-heading text-foreground text-sm font-medium">
            {t('title')}
          </span>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          {loading && !results ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-primary h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="text-destructive py-8 text-center text-sm">
              {t('loadFailed')}
            </p>
          ) : !results || results.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t('empty')}
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {t('openSection', { count: openTasks.length })}
                </p>
                {openTasks.length === 0 ? (
                  <p className="text-muted-foreground px-1 py-2 text-xs">
                    {t('noOpenTasks')}
                  </p>
                ) : (
                  openTasks.map(renderItem)
                )}
              </div>
              {doneTasks.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {t('doneSection', { count: doneTasks.length })}
                  </p>
                  {doneTasks.map(renderItem)}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {openItem?.task.messageId ? (
        <ThreadPanel
          open
          onOpenChange={(next) => {
            if (!next) setOpenItem(null);
          }}
          channelId={openItem.channel.id}
          channelName={
            openItem.channel.isDm
              ? (openItem.channel.dmParticipantNames?.join(', ') ??
                t('directMessage'))
              : (openItem.channel.name ?? '')
          }
          parentMessageId={openItem.task.messageId}
          currentUserId={user?.id}
          peopleNames={peopleNames}
          canRemoveMessages={canRemoveMessages}
          pinnedMessageIds={EMPTY_PINNED_IDS}
          onReact={handleReact}
          onTogglePin={handleTogglePin}
          onToggleStar={handleToggleStar}
          onEditMessage={handleEditMessage}
          onRemoveMessage={handleRemoveMessage}
          onAddToTask={handleAddToTask}
          onReplyPosted={handleReplyPosted}
        />
      ) : (
        <div className="bg-background flex flex-1 flex-col items-center justify-center px-6 text-center">
          <CheckSquare className="text-muted-foreground h-8 w-8" aria-hidden />
          <p className="text-muted-foreground mt-3 text-sm">
            {t('selectTaskHint')}
          </p>
        </div>
      )}

      <CreateTicketDialog
        open={!!ticketItem}
        onOpenChange={(next) => {
          if (!next) setTicketItem(null);
        }}
        initialSubject={ticketItem?.task.title ?? ''}
        initialDescription={
          ticketItem
            ? t('ticketDescriptionPrefill', {
                channel: ticketItem.channel.isDm
                  ? (ticketItem.channel.dmParticipantNames?.join(', ') ??
                    t('directMessage'))
                  : (ticketItem.channel.name ?? ''),
              })
            : ''
        }
        initialAssigneeId={ticketItem?.task.assigneeId ?? null}
        onCreated={(ticket) => {
          void handleTicketCreated(ticket);
        }}
      />
    </div>
  );
}
