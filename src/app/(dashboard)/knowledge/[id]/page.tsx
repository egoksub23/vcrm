'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import type { KnowledgeArticle } from '@/lib/knowledge-types';
import { Button } from '@/components/ui/button';
import { KbEditorForm } from '@/components/knowledge/editor/kb-editor-form';
import { canEditArticle } from '@/components/knowledge/editor/kb-editor-utils';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error'; message: string | null }
  | { kind: 'ready'; article: KnowledgeArticle; version: number };

export default function KnowledgeArticlePage() {
  const t = useTranslations('Knowledge.editor');
  const { id } = useParams<{ id: string }>();
  const { user, profileLoading } = useAuth();
  const isAdmin = useCan('edit-settings');
  const canWrite = useCan('send-messages');

  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  // `version` remounts the form with the server's copy after a save or a
  // history restore, so the editor shows exactly what was stored (sanitised
  // HTML, attachment ids). `reload` bumps `attempt` to fetch again.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: LoadState;
      try {
        const res = await fetch(`/api/knowledge/${id}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) next = { kind: 'notFound' };
        else if (!res.ok) next = { kind: 'error', message: typeof data.error === 'string' ? data.error : null };
        else next = { kind: 'ready', article: data as KnowledgeArticle, version: 0 };
      } catch {
        next = { kind: 'error', message: null };
      }
      if (cancelled) return;
      setState((prev) =>
        next.kind === 'ready' && prev.kind === 'ready' ? { ...next, version: prev.version + 1 } : next,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const back = (
    <Link href="/knowledge" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" /> {t('back')}
    </Link>
  );

  let body: React.ReactNode;
  if (state.kind === 'loading' || profileLoading) {
    body = (
      <div className="flex justify-center py-20" role="status" aria-label={t('loading')}>
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  } else if (state.kind === 'notFound') {
    body = (
      <div className="space-y-3 rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium text-foreground">{t('notFoundTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('notFoundBody')}</p>
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div className="space-y-3 rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm text-destructive">{state.message ?? t('loadFailed')}</p>
        <Button size="sm" variant="outline" onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  } else {
    const { article } = state;
    body = (
      <KbEditorForm
        key={`${article.id}-${state.version}`}
        article={article}
        variant="page"
        canEdit={canEditArticle({ isAdmin, canWrite, userId: user?.id ?? null, article })}
        onSaved={reload}
        onRestored={reload}
        onTranslationsChanged={reload}
      />
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      {state.kind === 'ready' && !profileLoading ? null : back}
      {body}
    </div>
  );
}
