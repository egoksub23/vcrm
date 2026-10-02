import { describe, expect, it } from 'vitest'

import { ALL_KEYS, DICTIONARIES, makeTranslator, matchLocale, resolveLocale, translate } from './i18n'

describe('locale resolution', () => {
  it('matches supported languages by primary subtag', () => {
    expect(matchLocale('ms-MY')).toBe('ms')
    expect(matchLocale('zh_Hans_CN')).toBe('zh')
    expect(matchLocale('EN-gb')).toBe('en')
    expect(matchLocale('fr')).toBeNull()
    expect(matchLocale('')).toBeNull()
    expect(matchLocale(undefined)).toBeNull()
  })

  it('prefers data-lang, then <html lang>, then the browser languages', () => {
    expect(resolveLocale('zh', 'ms', ['en'])).toBe('zh')
    expect(resolveLocale(undefined, 'ms-MY', ['en'])).toBe('ms')
    expect(resolveLocale('', '', ['fr-FR', 'zh-CN', 'en'])).toBe('zh')
  })

  it('ignores an unsupported data-lang in favour of the next source', () => {
    expect(resolveLocale('de', 'ms', [])).toBe('ms')
  })

  it('falls back to English', () => {
    expect(resolveLocale(undefined, '', ['fr', 'de'])).toBe('en')
    expect(resolveLocale(null, null, null)).toBe('en')
  })
})

describe('string lookup', () => {
  it('fills placeholders', () => {
    expect(translate('en', 'unreadMany', { n: 3 })).toBe('3 unread messages')
    expect(translate('ms', 'welcomeBack', { name: 'Aisyah' })).toBe('Selamat kembali, Aisyah!')
    expect(translate('zh', 'unreadMany', { n: 2 })).toBe('2 条未读消息')
  })

  it('leaves unknown placeholders visible rather than dropping them', () => {
    expect(translate('en', 'unreadMany', {})).toBe('{n} unread messages')
  })

  it('binds a locale with makeTranslator', () => {
    const t = makeTranslator('ms')
    expect(t('send')).toBe('Hantar')
  })

  it('has every English key in Malay and Mandarin, with matching placeholders', () => {
    for (const locale of ['ms', 'zh'] as const) {
      for (const key of ALL_KEYS) {
        const value = DICTIONARIES[locale][key]
        expect(value, `${locale}.${key}`).toBeTruthy()
        const en = DICTIONARIES.en[key].match(/\{\w+\}/g)?.sort() ?? []
        const other = value.match(/\{\w+\}/g)?.sort() ?? []
        expect(other, `${locale}.${key} placeholders`).toEqual(en)
      }
    }
  })
})

describe('brand-aware strings', () => {
  const BRANDED = ['choiceExisting', 'claimHint', 'consent', 'linkAccount'] as const

  it('fills the brand name into every sentence that names the company', () => {
    for (const locale of ['en', 'ms', 'zh'] as const) {
      const t = makeTranslator(locale, 'Acme')
      for (const key of BRANDED) expect(t(key), `${locale}.${key}`).toContain('Acme')
    }
  })

  it('uses wording that names nobody when the widget has no brand name (never a dangling blank or another company)', () => {
    for (const locale of ['en', 'ms', 'zh'] as const) {
      for (const brand of [undefined, null, '', '   ']) {
        const t = makeTranslator(locale, brand)
        for (const key of BRANDED) {
          const text = t(key)
          expect(text, `${locale}.${key}`).not.toMatch(/\{brand\}|Vircle|undefined/)
          expect(text, `${locale}.${key}`).not.toMatch(/ {2}/)
        }
      }
    }
    expect(makeTranslator('en', null)('choiceExisting')).toBe("I'm already a customer")
  })

  it('leaves every other string untouched by the brand', () => {
    expect(makeTranslator('en', 'Acme')('back')).toBe('Back')
    expect(makeTranslator('en', 'Acme')('welcomeBack', { name: 'Sam' })).toBe('Welcome back, Sam!')
  })
})

