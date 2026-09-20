'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { Loader2 } from 'lucide-react';

import type { KnowledgeInsights } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';

function Panel({
  title,
  hint,
  empty,
  rows,
}: {
  title: string;
  hint: string;
  empty: string;
  rows: { id: string; title: string; meta: string }[];
}) {
  return (
    <section className="rounded-xl border border-border">
      <header className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/knowledge/${r.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-muted/40"
              >
                <span className="min-w-0 truncate font-medium text-foreground">{r.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.meta}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Which articles earn their keep: most used, never used, and the ones
 *  written to fix an unanswered question. */
export function InsightsView() {
  const t = useTranslations('Knowledge.insights');
  const [data, setData] = useState<KnowledgeInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch('/api/knowledge/insights', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as KnowledgeInsights);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }
  if (failed || !data) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel
        title={t('mostUsed')}
        hint={t('mostUsedHint', { days: data.window_days })}
        empty={t('emptyMostUsed')}
        rows={(data.most_used ?? []).map((a) => ({ id: a.id, title: a.title, meta: t('uses', { count: a.uses }) }))}
      />
      <Panel
        title={t('neverUsed')}
        hint={t('neverUsedHint', { days: data.window_days })}
        empty={t('emptyNeverUsed')}
        rows={(data.never_used ?? []).map((a) => ({
          id: a.id,
          title: a.title,
          meta: t('edited', { when: formatDistanceToNow(new Date(a.updated_at), { addSuffix: true }) }),
        }))}
      />
      <Panel
        title={t('handoffFixes')}
        hint={t('handoffFixesHint')}
        empty={t('emptyHandoffFixes')}
        rows={(data.handoff_fixes ?? []).map((a) => ({
          id: a.id,
          title: a.title,
          meta: t('handoffs', { count: a.handoffs }),
        }))}
      />
    </div>
  );
}
