import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@/lib/auth/capabilities';
import { addonFullyApplies } from '@/lib/teams/members';

import { addonChangeCount, addonSaveBody, addonSwitchBlocked, savedAddonSet, type AddonDraft } from './addon-role-helpers';

const draft = (over: Partial<AddonDraft> = {}, caps: string[] = ['menu.kyc', 'kyc.view']): AddonDraft => ({
  name: 'KYC reviewer',
  description: 'Looks at ID checks',
  capabilities: new Set(caps),
  ...over,
});

describe('savedAddonSet', () => {
  it('keeps only keys that exist in the catalogue, and copes with none', () => {
    expect(savedAddonSet(['menu.kyc', 'not.a.capability', 'kyc.view'])).toEqual(new Set(['menu.kyc', 'kyc.view']));
    expect(savedAddonSet(undefined).size).toBe(0);
    expect(savedAddonSet([]).size).toBe(0);
  });
});

describe('addonChangeCount', () => {
  it('is zero for an untouched draft, whatever the spaces around the text', () => {
    expect(addonChangeCount(draft(), draft())).toBe(0);
    expect(addonChangeCount(draft(), draft({ name: '  KYC reviewer ', description: ' Looks at ID checks  ' }))).toBe(0);
  });

  it('counts the name, the description, and each permission added or taken out', () => {
    expect(addonChangeCount(draft(), draft({ name: 'KYC checker' }))).toBe(1);
    expect(addonChangeCount(draft(), draft({ description: '' }))).toBe(1);
    expect(addonChangeCount(draft(), draft({}, ['menu.kyc', 'kyc.view', 'kyc.decide']))).toBe(1);
    expect(addonChangeCount(draft(), draft({}, ['menu.kyc']))).toBe(1);
    expect(addonChangeCount(draft(), draft({ name: 'x' }, ['kyc.decide']))).toBe(1 + 1 + 2);
  });
});

describe('addonSaveBody', () => {
  it('is null when nothing changed, and when the name was emptied', () => {
    expect(addonSaveBody(draft(), draft())).toBeNull();
    expect(addonSaveBody(draft(), draft({ name: '   ' }))).toBeNull();
  });

  it('sends only what changed', () => {
    expect(addonSaveBody(draft(), draft({ name: ' KYC checker ' }))).toEqual({ name: 'KYC checker' });
    expect(addonSaveBody(draft(), draft({ description: 'New words' }))).toEqual({ description: 'New words' });
    // clearing the description is a change, sent as empty text
    expect(addonSaveBody(draft(), draft({ description: '' }))).toEqual({ description: '' });
  });

  it('sends the WHOLE new set of permissions, in the catalogue order, only when it differs', () => {
    const body = addonSaveBody(draft(), draft({}, ['kyc.view', 'kyc.decide', 'menu.kyc']));
    expect(body).toEqual({ capabilities: CAPABILITIES.map((c) => c.key).filter((k) => ['menu.kyc', 'kyc.view', 'kyc.decide'].includes(k)) });
    // taking every permission out is a real change
    expect(addonSaveBody(draft(), draft({}, []))).toEqual({ capabilities: [] });
    expect(addonSaveBody(draft({}, []), draft({}, []))).toBeNull();
  });
});

describe('addonSwitchBlocked', () => {
  const held = new Set(['menu.kyc']);

  it('lets a permission be switched ON only by someone who holds it', () => {
    expect(addonSwitchBlocked({ key: 'menu.kyc' }, false, held)).toBeNull();
    expect(addonSwitchBlocked({ key: 'kyc.decide' }, false, held)).toBe('not-held');
  });

  it('always lets a permission be switched OFF: taking one out needs none', () => {
    expect(addonSwitchBlocked({ key: 'kyc.decide' }, true, held)).toBeNull();
    expect(addonSwitchBlocked({ key: 'menu.kyc' }, true, new Set())).toBeNull();
  });
});

describe('addonFullyApplies', () => {
  it('is true when the base role is at least the lowest one every permission applies to', () => {
    expect(addonFullyApplies({ minBaseRole: 'agent' }, 'agent')).toBe(true);
    expect(addonFullyApplies({ minBaseRole: 'agent' }, 'admin')).toBe(true);
    expect(addonFullyApplies({ minBaseRole: 'agent' }, 'viewer')).toBe(false);
    expect(addonFullyApplies({ minBaseRole: 'viewer' }, 'viewer')).toBe(true);
    expect(addonFullyApplies({ minBaseRole: 'admin' }, 'agent')).toBe(false);
  });
});
