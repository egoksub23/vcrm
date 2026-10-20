import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Static renders of the add-on role screens (migration 191) in every language, with the real wording from messages/<locale>.json; next-intl throws on a
// missing key or argument instead of printing a raw key path. renderToStaticMarkup paints the FIRST render only: clicking, saving, the confirm, the
// portal dialogs (the "new role" dialog, the member panel's popover) and the fetches are NOT covered here; the routes are tested in addons-routes.test.ts
// and the rules in addon-role-helpers.test.ts.

import { AddonRoleEditor } from './roles/addon-role-editor';
import { AddonRoleChips, ADDON_CHIP_LIMIT } from './team/addon-role-chips';
import type { AddonRoleEntry } from '@/lib/auth/addon-roles';
import { CAPABILITIES } from '@/lib/auth/capabilities';

const LOCALES = ['en', 'ms', 'zh', 'ko'] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (l: string): Tree => JSON.parse(readFileSync(join(process.cwd(), 'messages', `${l}.json`), 'utf8')) as Tree;
const MESSAGES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
type Tr = (key: string, values?: Record<string, unknown>) => string;
const tr = (locale: Locale, namespace: string): Tr =>
  createTranslator({ locale, messages: MESSAGES[locale] as never, namespace: namespace as never }) as unknown as Tr;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={MESSAGES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const entry = (over: Partial<AddonRoleEntry> = {}): AddonRoleEntry => ({
  id: 'ad-1',
  name: 'KYC reviewer',
  description: 'Looks at ID checks',
  memberCount: 2,
  capabilityCount: 2,
  minBaseRole: 'agent',
  editable: true,
  capabilities: ['tags.manage', 'channels.manage'],
  ...over,
});

describe.each(LOCALES)('Add-on role chips (%s)', (locale) => {
  const t = tr(locale, 'Settings.team.chips');
  const a = (n: number) => ({ id: `a${n}`, name: `Role ${n}` });

  it('shows each add-on a person holds by name, with a "+N" for those past the limit and every name in its tooltip', () => {
    const html = page(locale, <AddonRoleChips addons={[a(1), a(2), a(3), a(4)]} limit={ADDON_CHIP_LIMIT} />);
    expect(html).toContain('Role 1');
    expect(html).toContain('Role 2');
    expect(html).not.toContain('>Role 3<');
    expect(text(html)).toContain(t('addOnsMore', { count: 2 }));
    expect(html).toContain('title="Role 3, Role 4"');
    expect(errors).toEqual([]);
  });

  it('shows them all when no limit is given', () => {
    const html = page(locale, <AddonRoleChips addons={[a(1), a(2), a(3)]} />);
    for (const n of [1, 2, 3]) expect(html).toContain(`Role ${n}`);
    expect(html).not.toContain(t('addOnsMore', { count: 1 }));
  });

  it('says so in words when there are none (the member panel), and draws nothing in a list row', () => {
    expect(text(page(locale, <AddonRoleChips addons={[]} />))).toContain(t('noAddOns'));
    expect(page(locale, <AddonRoleChips addons={[]} hideEmpty />)).toBe('');
  });
});

describe.each(LOCALES)('Add-on role editor (%s)', (locale) => {
  const t = tr(locale, 'Permissions.addons');
  const tp = tr(locale, 'Permissions');
  const tRoles = tr(locale, 'Settings.roles');
  const all = new Set(CAPABILITIES.map((c) => c.key));
  const render = (e: AddonRoleEntry, editorCaps: ReadonlySet<string> = all) =>
    page(locale, <AddonRoleEditor entry={e} editorCaps={editorCaps} onChanged={async () => true} onDeleted={() => undefined} />);

  it('shows the name and description, how many people hold it, a switch per permission with its words, and Delete; no save bar until something changes', () => {
    const html = render(entry());
    const x = text(html);
    expect(html).toContain('value="KYC reviewer"');
    expect(html).toContain('Looks at ID checks');
    expect(x).toContain(t('memberCount', { count: 2 }));
    expect(x).toContain(t('delete'));
    expect(html.match(/role="switch"/g)).toHaveLength(CAPABILITIES.length);
    // a permission's switch is named by its words
    expect(x).toContain(tp('cap.tags_manage.label'));
    // saved permissions are switched on, the rest off
    const on = html.match(/role="switch"[^>]*aria-checked="true"/g) ?? [];
    expect(on).toHaveLength(2);
    expect(html).not.toContain('role="region"');
    expect(errors).toEqual([]);
  });

  it('says plainly that an add-on only adds, and from which base role everything in it applies', () => {
    const x = text(render(entry({ minBaseRole: 'agent' })));
    expect(x).toContain(t('onlyAdds'));
    expect(x).toContain(t('appliesFrom', { role: tRoles('agent') }));
    // nothing to add when every permission in it applies to everybody
    const plain = text(render(entry({ minBaseRole: 'viewer', capabilities: [], capabilityCount: 0 })));
    expect(plain).toContain(t('onlyAdds'));
    expect(plain).not.toContain(t('appliesFrom', { role: tRoles('agent') }));
  });

  it('marks a permission that needs more than a Viewer, in words', () => {
    const x = text(render(entry()));
    expect(x).toContain(t('needsRole', { role: tRoles('agent') }));
    expect(x).toContain(t('needsRole', { role: tRoles('admin') }));
  });

  it('lets someone switch on only what they hold themselves, and explains the ones they cannot', () => {
    // the editor holds nothing: every switch that is OFF is disabled with the reason; the two that are ON stay switchable (taking out needs no permission)
    const html = render(entry(), new Set());
    const switches = html.match(/<span[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(CAPABILITIES.length);
    const disabled = switches.filter((s) => /aria-disabled="true"/.test(s));
    expect(disabled).toHaveLength(CAPABILITIES.length - 2);
    // the two that are on are the two that stay switchable
    expect(switches.filter((s) => /aria-checked="true"/.test(s) && /aria-disabled="true"/.test(s))).toHaveLength(0);
    expect(text(html)).toContain(t('reasonNotHeld'));
    // the editor holds everything: nothing is blocked
    const free = render(entry());
    expect((free.match(/<span[^>]*role="switch"[^>]*>/g) ?? []).filter((s) => /aria-disabled="true"/.test(s))).toHaveLength(0);
    expect(text(free)).not.toContain(t('reasonNotHeld'));
  });

  it('groups the permissions under the same headings as the rest of Roles & permissions', () => {
    const x = text(render(entry()));
    expect(x).toContain(tp('group.menus'));
    expect(x).toContain(tp('group.tags'));
  });

  it("uses tokens for colour, never a Tailwind dark: variant (in the add-on screens' own classes; the shared inputs bring theirs)", () => {
    expect(render(entry())).toContain('border-border');
    for (const f of ['roles/addon-role-editor.tsx', 'roles/addon-roles-section.tsx', 'roles/new-addon-role-dialog.tsx', 'team/addon-role-chips.tsx']) {
      expect(readFileSync(join(process.cwd(), 'src', 'components', 'settings', f), 'utf8'), f).not.toMatch(/\bdark:/);
    }
  });
});

describe.each(LOCALES)('Add-on role wording (%s)', (locale) => {
  const t = tr(locale, 'Permissions.addons');
  const ts = tr(locale, 'Settings.team.sheet');

  it('formats every sentence with its values, in the language of the screen', () => {
    for (const n of [0, 1, 2, 7]) {
      expect(t('memberCount', { count: n })).toMatch(/\S/);
      expect(t('permissionCount', { count: n })).toMatch(/\S/);
      expect(t('deleteConfirmWithMembers', { count: n, name: 'KYC reviewer' })).toContain('KYC reviewer');
      expect(ts('accessSummaryWithAddOns', { role: 'X', count: n, enabled: 12, total: 80 })).toMatch(/12/);
    }
    expect(t('created', { name: 'KYC reviewer' })).toContain('KYC reviewer');
    expect(t('saved', { name: 'KYC reviewer' })).toContain('KYC reviewer');
    expect(ts('addOnPartial', { name: 'KYC reviewer', role: 'Agent' })).toContain('Agent');
    expect(ts('addOnNeedsRole', { role: 'Agent' })).toContain('Agent');
    expect(ts('addOnRolesUpdated', { name: 'Ana' })).toContain('Ana');
  });

  it('never calls an add-on a replacement: the wording says it only adds, in every language', () => {
    // the one fact the screens rest on is stated on the editor, the member panel and the invite dialog
    expect(t('onlyAdds')).toMatch(/\S/);
    expect(ts('addOnRolesHint')).toMatch(/\S/);
    expect(tr(locale, 'Settings.team.invite')('addOnRolesHint')).toMatch(/\S/);
  });
});

// The Roles & permissions screens print `Permissions.group.<group>` over each block of permissions. One group had no wording in any language, so the live
// screen showed the raw key "Permissions.group.incidents" as a heading. Every group that has a permission needs its heading, in every language.
describe.each(LOCALES)('Roles & permissions headings (%s)', (locale) => {
  const group = (MESSAGES[locale].Permissions as { group: Record<string, string> }).group;
  it('has a heading for every group of permissions, and its words are not the key', () => {
    const groups = [...new Set(CAPABILITIES.map((c) => c.group))];
    for (const g of groups) {
      expect(group[g], `Permissions.group.${g}`).toBeTruthy();
      expect(group[g]).not.toContain('Permissions.group');
    }
  });

  it('has a label and a description for every permission', () => {
    const cap = (MESSAGES[locale].Permissions as { cap: Record<string, { label?: string; description?: string }> }).cap;
    for (const c of CAPABILITIES) {
      const id = c.key.replace(/[.\-]/g, '_');
      expect(cap[id]?.label, `${c.key} label`).toBeTruthy();
      expect(cap[id]?.description, `${c.key} description`).toBeTruthy();
    }
  });
});
