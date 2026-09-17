import { MessageCircle, Globe, Send, Camera, type LucideIcon } from 'lucide-react';
import type { ChannelType } from '@/types';

/**
 * Single shared source for the per-channel icon, so the conversation
 * list, message thread header, and per-message bubble badge can't drift
 * — the same rationale already applied to `CHAT_BG_CLASSES` in
 * `message-thread.tsx`. Icons match the ones already chosen in
 * `channels-tab.tsx`'s Settings sub-nav.
 */
export const CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  whatsapp: MessageCircle,
  web_widget: Globe,
  messenger: Send,
  instagram: Camera,
};
