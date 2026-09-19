'use client';

import { useCan } from '@/hooks/use-can';

import { useTranslations } from 'next-intl';

import { CustomFieldsSettings } from './custom-fields-settings';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * "Custom fields" section. Tags and conversation labels moved to their
 * own Settings sections (with CSV import / export); what's left is the
 * account-wide custom-fields catalogue, which is admin config, so it's
 * gated (mirroring the old hidden-tab behaviour). `custom_fields` RLS
 * rejects non-admin writes regardless.
 */
export function FieldsAndTagsPanel() {
  const t = useTranslations('Settings.tagsAndFields');
  const canEditSettings = useCan('edit-settings');

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      {canEditSettings ? <CustomFieldsSettings /> : null}
    </section>
  );
}
