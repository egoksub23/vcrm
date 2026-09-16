'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  MessageCircle,
  Globe,
  Camera,
  Send,
  Mail,
  MessageSquareText,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { WhatsAppConfig } from './channels/whatsapp-channel';
import { WebWidgetChannel } from './channels/web-widget-channel';

type ChannelId = 'whatsapp' | 'web_widget' | 'instagram' | 'messenger' | 'email' | 'sms';

interface ChannelEntry {
  id: ChannelId;
  icon: LucideIcon;
  comingSoon?: boolean;
}

const CHANNELS: ChannelEntry[] = [
  { id: 'whatsapp', icon: MessageCircle },
  { id: 'web_widget', icon: Globe },
  { id: 'instagram', icon: Camera, comingSoon: true },
  { id: 'messenger', icon: Send, comingSoon: true },
  { id: 'email', icon: Mail, comingSoon: true },
  { id: 'sms', icon: MessageSquareText, comingSoon: true },
];

/**
 * Settings → Channels. Owns an internal sub-nav rather than being a
 * flat panel — WhatsApp is no longer "the" integration, it's one of
 * several channel types, with Web Widget the second real one and the
 * rest shown as "coming soon" so the multi-channel direction is
 * visible even before they're built.
 */
export function ChannelsTab() {
  const t = useTranslations('Settings.channels');
  const [active, setActive] = useState<ChannelId>('whatsapp');

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {CHANNELS.map((channel) => (
          <button
            key={channel.id}
            type="button"
            onClick={() => setActive(channel.id)}
            className={cn(
              'flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              active === channel.id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <channel.icon className="size-4" />
            {t(`names.${channel.id}`)}
            {channel.comingSoon ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('comingSoonBadge')}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {active === 'whatsapp' ? <WhatsAppConfig /> : null}
      {active === 'web_widget' ? <WebWidgetChannel /> : null}
      {active !== 'whatsapp' && active !== 'web_widget' ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {t('comingSoonTitle', { channel: t(`names.${active}`) })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('comingSoonDescription')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
