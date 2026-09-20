'use client';

import { useState } from 'react';

import { useCapability } from '@/hooks/use-can';

import { AutoLabelSettings } from '../auto-label-settings';
import { TagCatalogPanel } from './tag-catalog-panel';

/**
 * Settings → Conversation labels: the label list (with CSV import /
 * export) plus the auto-label rules that apply those labels, which used
 * to sit under "Fields & tags".
 */
export function ConversationLabelsSettings() {
  const canManageTags = useCapability('tags.manage');
  // Bumped whenever the list changes above; remounts the rules card so
  // its label picker (a separate palette fetch) sees new labels.
  const [paletteVersion, setPaletteVersion] = useState(0);

  return (
    <div className="max-w-5xl space-y-6">
      <TagCatalogPanel kind="label" onChanged={() => setPaletteVersion((v) => v + 1)} />
      {canManageTags ? <AutoLabelSettings key={paletteVersion} /> : null}
    </div>
  );
}
