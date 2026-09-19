import { describe, expect, it } from 'vitest';

import { checkEmail, checkPhone, checkText, hasNonPhoneIdentity } from './contact-fields';
import {
  COUNTRY_CODES,
  LANGUAGE_CODES,
  countryOptions,
  isCountryCode,
  isLanguageCode,
  languageName,
  regionName,
  withCurrent,
} from './locale-options';

describe('checkEmail', () => {
  it('clears on blank, accepts an address, rejects junk', () => {
    expect(checkEmail('  ')).toEqual({ ok: true, value: null });
    expect(checkEmail(' a@b.com ')).toEqual({ ok: true, value: 'a@b.com' });
    expect(checkEmail('nope')).toEqual({ ok: false, reason: 'email_invalid' });
    expect(checkEmail('a@b')).toEqual({ ok: false, reason: 'email_invalid' });
  });
});

describe('checkPhone', () => {
  it('accepts a formatted international number as typed', () => {
    expect(checkPhone('+60  12-675 9416', { canBeEmpty: false })).toEqual({ ok: true, value: '+60 12-675 9416' });
  });
  it('rejects letters and out-of-range lengths', () => {
    expect(checkPhone('01x', { canBeEmpty: false })).toEqual({ ok: false, reason: 'phone_invalid' });
    expect(checkPhone('12345', { canBeEmpty: false })).toEqual({ ok: false, reason: 'phone_invalid' });
    expect(checkPhone('+1234567890123456', { canBeEmpty: false })).toEqual({ ok: false, reason: 'phone_invalid' });
  });
  it('only allows blank for contacts identified another way', () => {
    expect(checkPhone('', { canBeEmpty: false })).toEqual({ ok: false, reason: 'phone_required' });
    expect(checkPhone('', { canBeEmpty: true })).toEqual({ ok: true, value: '' });
  });
});

describe('hasNonPhoneIdentity', () => {
  it('detects each alternative identity', () => {
    expect(hasNonPhoneIdentity({})).toBe(false);
    expect(hasNonPhoneIdentity({ wa_user_id: 'US.1' })).toBe(true);
    expect(hasNonPhoneIdentity({ messenger_psid: 'x' })).toBe(true);
    expect(hasNonPhoneIdentity({ widget_visitor_id: 'y' })).toBe(true);
  });
});

describe('checkText', () => {
  it('trims, nulls blanks, caps length', () => {
    expect(checkText('  Jidin ')).toEqual({ ok: true, value: 'Jidin' });
    expect(checkText('')).toEqual({ ok: true, value: null });
    expect(checkText('x'.repeat(121))).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('locale options', () => {
  it('lists valid, unique codes', () => {
    expect(COUNTRY_CODES.every(isCountryCode)).toBe(true);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect(COUNTRY_CODES).toContain('MY');
    expect(LANGUAGE_CODES.every(isLanguageCode)).toBe(true);
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length);
  });

  it('names codes in the requested locale', () => {
    expect(regionName('MY', 'en')).toBe('Malaysia');
    expect(languageName('ms', 'en')).toBe('Malay');
    expect(countryOptions('en').find((o) => o.code === 'MY')?.name).toBe('Malaysia');
  });

  it('keeps a stored code the list does not offer', () => {
    const opts = [{ code: 'en', name: 'English' }];
    expect(withCurrent(opts, 'pt-BR', (c) => c)).toEqual([...opts, { code: 'pt-BR', name: 'pt-BR' }]);
    expect(withCurrent(opts, 'en', (c) => c)).toBe(opts);
    expect(withCurrent(opts, null, (c) => c)).toBe(opts);
  });

  it('validates code shapes', () => {
    expect(isCountryCode('my')).toBe(false);
    expect(isLanguageCode('pt-BR')).toBe(true);
    expect(isLanguageCode('English')).toBe(false);
  });
});
