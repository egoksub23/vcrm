'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
import { MessengerChannel } from './channels/messenger-channel';
import { InstagramChannel } from './channels/instagram-channel';
import { EmailChannel } from './channels/email-channel';

type ChannelId = 'whatsapp' | 'web_widget' | 'instagram' | 'messenger' | 'email' | 'sms';

interface ChannelEntry {
  id: ChannelId;
  icon: LucideIcon;
  comingSoon?: boolean;
}

const CHANNELS: ChannelEntry[] = [
  { id: 'whatsapp', icon: MessageCircle },
  { id: 'web_widget', icon: Globe },
  { id: 'instagram', icon: Camera },
  { id: 'messenger', icon: Send },
  { id: 'email', icon: Mail },
  { id: 'sms', icon: MessageSquareText, comingSoon: true },
];

const CHANNEL_IDS: readonly string[] = CHANNELS.map((c) => c.id);

function isChannelId(value: string | null): value is ChannelId {
  return !!value && CHANNEL_IDS.includes(value);
}

/**
 * Settings → Channels. Owns an internal sub-nav rather than being a
 * flat panel — WhatsApp is no longer "the" integration, it's one of
 * several channel types, with Web Widget the second real one and the
 * rest shown as "coming soon" so the multi-channel direction is
 * visible even before they're built.
 */
export function ChannelsTab() {
  const t = useTranslations('Settings.channels');
  const searchParams = useSearchParams();
  // The OAuth connect flow (Messenger/Instagram) redirects back here
  // with `?channel=`, so a completed connection (or an error) lands on
  // the right sub-nav tab instead of defaulting to WhatsApp.
  const [active, setActive] = useState<ChannelId>(() => {
    const fromUrl = searchParams.get('channel');
    return isChannelId(fromUrl) ? fromUrl : 'whatsapp';
  });

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
      {active === 'messenger' ? <MessengerChannel /> : null}
      {active === 'instagram' ? <InstagramChannel /> : null}
      {active === 'email' ? <EmailChannel /> : null}
      {active === 'sms' ? (
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
