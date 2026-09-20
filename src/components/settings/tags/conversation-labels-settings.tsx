'use client';

import { useState } from 'react';

import { AutoLabelSettings } from '../auto-label-settings';
import { TagCatalogPanel } from './tag-catalog-panel';

/**
 * Settings → Conversation labels: the label list (with CSV import /
 * export) plus the auto-label rules that apply those labels, which used
 * to sit under "Fields & tags".
 */
export function ConversationLabelsSettings() {
  // Bumped whenever the list changes above; remounts the rules card so
  // its label picker (a separate palette fetch) sees new labels.
  const [paletteVersion, setPaletteVersion] = useState(0);

  return (
    <div className="max-w-5xl space-y-6">
      <TagCatalogPanel kind="label" onChanged={() => setPaletteVersion((v) => v + 1)} />
      {/* Always shown; the rules card disables its own controls without tags.manage. */}
      <AutoLabelSettings key={paletteVersion} />
    </div>
  );
}
