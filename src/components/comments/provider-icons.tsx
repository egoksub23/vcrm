import type { SVGProps } from "react";

import { CHANNEL_ICONS } from "@/components/inbox/channel-icons";
import type { CommentProvider } from "@/lib/comments/types";

type Icon = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

const FacebookIcon: Icon = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <circle cx="16" cy="16" r="16" fill="#1877F2" />
    <path
      d="M17.9 26v-8.6h2.9l.45-3.4H17.9v-2.1c0-.98.27-1.65 1.68-1.65h1.8V7.2c-.31-.04-1.38-.14-2.62-.14-2.6 0-4.38 1.58-4.38 4.5V14H11.4v3.4h2.98V26h3.52Z"
      fill="#fff"
    />
  </svg>
);

const TikTokIcon: Icon = (props) => (
  <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <rect width="32" height="32" rx="8" fill="#000" />
    <path
      d="M19.6 8.5c.3 1.9 1.4 3.1 3.4 3.3v2.6c-1.2.1-2.3-.3-3.4-1v5.1c0 3.2-2.2 5-4.8 5-2.6 0-4.5-2-4.5-4.4 0-2.7 2.3-4.6 5.1-4.2v2.7c-1.3-.4-2.4.4-2.4 1.5 0 .9.7 1.6 1.6 1.6 1 0 1.7-.7 1.7-1.9V8.5h3.3Z"
      fill="#fff"
    />
    <path d="M18.4 8.5c.3 1.9 1.4 3.1 3.4 3.3v-1.2c-1.6-.3-2.3-1.2-2.5-2.1h-.9Z" fill="#25F4EE" opacity=".9" />
  </svg>
);

export const PROVIDER_ICONS: Record<CommentProvider, Icon> = {
  facebook: FacebookIcon,
  instagram: CHANNEL_ICONS.instagram,
  tiktok: TikTokIcon,
};

export const PROVIDER_NAMES: Record<CommentProvider, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};
