import type { SVGProps } from 'react';
import type { ChannelType } from '@/types';

/**
 * Single shared source for the per-channel badge, so the conversation
 * list, channel filter, message thread header, and per-message bubble
 * indicator can't drift — the same rationale already applied to
 * `CHAT_BG_CLASSES` in `message-thread.tsx`. Also used for the Settings
 * → Channels sub-nav (`channels-tab.tsx`).
 *
 * These are simplified, flat-color approximations of each platform's
 * mark (not the exact official logo asset) — legible down to the
 * ~10-14px sizes these render at across the inbox (h-2.5/h-3/h-3.5),
 * and colored rather than `currentColor`-based like the old Lucide
 * icons here, since a channel's identity IS its brand color at a
 * glance. Each accepts ordinary `<svg>` props (className, aria-label,
 * …) so every existing call site (`<ChannelIcon className="h-3 w-3" />`)
 * keeps working unchanged.
 */
type ChannelIconComponent = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

const WhatsAppIcon: ChannelIconComponent = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <circle cx="16" cy="16" r="16" fill="#25D366" />
    <path
      d="M16 7c-4.97 0-9 4.03-9 9 0 1.6.42 3.1 1.16 4.4L7 25l4.75-1.13A8.96 8.96 0 0 0 16 25c4.97 0 9-4.03 9-9s-4.03-9-9-9Z"
      fill="#fff"
    />
    <path
      d="M12.7 12.3c.2-.45.4-.46.6-.47h.5c.16 0 .38-.06.6.46l.75 1.8c.06.15.1.33 0 .53l-.3.5c-.1.2-.2.3-.1.5.4.7 1 1.3 1.7 1.7.2.1.3 0 .5-.1l.5-.3c.2-.1.38-.06.53 0l1.8.75c.52.22.46.44.46.6v.5c-.01.2-.02.4-.47.6-.9.4-1.9.4-2.8.05-1.9-.75-3.5-2.35-4.25-4.25-.35-.9-.35-1.9.05-2.8Z"
      fill="#25D366"
    />
  </svg>
);

const MessengerIcon: ChannelIconComponent = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <defs>
      <linearGradient id="channel-icon-messenger" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop stopColor="#00B2FF" />
        <stop offset="0.5" stopColor="#2B7FFF" />
        <stop offset="1" stopColor="#B620E0" />
      </linearGradient>
    </defs>
    <path
      d="M16 3C8.6 3 3 8.3 3 15.2c0 3.7 1.9 7 5 9.2v4.1l4.6-2.5c1.1.3 2.3.5 3.4.5 7.4 0 13-5.3 13-12.1C29 8.3 23.4 3 16 3Z"
      fill="url(#channel-icon-messenger)"
    />
    <path d="M9 18.7l4.6-4.9 3.6 2.7 4.6-4.9-4.6 4.9-3.6-2.7-4.6 4.9Z" fill="#fff" />
  </svg>
);

const InstagramIcon: ChannelIconComponent = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <defs>
      <linearGradient id="channel-icon-instagram" x1="2" y1="30" x2="30" y2="2" gradientUnits="userSpaceOnUse">
        <stop stopColor="#FEDA75" />
        <stop offset="0.3" stopColor="#FA7E1E" />
        <stop offset="0.55" stopColor="#D62976" />
        <stop offset="0.78" stopColor="#962FBF" />
        <stop offset="1" stopColor="#4F5BD5" />
      </linearGradient>
    </defs>
    <rect width="32" height="32" rx="9" fill="url(#channel-icon-instagram)" />
    <rect x="8" y="8" width="16" height="16" rx="5" stroke="#fff" strokeWidth="2" />
    <circle cx="16" cy="16" r="4.2" stroke="#fff" strokeWidth="2" />
    <circle cx="21.5" cy="10.5" r="1.3" fill="#fff" />
  </svg>
);

const WebWidgetIcon: ChannelIconComponent = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <circle cx="16" cy="16" r="16" fill="#7C3AED" />
    <path
      d="M16 8c-4.97 0-9 3.58-9 8 0 2.13.94 4.06 2.48 5.5L8 26l4.9-1.9c.98.26 2.02.4 3.1.4 4.97 0 9-3.58 9-8s-4.03-8-9-8Z"
      fill="#fff"
    />
  </svg>
);

const EmailIcon: ChannelIconComponent = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <rect width="32" height="32" rx="8" fill="#0A66C2" />
    <rect x="6" y="9" width="20" height="14" rx="2" fill="#fff" />
    <path d="M7 10.5l9 6.5 9-6.5" stroke="#0A66C2" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const CHANNEL_ICONS: Record<ChannelType, ChannelIconComponent> = {
  whatsapp: WhatsAppIcon,
  web_widget: WebWidgetIcon,
  messenger: MessengerIcon,
  instagram: InstagramIcon,
  email: EmailIcon,
};
