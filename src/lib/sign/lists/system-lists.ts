// ============================================================
// The option lists every workspace starts with ("system lists"). They are shipped with the product and copied into
// each workspace by the database (migration 163: `sign_option_list_defaults` and `sign_seed_option_lists`), where an
// admin may relabel them and add to them; a system list's values (its keys) cannot be deleted, so a form that names
// one can never lose an answer's meaning.
//
// This file is the single source. `systemListsSql()` (migration-sql.ts) turns it into the rows of migration 163 and a
// test fails if the migration drifts from it. When a list changes, change it here, add a new migration that updates
// `sign_option_list_defaults` (and bumps `version`), and let the admin press "Reset to default" where they want it.
//
// TO CONFIRM with the owner (the values were not supplied): the company registration ID types, the e-invoice phases
// by turnover, the tax types, the bank names, and the Bahasa Melayu country names. They are sensible Malaysian
// values; a stored value (the key) is stable, a label can be changed in Settings at any time.
// The values of states_my, company_id_types, einvoice_phases and tax_types match what the Merchant Registration
// add-on has used since Phase 1B, so a form switched to these lists keeps every answer already stored.
// ============================================================

import type { L10n } from "../forms/types";
import { msicItems } from "./msic";
import type { ListItem, ListKind } from "./types";

export interface SystemListDef {
  key: string;
  name: string;
  description: string;
  kind: ListKind;
  items: ListItem[];
  /** Bumped when the shipped content changes. */
  version: number;
  position: number;
}

/** English, Bahasa Melayu, then Chinese and Korean where the wording is confident. */
const L = (en: string, ms: string, zh?: string, ko?: string): L10n => ({ en, ms, ...(zh ? { zh } : {}), ...(ko ? { ko } : {}) });
const item = (value: string, label: L10n): ListItem => ({ value, label });
/** A name that is the same in every language (a proper noun). */
const same = (value: string, name: string): ListItem => item(value, { en: name });

// ---- states: the 13 states and 3 federal territories ------------------------------------------------------------

export const STATES_MY: ListItem[] = [
  item("johor", L("Johor", "Johor", "柔佛", "조호르")),
  item("kedah", L("Kedah", "Kedah", "吉打", "케다")),
  item("kelantan", L("Kelantan", "Kelantan", "吉兰丹", "클란탄")),
  item("melaka", L("Melaka", "Melaka", "马六甲", "믈라카")),
  item("negeri_sembilan", L("Negeri Sembilan", "Negeri Sembilan", "森美兰", "느그리슴빌란")),
  item("pahang", L("Pahang", "Pahang", "彭亨", "파항")),
  item("perak", L("Perak", "Perak", "霹雳", "페락")),
  item("perlis", L("Perlis", "Perlis", "玻璃市", "페를리스")),
  item("pulau_pinang", L("Pulau Pinang", "Pulau Pinang", "槟城", "페낭")),
  item("sabah", L("Sabah", "Sabah", "沙巴", "사바")),
  item("sarawak", L("Sarawak", "Sarawak", "砂拉越", "사라왁")),
  item("selangor", L("Selangor", "Selangor", "雪兰莪", "슬랑오르")),
  item("terengganu", L("Terengganu", "Terengganu", "登嘉楼", "트렝가누")),
  item("wp_kuala_lumpur", L("W.P. Kuala Lumpur", "W.P. Kuala Lumpur", "吉隆坡联邦直辖区", "쿠알라룸푸르 연방직할지")),
  item("wp_putrajaya", L("W.P. Putrajaya", "W.P. Putrajaya", "布城联邦直辖区", "푸트라자야 연방직할지")),
  item("wp_labuan", L("W.P. Labuan", "W.P. Labuan", "纳闽联邦直辖区", "라부안 연방직할지")),
];

// ---- countries: ISO 3166-1 (249 entries), Malaysia first, then by English name --------------------------------------

/** [alpha-2, English name, Malay name]. The Malay names are the ones in common use in Malaysia: to confirm. */
const COUNTRY_ROWS: readonly (readonly [string, string, string])[] = [
  ["AF", "Afghanistan", "Afghanistan"],
  ["AX", "Åland Islands", "Kepulauan Åland"],
  ["AL", "Albania", "Albania"],
  ["DZ", "Algeria", "Algeria"],
  ["AS", "American Samoa", "Samoa Amerika"],
  ["AD", "Andorra", "Andorra"],
  ["AO", "Angola", "Angola"],
  ["AI", "Anguilla", "Anguilla"],
  ["AQ", "Antarctica", "Antartika"],
  ["AG", "Antigua and Barbuda", "Antigua dan Barbuda"],
  ["AR", "Argentina", "Argentina"],
  ["AM", "Armenia", "Armenia"],
  ["AW", "Aruba", "Aruba"],
  ["AU", "Australia", "Australia"],
  ["AT", "Austria", "Austria"],
  ["AZ", "Azerbaijan", "Azerbaijan"],
  ["BS", "Bahamas", "Bahamas"],
  ["BH", "Bahrain", "Bahrain"],
  ["BD", "Bangladesh", "Bangladesh"],
  ["BB", "Barbados", "Barbados"],
  ["BY", "Belarus", "Belarus"],
  ["BE", "Belgium", "Belgium"],
  ["BZ", "Belize", "Belize"],
  ["BJ", "Benin", "Benin"],
  ["BM", "Bermuda", "Bermuda"],
  ["BT", "Bhutan", "Bhutan"],
  ["BO", "Bolivia", "Bolivia"],
  ["BQ", "Bonaire, Sint Eustatius and Saba", "Bonaire, Sint Eustatius dan Saba"],
  ["BA", "Bosnia and Herzegovina", "Bosnia dan Herzegovina"],
  ["BW", "Botswana", "Botswana"],
  ["BV", "Bouvet Island", "Pulau Bouvet"],
  ["BR", "Brazil", "Brazil"],
  ["IO", "British Indian Ocean Territory", "Wilayah Lautan Hindi British"],
  ["BN", "Brunei", "Brunei"],
  ["BG", "Bulgaria", "Bulgaria"],
  ["BF", "Burkina Faso", "Burkina Faso"],
  ["BI", "Burundi", "Burundi"],
  ["CV", "Cabo Verde", "Tanjung Verde"],
  ["KH", "Cambodia", "Kemboja"],
  ["CM", "Cameroon", "Cameroon"],
  ["CA", "Canada", "Kanada"],
  ["KY", "Cayman Islands", "Kepulauan Cayman"],
  ["CF", "Central African Republic", "Republik Afrika Tengah"],
  ["TD", "Chad", "Chad"],
  ["CL", "Chile", "Chile"],
  ["CN", "China", "China"],
  ["CX", "Christmas Island", "Pulau Krismas"],
  ["CC", "Cocos (Keeling) Islands", "Kepulauan Cocos (Keeling)"],
  ["CO", "Colombia", "Colombia"],
  ["KM", "Comoros", "Comoros"],
  ["CG", "Congo", "Congo"],
  ["CD", "Congo (Democratic Republic of the)", "Republik Demokratik Congo"],
  ["CK", "Cook Islands", "Kepulauan Cook"],
  ["CR", "Costa Rica", "Costa Rica"],
  ["CI", "Côte d'Ivoire", "Côte d'Ivoire"],
  ["HR", "Croatia", "Croatia"],
  ["CU", "Cuba", "Cuba"],
  ["CW", "Curaçao", "Curaçao"],
  ["CY", "Cyprus", "Cyprus"],
  ["CZ", "Czechia", "Republik Czech"],
  ["DK", "Denmark", "Denmark"],
  ["DJ", "Djibouti", "Djibouti"],
  ["DM", "Dominica", "Dominica"],
  ["DO", "Dominican Republic", "Republik Dominica"],
  ["EC", "Ecuador", "Ecuador"],
  ["EG", "Egypt", "Mesir"],
  ["SV", "El Salvador", "El Salvador"],
  ["GQ", "Equatorial Guinea", "Guinea Khatulistiwa"],
  ["ER", "Eritrea", "Eritrea"],
  ["EE", "Estonia", "Estonia"],
  ["SZ", "Eswatini", "Eswatini"],
  ["ET", "Ethiopia", "Ethiopia"],
  ["FK", "Falkland Islands (Malvinas)", "Kepulauan Falkland (Malvinas)"],
  ["FO", "Faroe Islands", "Kepulauan Faroe"],
  ["FJ", "Fiji", "Fiji"],
  ["FI", "Finland", "Finland"],
  ["FR", "France", "Perancis"],
  ["GF", "French Guiana", "Guiana Perancis"],
  ["PF", "French Polynesia", "Polinesia Perancis"],
  ["TF", "French Southern Territories", "Wilayah Selatan Perancis"],
  ["GA", "Gabon", "Gabon"],
  ["GM", "Gambia", "Gambia"],
  ["GE", "Georgia", "Georgia"],
  ["DE", "Germany", "Jerman"],
  ["GH", "Ghana", "Ghana"],
  ["GI", "Gibraltar", "Gibraltar"],
  ["GR", "Greece", "Greece"],
  ["GL", "Greenland", "Greenland"],
  ["GD", "Grenada", "Grenada"],
  ["GP", "Guadeloupe", "Guadeloupe"],
  ["GU", "Guam", "Guam"],
  ["GT", "Guatemala", "Guatemala"],
  ["GG", "Guernsey", "Guernsey"],
  ["GN", "Guinea", "Guinea"],
  ["GW", "Guinea-Bissau", "Guinea-Bissau"],
  ["GY", "Guyana", "Guyana"],
  ["HT", "Haiti", "Haiti"],
  ["HM", "Heard Island and McDonald Islands", "Pulau Heard dan Kepulauan McDonald"],
  ["VA", "Holy See (Vatican City State)", "Takhta Suci (Vatican)"],
  ["HN", "Honduras", "Honduras"],
  ["HK", "Hong Kong", "Hong Kong"],
  ["HU", "Hungary", "Hungary"],
  ["IS", "Iceland", "Iceland"],
  ["IN", "India", "India"],
  ["ID", "Indonesia", "Indonesia"],
  ["IR", "Iran", "Iran"],
  ["IQ", "Iraq", "Iraq"],
  ["IE", "Ireland", "Ireland"],
  ["IM", "Isle of Man", "Pulau Man"],
  ["IL", "Israel", "Israel"],
  ["IT", "Italy", "Itali"],
  ["JM", "Jamaica", "Jamaica"],
  ["JP", "Japan", "Jepun"],
  ["JE", "Jersey", "Jersey"],
  ["JO", "Jordan", "Jordan"],
  ["KZ", "Kazakhstan", "Kazakhstan"],
  ["KE", "Kenya", "Kenya"],
  ["KI", "Kiribati", "Kiribati"],
  ["KP", "North Korea", "Korea Utara"],
  ["KR", "South Korea", "Korea Selatan"],
  ["KW", "Kuwait", "Kuwait"],
  ["KG", "Kyrgyzstan", "Kyrgyzstan"],
  ["LA", "Laos", "Laos"],
  ["LV", "Latvia", "Latvia"],
  ["LB", "Lebanon", "Lubnan"],
  ["LS", "Lesotho", "Lesotho"],
  ["LR", "Liberia", "Liberia"],
  ["LY", "Libya", "Libya"],
  ["LI", "Liechtenstein", "Liechtenstein"],
  ["LT", "Lithuania", "Lithuania"],
  ["LU", "Luxembourg", "Luxembourg"],
  ["MO", "Macao", "Macau"],
  ["MG", "Madagascar", "Madagascar"],
  ["MW", "Malawi", "Malawi"],
  ["MY", "Malaysia", "Malaysia"],
  ["MV", "Maldives", "Maldives"],
  ["ML", "Mali", "Mali"],
  ["MT", "Malta", "Malta"],
  ["MH", "Marshall Islands", "Kepulauan Marshall"],
  ["MQ", "Martinique", "Martinique"],
  ["MR", "Mauritania", "Mauritania"],
  ["MU", "Mauritius", "Mauritius"],
  ["YT", "Mayotte", "Mayotte"],
  ["MX", "Mexico", "Mexico"],
  ["FM", "Micronesia", "Micronesia"],
  ["MD", "Moldova", "Moldova"],
  ["MC", "Monaco", "Monaco"],
  ["MN", "Mongolia", "Mongolia"],
  ["ME", "Montenegro", "Montenegro"],
  ["MS", "Montserrat", "Montserrat"],
  ["MA", "Morocco", "Maghribi"],
  ["MZ", "Mozambique", "Mozambique"],
  ["MM", "Myanmar", "Myanmar"],
  ["NA", "Namibia", "Namibia"],
  ["NR", "Nauru", "Nauru"],
  ["NP", "Nepal", "Nepal"],
  ["NL", "Netherlands", "Belanda"],
  ["NC", "New Caledonia", "Caledonia Baru"],
  ["NZ", "New Zealand", "New Zealand"],
  ["NI", "Nicaragua", "Nicaragua"],
  ["NE", "Niger", "Niger"],
  ["NG", "Nigeria", "Nigeria"],
  ["NU", "Niue", "Niue"],
  ["NF", "Norfolk Island", "Pulau Norfolk"],
  ["MK", "North Macedonia", "Macedonia Utara"],
  ["MP", "Northern Mariana Islands", "Kepulauan Mariana Utara"],
  ["NO", "Norway", "Norway"],
  ["OM", "Oman", "Oman"],
  ["PK", "Pakistan", "Pakistan"],
  ["PW", "Palau", "Palau"],
  ["PS", "Palestine", "Palestin"],
  ["PA", "Panama", "Panama"],
  ["PG", "Papua New Guinea", "Papua New Guinea"],
  ["PY", "Paraguay", "Paraguay"],
  ["PE", "Peru", "Peru"],
  ["PH", "Philippines", "Filipina"],
  ["PN", "Pitcairn", "Pitcairn"],
  ["PL", "Poland", "Poland"],
  ["PT", "Portugal", "Portugal"],
  ["PR", "Puerto Rico", "Puerto Rico"],
  ["QA", "Qatar", "Qatar"],
  ["RE", "Réunion", "Réunion"],
  ["RO", "Romania", "Romania"],
  ["RU", "Russia", "Rusia"],
  ["RW", "Rwanda", "Rwanda"],
  ["BL", "Saint Barthélemy", "Saint Barthélemy"],
  ["SH", "Saint Helena, Ascension and Tristan da Cunha", "Saint Helena, Ascension dan Tristan da Cunha"],
  ["KN", "Saint Kitts and Nevis", "Saint Kitts dan Nevis"],
  ["LC", "Saint Lucia", "Saint Lucia"],
  ["MF", "Saint Martin (French part)", "Saint Martin (bahagian Perancis)"],
  ["PM", "Saint Pierre and Miquelon", "Saint Pierre dan Miquelon"],
  ["VC", "Saint Vincent and the Grenadines", "Saint Vincent dan Grenadines"],
  ["WS", "Samoa", "Samoa"],
  ["SM", "San Marino", "San Marino"],
  ["ST", "Sao Tome and Principe", "Sao Tome dan Principe"],
  ["SA", "Saudi Arabia", "Arab Saudi"],
  ["SN", "Senegal", "Senegal"],
  ["RS", "Serbia", "Serbia"],
  ["SC", "Seychelles", "Seychelles"],
  ["SL", "Sierra Leone", "Sierra Leone"],
  ["SG", "Singapore", "Singapura"],
  ["SX", "Sint Maarten (Dutch part)", "Sint Maarten (bahagian Belanda)"],
  ["SK", "Slovakia", "Slovakia"],
  ["SI", "Slovenia", "Slovenia"],
  ["SB", "Solomon Islands", "Kepulauan Solomon"],
  ["SO", "Somalia", "Somalia"],
  ["ZA", "South Africa", "Afrika Selatan"],
  ["GS", "South Georgia and the South Sandwich Islands", "Georgia Selatan dan Kepulauan Sandwich Selatan"],
  ["SS", "South Sudan", "Sudan Selatan"],
  ["ES", "Spain", "Sepanyol"],
  ["LK", "Sri Lanka", "Sri Lanka"],
  ["SD", "Sudan", "Sudan"],
  ["SR", "Suriname", "Suriname"],
  ["SJ", "Svalbard and Jan Mayen", "Svalbard dan Jan Mayen"],
  ["SE", "Sweden", "Sweden"],
  ["CH", "Switzerland", "Switzerland"],
  ["SY", "Syria", "Syria"],
  ["TW", "Taiwan", "Taiwan"],
  ["TJ", "Tajikistan", "Tajikistan"],
  ["TZ", "Tanzania", "Tanzania"],
  ["TH", "Thailand", "Thailand"],
  ["TL", "Timor-Leste", "Timor-Leste"],
  ["TG", "Togo", "Togo"],
  ["TK", "Tokelau", "Tokelau"],
  ["TO", "Tonga", "Tonga"],
  ["TT", "Trinidad and Tobago", "Trinidad dan Tobago"],
  ["TN", "Tunisia", "Tunisia"],
  ["TR", "Türkiye", "Turki"],
  ["TM", "Turkmenistan", "Turkmenistan"],
  ["TC", "Turks and Caicos Islands", "Kepulauan Turks dan Caicos"],
  ["TV", "Tuvalu", "Tuvalu"],
  ["UG", "Uganda", "Uganda"],
  ["UA", "Ukraine", "Ukraine"],
  ["AE", "United Arab Emirates", "Emiriah Arab Bersatu"],
  ["GB", "United Kingdom", "United Kingdom"],
  ["US", "United States", "Amerika Syarikat"],
  ["UM", "United States Minor Outlying Islands", "Kepulauan Terpencil Kecil Amerika Syarikat"],
  ["UY", "Uruguay", "Uruguay"],
  ["UZ", "Uzbekistan", "Uzbekistan"],
  ["VU", "Vanuatu", "Vanuatu"],
  ["VE", "Venezuela", "Venezuela"],
  ["VN", "Vietnam", "Vietnam"],
  ["VG", "Virgin Islands (British)", "Kepulauan Virgin British"],
  ["VI", "Virgin Islands (U.S.)", "Kepulauan Virgin Amerika Syarikat"],
  ["WF", "Wallis and Futuna", "Wallis dan Futuna"],
  ["EH", "Western Sahara", "Sahara Barat"],
  ["YE", "Yemen", "Yaman"],
  ["ZM", "Zambia", "Zambia"],
  ["ZW", "Zimbabwe", "Zimbabwe"],
];

/** Chinese and Korean names for the countries a Malaysian business deals with most; the rest read in English. */
const COUNTRY_ZH_KO: Record<string, readonly [string, string]> = {
  MY: ["马来西亚", "말레이시아"],
  SG: ["新加坡", "싱가포르"],
  BN: ["文莱", "브루나이"],
  ID: ["印度尼西亚", "인도네시아"],
  TH: ["泰国", "태국"],
  PH: ["菲律宾", "필리핀"],
  VN: ["越南", "베트남"],
  CN: ["中国", "중국"],
  HK: ["中国香港", "홍콩"],
  TW: ["中国台湾", "대만"],
  JP: ["日本", "일본"],
  KR: ["韩国", "대한민국"],
  IN: ["印度", "인도"],
  AU: ["澳大利亚", "호주"],
  GB: ["英国", "영국"],
  US: ["美国", "미국"],
};

export const COUNTRIES: ListItem[] = [
  // Malaysia first, then the rest by English name (the order above)
  ...COUNTRY_ROWS.filter(([c]) => c === "MY"),
  ...COUNTRY_ROWS.filter(([c]) => c !== "MY"),
].map(([code, en, ms]) => {
  const zk = COUNTRY_ZH_KO[code];
  return item(code, L(en, ms, zk?.[0], zk?.[1]));
});

// ---- banks: the principal banks in Malaysia (to confirm) --------------------------------------------------------

export const BANKS_MY: ListItem[] = [
  same("maybank", "Maybank"),
  same("cimb", "CIMB Bank"),
  same("public_bank", "Public Bank"),
  same("rhb", "RHB Bank"),
  same("hong_leong", "Hong Leong Bank"),
  same("ambank", "AmBank"),
  same("bank_islam", "Bank Islam"),
  same("bank_rakyat", "Bank Rakyat"),
  same("bsn", "Bank Simpanan Nasional (BSN)"),
  same("affin", "Affin Bank"),
  same("alliance", "Alliance Bank"),
  same("ocbc", "OCBC Bank"),
  same("uob", "UOB"),
  same("hsbc", "HSBC Bank"),
  same("standard_chartered", "Standard Chartered"),
  same("mbsb", "MBSB Bank"),
  same("bank_muamalat", "Bank Muamalat"),
  same("agrobank", "Agrobank"),
  same("citibank", "Citibank"),
  same("al_rajhi", "Al Rajhi Bank"),
  same("bank_of_china", "Bank of China (Malaysia)"),
  same("kfh", "Kuwait Finance House (Malaysia)"),
  same("mufg", "MUFG Bank (Malaysia)"),
  same("boost_bank", "Boost Bank"),
  same("gx_bank", "GX Bank"),
  same("aeon_bank", "AEON Bank"),
  same("kaf_digital", "KAF Digital Bank"),
  same("ryt_bank", "Ryt Bank"),
  item("other", L("Other", "Lain-lain", "其他", "기타")),
];

// ---- company registration ID types, e-invoice phases, tax types (all to confirm) ---------------------------------

export const COMPANY_ID_TYPES: ListItem[] = [
  item("nric", L("NRIC", "NRIC", "身份证 (NRIC)", "신분증 (NRIC)")),
  item("roc", L("ROC (company registration no.)", "ROC (no. pendaftaran syarikat)", "ROC（公司注册号）", "ROC (회사 등록번호)")),
  item("brn", L("BRN (business registration no.)", "BRN (no. pendaftaran perniagaan)", "BRN（商业注册号）", "BRN (사업자 등록번호)")),
  item("passport", L("Passport", "Pasport", "护照", "여권")),
  item("army_police", L("Army or police no.", "No. tentera atau polis", "军人或警察编号", "군인·경찰 번호")),
];

/**
 * When the business must start e-invoicing, by annual turnover. The thresholds are written as the published LHDN
 * timeline states them at the time of writing (no dates, which have moved): TO CONFIRM before use.
 */
export const EINVOICE_PHASES: ListItem[] = [
  item("phase_1", L("Phase 1: above RM100 million", "Fasa 1: melebihi RM100 juta", "第一阶段：超过1亿令吉", "1단계: 1억 링깃 초과")),
  item("phase_2", L("Phase 2: above RM25 million to RM100 million", "Fasa 2: melebihi RM25 juta hingga RM100 juta", "第二阶段：超过2500万至1亿令吉", "2단계: 2,500만 링깃 초과 ~ 1억 링깃")),
  item("phase_3", L("Phase 3: above RM5 million to RM25 million", "Fasa 3: melebihi RM5 juta hingga RM25 juta", "第三阶段：超过500万至2500万令吉", "3단계: 500만 링깃 초과 ~ 2,500만 링깃")),
  item("phase_4", L("Phase 4: above RM1 million to RM5 million", "Fasa 4: melebihi RM1 juta hingga RM5 juta", "第四阶段：超过100万至500万令吉", "4단계: 100만 링깃 초과 ~ 500만 링깃")),
  item("not_required", L("Not required: RM1 million or less", "Tidak diwajibkan: RM1 juta atau kurang", "无需：100万令吉或以下", "해당 없음: 100만 링깃 이하")),
];

export const TAX_TYPES: ListItem[] = [
  item("sst", L("SST (Sales and Service Tax)", "SST (Cukai Jualan dan Perkhidmatan)", "SST（销售与服务税）", "SST (판매 및 서비스세)")),
  item("service_tax", L("Service tax", "Cukai perkhidmatan", "服务税", "서비스세")),
  item("sales_tax", L("Sales tax", "Cukai jualan", "销售税", "판매세")),
  item("tourism_tax", L("Tourism tax", "Cukai pelancongan", "旅游税", "관광세")),
  item("na", L("Not applicable", "Tidak berkenaan", "不适用", "해당 없음")),
];

// ---- the definitions --------------------------------------------------------------------------------------------

export const SYSTEM_LISTS: readonly SystemListDef[] = [
  { key: "states_my", name: "States of Malaysia", description: "The 13 states and 3 federal territories.", kind: "options", items: STATES_MY, version: 1, position: 1 },
  { key: "countries", name: "Countries", description: "ISO 3166-1 countries and territories, Malaysia first.", kind: "options", items: COUNTRIES, version: 1, position: 2 },
  { key: "banks_my", name: "Banks in Malaysia", description: "The principal banks, with Other.", kind: "options", items: BANKS_MY, version: 1, position: 3 },
  { key: "company_id_types", name: "Company registration ID types", description: "How a business or a person is identified (SSM, NRIC, passport ...).", kind: "options", items: COMPANY_ID_TYPES, version: 1, position: 4 },
  { key: "einvoice_phases", name: "E-invoice phases by turnover", description: "When a business must start e-invoicing, by yearly turnover.", kind: "options", items: EINVOICE_PHASES, version: 1, position: 5 },
  { key: "tax_types", name: "Tax types", description: "SST, service tax, sales tax, tourism tax or none.", kind: "options", items: TAX_TYPES, version: 1, position: 6 },
  { key: "msic", name: "MSIC business activity codes", description: "Malaysia Standard Industrial Classification 2008 (DOSM), 5-digit codes, used for e-invoicing.", kind: "msic", items: msicItems(), version: 1, position: 7 },
];

