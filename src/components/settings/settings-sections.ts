import {
  Bookmark,
  Boxes,
  ClipboardList,
  Coins,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  SlidersHorizontal,
  SwatchBook,
  Tag,
  Timer,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'channels',
  'quick-replies',
  'tags',
  'labels',
  'fields',
  'ticket-form',
  'deals',
  'response-time',
  'status-colors',
  'members',
  'teams',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Your profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login & security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Appearance', icon: Palette, group: 'account' },
  channels: { id: 'channels', label: 'Channels', icon: PlugZap, group: 'workspace' },
  'quick-replies': { id: 'quick-replies', label: 'Quick replies', icon: Zap, group: 'workspace' },
  tags: { id: 'tags', label: 'Tags', icon: Tag, group: 'workspace' },
  labels: { id: 'labels', label: 'Conversation labels', icon: Bookmark, group: 'workspace' },
  fields: { id: 'fields', label: 'Custom fields', icon: SlidersHorizontal, group: 'workspace' },
  'ticket-form': { id: 'ticket-form', label: 'Ticket form', icon: ClipboardList, group: 'workspace' },
  deals: { id: 'deals', label: 'Deals & currency', icon: Coins, group: 'workspace' },
  'response-time': { id: 'response-time', label: 'Response time', icon: Timer, group: 'workspace' },
  'status-colors': { id: 'status-colors', label: 'Status colors', icon: SwatchBook, group: 'workspace' },
  members: { id: 'members', label: 'Team members', icon: UsersRound, group: 'workspace' },
  teams: { id: 'teams', label: 'Teams', icon: Boxes, group: 'workspace' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (`custom-fields` → Custom
 * fields; `tags` is a section of its own again). Anything unknown falls
 * back to the Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'custom-fields') return 'fields';
  // WhatsApp templates moved under Channels → WhatsApp → Templates.
  if (raw === 'whatsapp' || raw === 'templates') return 'channels';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
