/**
 * Country and language choices for the contact column. Codes are stored
 * (ISO 3166-1 alpha-2 / ISO 639); names come from `Intl.DisplayNames`
 * in the viewer's locale, so there is no hand-translated list to keep in
 * sync across the app's languages.
 */

/** ISO 3166-1 alpha-2 codes. */
export const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/** Languages offered in the picker (ISO 639-1 unless only a 3-letter code exists). */
export const LANGUAGE_CODES = [
  'en', 'ms', 'zh', 'ta', 'id', 'hi', 'bn', 'ur', 'ar', 'fa', 'tr', 'ru', 'uk', 'pl', 'cs', 'ro', 'hu', 'el', 'he',
  'th', 'vi', 'ko', 'ja', 'fil', 'km', 'my', 'ne', 'si', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'sw', 'af',
];

export interface LocaleOption {
  code: string;
  name: string;
}

function displayName(type: 'region' | 'language', code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const regionName = (code: string, locale: string) => displayName('region', code, locale);
export const languageName = (code: string, locale: string) => displayName('language', code, locale);

function sortedOptions(codes: string[], type: 'region' | 'language', locale: string): LocaleOption[] {
  return codes
    .map((code) => ({ code, name: displayName(type, code, locale) }))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}

export const countryOptions = (locale: string) => sortedOptions(COUNTRY_CODES, 'region', locale);
export const languageOptions = (locale: string) => sortedOptions(LANGUAGE_CODES, 'language', locale);

/**
 * Options plus the current value when it is missing from the list (a
 * stored code we don't offer, e.g. "pt-BR" or a rarer language), so the
 * picker never shows a blank for something that is set.
 */
export function withCurrent(
  options: LocaleOption[],
  current: string | null | undefined,
  nameOf: (code: string) => string,
): LocaleOption[] {
  if (!current || options.some((o) => o.code === current)) return options;
  return [...options, { code: current, name: nameOf(current) }];
}

export const isCountryCode = (v: string) => /^[A-Z]{2}$/.test(v);
export const isLanguageCode = (v: string) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v);
