'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { ChannelsTab } from '@/components/settings/channels-tab';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { TagsSettings } from '@/components/settings/tags/tags-settings';
import { ConversationLabelsSettings } from '@/components/settings/tags/conversation-labels-settings';
import { TicketFormSettings } from '@/components/settings/ticket-form-settings';
import { DealsSettings } from '@/components/settings/deals-settings';
import { ResponseTimeSettings } from '@/components/settings/response-time-settings';
import { StatusColorsTab } from '@/components/settings/status-colors-tab';
import { TeamSection } from '@/components/settings/team/team-section';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { RolesPermissionsTab } from '@/components/settings/roles-permissions-tab';
import { AuditLogPanel } from '@/components/settings/audit/audit-log-panel';
import { ApprovalsPanel } from '@/components/settings/approvals/approvals-panel';
import { IntegrationsPanel } from '@/components/settings/integrations/integrations-panel';
import { useApprovalsCount } from '@/hooks/use-approvals-count';
import { badgeLabel } from '@/lib/approvals/rules';
import { NoAccess } from '@/components/auth/no-access';
import {
  canSeeSection,
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency, slaResponseMinutes, capabilities } = useAuth();
  const { count: approvalsCount } = useApprovalsCount();
  const { mode } = useTheme();
  const t = useTranslations('Settings');
  const tAccess = useTranslations('Permissions.access');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection, extraParams?: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    // Deep-link into a sub-view (e.g. Channels → WhatsApp → Templates).
    for (const [k, v] of Object.entries(extraParams ?? {})) params.set(k, v);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
      'response-time': `${slaResponseMinutes} min`,
      // Proposals waiting for a decision (only reviewers ever see a number).
      approvals: approvalsCount > 0 ? (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
          {badgeLabel(approvalsCount)}
        </span>
      ) : undefined,
    }),
    [mode, defaultCurrency, slaResponseMinutes, approvalsCount],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    channels: <ChannelsTab />,
    'quick-replies': <QuickRepliesManager />,
    tags: <TagsSettings />,
    labels: <ConversationLabelsSettings />,
    fields: <FieldsAndTagsPanel />,
    'ticket-form': <TicketFormSettings />,
    deals: <DealsSettings />,
    'response-time': <ResponseTimeSettings />,
    'status-colors': <StatusColorsTab />,
    team: <TeamSection />,
    roles: <RolesPermissionsTab />,
    approvals: <ApprovalsPanel />,
    audit: <AuditLogPanel />,
    integrations: <IntegrationsPanel />,
    api: <ApiKeysSettings />,
  };

  // A section behind a capability (?tab=roles, ?tab=api) the person does
  // not hold shows the friendly no-access state inside the panel, not an
  // empty panel. The page itself is guarded by menu.settings.
  const allowed = canSeeSection(section, (cap) => capabilities.has(cap));

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={(s) => go(s)} hints={hints} />
        <div className="min-w-0">
          {allowed ? (
            panel[section]
          ) : (
            <NoAccess
              href="/settings"
              linkLabel={tAccess('backToSettings')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
