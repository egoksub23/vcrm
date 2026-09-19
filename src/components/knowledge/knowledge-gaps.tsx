'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ArticleDraftSeed } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';

type GapStatus = 'open' | 'resolved' | 'dismissed';

interface Gap {
  id: string;
  question: string;
  times_asked: number;
  conversation_id: string | null;
  last_asked_at: string;
}

/**
 * Questions the AI handed off for lack of an article. Someone writes the
 * article (pre-filled with the customer's words) or dismisses the
 * question; either way it leaves the queue.
 */
export function KnowledgeGaps({
  canWrite,
  onCount,
  onWrite,
}: {
  canWrite: boolean;
  onCount: (openCount: number) => void;
  onWrite: (seed: ArticleDraftSeed) => void;
}) {
  const t = useTranslations('Knowledge.gaps');
  const [status, setStatus] = useState<GapStatus>('open');
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [counts, setCounts] = useState<Record<GapStatus, number>>({ open: 0, resolved: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (s: GapStatus) => {
      try {
        const res = await fetch(`/api/knowledge/gaps?status=${s}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('loadFailed'));
          return;
        }
        setGaps(data.gaps ?? []);
        setCounts(data.counts);
        onCount(data.counts.open ?? 0);
      } catch {
        toast.error(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [t, onCount],
  );

  useEffect(() => {
    setLoading(true);
    void load(status);
  }, [status, load]);

  async function setGapStatus(id: string, next: GapStatus) {
    const res = await fetch(`/api/knowledge/gaps/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? t('updateFailed'));
      return;
    }
    void load(status);
  }

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('hint')}</p>
      <div className="flex gap-2">
        {(['open', 'resolved', 'dismissed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              status === s ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            {t(s)} {counts[s]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      ) : gaps.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {gaps.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-foreground">{g.question}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('asked', { count: g.times_asked })} ·{' '}
                  {formatDistanceToNow(new Date(g.last_asked_at), { addSuffix: true })}
                  {g.conversation_id ? (
                    <>
                      {' · '}
                      <a className="text-primary hover:underline" href={`/inbox?c=${g.conversation_id}`}>
                        {t('viewChat')}
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
              {canWrite && (
                <div className="flex shrink-0 gap-2">
                  {status === 'open' ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          onWrite({
                            title: g.question,
                            kind: 'qa',
                            sourceConversationId: g.conversation_id,
                            resolvesGapId: g.id,
                          })
                        }
                      >
                        {t('writeArticle')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void setGapStatus(g.id, 'dismissed')}>
                        {t('dismiss')}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void setGapStatus(g.id, 'open')}>
                      {t('reopen')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
