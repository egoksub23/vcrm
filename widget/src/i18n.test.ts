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
