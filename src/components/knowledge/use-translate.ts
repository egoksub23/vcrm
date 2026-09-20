'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { KB_LANGUAGE_LABELS, type KbLanguage } from '@/lib/ai/knowledge-query';
import type { TranslateLanguageResult } from '@/lib/knowledge-types';

import { isKnownTranslateError, outcomesOf, postTranslate } from './translate-client';

/**
 * Run "Translate with AI" for one article and tell the person what happened:
 * a toast per language that failed (in the interface language for the errors
 * it knows, the server's own words otherwise) and one for what succeeded.
 * Resolves with the per-language outcomes so the caller can open the new
 * draft or reload.
 */
export function useTranslate() {
  const t = useTranslations('Knowledge.translations');

  return useCallback(
    async (baseId: string, languages: KbLanguage[], overwrite: boolean): Promise<TranslateLanguageResult[]> => {
      const call = await postTranslate(baseId, languages.length === 1 ? { language: languages[0], overwrite } : { languages, overwrite });
      const outcomes = outcomesOf(call, languages);
      const ok = outcomes.filter((o) => o.ok);
      for (const o of outcomes) {
        if (o.ok) continue;
        const message = isKnownTranslateError(o.code) ? t(`err.${o.code}`) : (o.error ?? t('err.generic'));
        toast.error(t('failedFor', { language: KB_LANGUAGE_LABELS[o.language], message }));
      }
      if (ok.length === 1 && outcomes.length === 1) {
        toast.success(t('translated', { language: KB_LANGUAGE_LABELS[ok[0].language] }));
      } else if (ok.length > 0) {
        toast.success(t('translatedMany', { count: ok.length }));
      }
      return outcomes;
    },
    [t],
  );
}
