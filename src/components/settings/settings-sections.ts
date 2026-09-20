import {
  Bookmark,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  Coins,
  History,
  KeyRound,
  LayoutGrid,
  Palette,
  Plug,
  PlugZap,
  Shield,
  ShieldCheck,
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
  'sla',
  'status-colors',
  'team',
  'roles',
  'approvals',
  'audit',
  'integrations',
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
  /**
   * Capability needed to see this section in the rail (and to open it by
   * URL). Sections without one stay visible to everyone who can open
   * Settings at all (menu.settings guards the whole page).
   */
  capability?: string;
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
  // Migration 086: Settings > SLA & business hours (sla.configure).
  sla: { id: 'sla', label: 'SLA & business hours', icon: CalendarClock, group: 'workspace', capability: 'sla.configure' },
  'status-colors': { id: 'status-colors', label: 'Status colors', icon: SwatchBook, group: 'workspace' },
  team: { id: 'team', label: 'Team', icon: UsersRound, group: 'workspace' },
  roles: { id: 'roles', label: 'Roles & permissions', icon: ShieldCheck, group: 'workspace', capability: 'roles.manage' },
  approvals: { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, group: 'workspace', capability: 'approvals.review' },
  audit: { id: 'audit', label: 'Audit log', icon: History, group: 'workspace', capability: 'audit.view' },
  // Migration 085: Settings > Integrations > Jira (jira.connect).
  integrations: { id: 'integrations', label: 'Integrations', icon: Plug, group: 'workspace', capability: 'jira.connect' },
  api: { id: 'api', label: 'API keys', icon: KeyRound, group: 'workspace', capability: 'api.manage' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Account', group: 'account' },
  { label: 'Workspace', group: 'workspace' },
];

/** May the caller see / open `section`? (Pure: pass a capability check.) */
export function canSeeSection(
  section: SettingsSection,
  has: (cap: string) => boolean,
): boolean {
  const cap = SECTION_META[section].capability;
  return !cap || has(cap);
}

/** The sections the caller may see, in rail order. */
export function visibleSections(
  has: (cap: string) => boolean,
): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => canSeeSection(s, has));
}

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
  // Team members and Teams merged into one Team section (two views).
  if (raw === 'members' || raw === 'teams') return 'team';
  // WhatsApp templates moved under Channels → WhatsApp → Templates.
  if (raw === 'whatsapp' || raw === 'templates') return 'channels';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}

/** The two views of the merged Team section. */
export type TeamView = 'members' | 'teams';

/**
 * Which Team view to show. `?view=` wins; otherwise the legacy tab that
 * got the person here decides (`?tab=teams` opens Teams, `?tab=members`
 * and everything else open Members).
 */
export function resolveTeamView(
  tab: string | null,
  view: string | null,
): TeamView {
  if (view === 'teams' || view === 'members') return view;
  return tab === 'teams' ? 'teams' : 'members';
}
