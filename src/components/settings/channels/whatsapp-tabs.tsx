'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { TemplateManager } from '../template-manager';
import { WhatsAppConfig } from './whatsapp-channel';

export type WhatsAppView = 'templates' | 'connection';

const VIEWS: WhatsAppView[] = ['templates', 'connection'];

/**
 * Settings → Channels → WhatsApp. Two tabs: Templates (message templates
 * used to reach customers outside the 24-hour window) and Connection
 * (Meta credentials, webhook, health). Templates used to be its own
 * Settings section; they only exist because of the WhatsApp connection,
 * so they live under it now.
 */
export function WhatsAppChannel({ initialView = 'templates' }: { initialView?: WhatsAppView }) {
  const t = useTranslations('Settings.channels.whatsappTabs');
  const [view, setView] = useState<WhatsAppView>(initialView);

  return (
    <div>
      <div role="tablist" className="mb-5 flex gap-1 border-b border-border">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              view === v
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(v)}
          </button>
        ))}
      </div>
      {view === 'templates' ? <TemplateManager /> : <WhatsAppConfig />}
    </div>
  );
}
