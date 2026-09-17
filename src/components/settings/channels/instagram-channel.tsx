'use client';

import { useTranslations } from 'next-intl';
import { MetaChannelPanel } from './meta-channel-panel';
import type { InstagramConnectionStatus } from '@/types';

export function InstagramChannel() {
  const t = useTranslations('Settings.channels.instagram');
  return (
    <MetaChannelPanel
      channel="instagram"
      translationNamespace="Settings.channels.instagram"
      renderConnectedExtra={(status) => {
        const igUsername = (status as InstagramConnectionStatus).ig_username;
        return igUsername ? (
          <p className="text-xs text-muted-foreground">{t('igUsernameLabel')} @{igUsername}</p>
        ) : null;
      }}
    />
  );
}
