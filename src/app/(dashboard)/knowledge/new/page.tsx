'use client';

import { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useCapability } from '@/hooks/use-can';
import { KbEditorForm } from '@/components/knowledge/editor/kb-editor-form';
import { canEditArticle, parseSeedParams } from '@/components/knowledge/editor/kb-editor-utils';

/**
 * A new article. The query string can pre-fill it, so "Add to knowledge base"
 * on a message, "Write article" on an unanswered question and "Save agent
 * reply" can link here: title, content, language, kind, conv (the source
 * conversation) and gap (the unanswered question it resolves).
 */
function NewArticle() {
  const t = useTranslations('Knowledge.editor');
  const router = useRouter();
  const params = useSearchParams();
  const { user, profileLoading } = useAuth();
  const isAdmin = useCapability('knowledge.publish');
  const canWrite = useCapability('knowledge.draft');

  const seed = useMemo(() => parseSeedParams((k) => params.get(k)), [params]);

  if (profileLoading) {
    return (
      <div className="flex justify-center py-20" role="status" aria-label={t('loading')}>
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const allowed = canEditArticle({ isAdmin, canWrite, userId: user?.id ?? null, article: null });
  if (!allowed) {
    return (
      <div className="space-y-3 rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium text-foreground">{t('noPermissionTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('noPermissionBody')}</p>
        <Link href="/knowledge" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t('back')}
        </Link>
      </div>
    );
  }

  return (
    <KbEditorForm
      article={null}
      seed={seed}
      variant="page"
      canEdit
      // Land on the article's own page so the next save updates it and the
      // history and test box have a saved article to work on.
      onSaved={({ id }) => router.replace(id ? `/knowledge/${id}` : '/knowledge')}
    />
  );
}

export default function NewKnowledgeArticlePage() {
  const t = useTranslations('Knowledge.editor');
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <Suspense
        fallback={
          <div className="flex flex-col gap-4">
            <Link href="/knowledge" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> {t('back')}
            </Link>
            <div className="flex justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          </div>
        }
      >
        <NewArticle />
      </Suspense>
    </div>
  );
}
