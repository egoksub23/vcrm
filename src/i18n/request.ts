import { getRequestConfig } from 'next-intl/server';

import { mergeMessages, normalizeLocale, resolveLocale } from '@/lib/i18n/locales';
import { loadLocalePreferences } from '@/lib/i18n/preferences';

// Language is chosen per request: the signed-in person's own setting, then their
// workspace's, then the deployment's default (NEXT_PUBLIC_APP_LOCALE, inlined at
// build time), then English. Signed-out pages use the deployment default.
export default getRequestConfig(async () => {
  const deployment = normalizeLocale(process.env.NEXT_PUBLIC_APP_LOCALE);
  const prefs = await loadLocalePreferences();
  const locale = resolveLocale({ user: prefs.user, account: prefs.account, deployment });

  const english = (await import('../../messages/en.json')).default;
  if (locale === 'en') return { locale, messages: english };

  // English underneath, so a key not translated yet reads in English instead of
  // showing as a raw key path (there is no per-key fallback in next-intl).
  try {
    const translated = (await import(`../../messages/${locale}.json`)).default;
    return { locale, messages: mergeMessages(english, translated) };
  } catch {
    return { locale: 'en', messages: english };
  }
});
