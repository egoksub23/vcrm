'use client';

import { useState } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MessageSquareText } from 'lucide-react';

import { cn } from '@/lib/utils';
import { CHANNEL_ICONS } from '@/components/inbox/channel-icons';
import { WhatsAppChannel, type WhatsAppView } from './channels/whatsapp-tabs';
import { WebWidgetChannel } from './channels/web-widget-channel';
import { MessengerChannel } from './channels/messenger-channel';
import { InstagramChannel } from './channels/instagram-channel';
import { EmailChannel } from './channels/email-channel';
import { GmailChannel } from './channels/gmail-channel';
import { TikTokChannel } from './channels/tiktok-channel';
import { CommentsSamplesCard } from './channels/comments-samples-card';
import { PROVIDER_ICONS } from '@/components/comments/provider-icons';
import { useCan } from '@/hooks/use-can';

type ChannelId = 'whatsapp' | 'web_widget' | 'instagram' | 'messenger' | 'tiktok' | 'email' | 'gmail' | 'sms';

interface ChannelEntry {
  id: ChannelId;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  comingSoon?: boolean;
}

const CHANNELS: ChannelEntry[] = [
  { id: 'whatsapp', icon: CHANNEL_ICONS.whatsapp },
  { id: 'web_widget', icon: CHANNEL_ICONS.web_widget },
  { id: 'instagram', icon: CHANNEL_ICONS.instagram },
  { id: 'messenger', icon: CHANNEL_ICONS.messenger },
  { id: 'tiktok', icon: PROVIDER_ICONS.tiktok },
  { id: 'email', icon: CHANNEL_ICONS.email },
  { id: 'gmail', icon: CHANNEL_ICONS.gmail },
  // No real channel behind SMS yet — no brand to show, so it keeps the
  // generic outline icon the others used before this changed to logos.
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
  const canEditSettings = useCan('edit-settings');
  const searchParams = useSearchParams();
  // The OAuth connect flow (Messenger/Instagram) redirects back here
  // with `?channel=`, so a completed connection (or an error) lands on
  // the right sub-nav tab instead of defaulting to WhatsApp.
  const [active, setActive] = useState<ChannelId>(() => {
    const fromUrl = searchParams.get('channel');
    return isChannelId(fromUrl) ? fromUrl : 'whatsapp';
  });
  // WhatsApp's own sub-tabs: an explicit `?view=` wins; the legacy
  // `?tab=whatsapp` link (account menu) means the connection, and the
  // legacy `?tab=templates` link means templates. Otherwise Templates
  // (the first tab) opens.
  const rawTab = searchParams.get('tab');
  const viewParam = searchParams.get('view');
  const initialWhatsAppView: WhatsAppView =
    viewParam === 'connection' || viewParam === 'templates'
      ? viewParam
      : rawTab === 'whatsapp'
        ? 'connection'
        : 'templates';

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

      {active === 'whatsapp' ? <WhatsAppChannel initialView={initialWhatsAppView} /> : null}
      {active === 'web_widget' ? <WebWidgetChannel /> : null}
      {active === 'messenger' ? <MessengerChannel /> : null}
      {active === 'instagram' ? <InstagramChannel /> : null}
      {active === 'tiktok' ? <TikTokChannel /> : null}
      {canEditSettings && (active === 'messenger' || active === 'instagram' || active === 'tiktok') ? (
        <CommentsSamplesCard />
      ) : null}
      {active === 'email' ? <EmailChannel /> : null}
      {active === 'gmail' ? <GmailChannel /> : null}
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
