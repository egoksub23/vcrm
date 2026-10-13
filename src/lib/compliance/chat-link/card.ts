// ============================================================
// Compliance requests, the personal closure form link: the words of the message that carries it, and the shapes it takes on each channel. Pure (no I/O).
//
// The message is a LINK CARD: a title, a short body and one button, never a bare address. Where the channel can show a button it is one (WhatsApp's
// call-to-action button, a Messenger or Instagram button template, the web chat's card, an email's HTML button); where it cannot, the plain text
// "Account closure form: <address>" is sent. The address is part of what goes to the channel and of nothing that is stored: the message row keeps the
// words below and the link's id, so the Inbox renders the card from those and never has the address.
//
// Wording needing a native review: the Malay, Chinese and Korean text below was written for this build.
// ============================================================

import type { CustomerLocale } from "../types";

export const CARD_LOCALES: readonly CustomerLocale[] = ["en", "ms", "zh", "ko"];

export interface CardWords {
  title: string;
  body: string;
  /** The button. WhatsApp allows 20 characters. */
  button: string;
}

export const CARD_WORDS: Record<CustomerLocale, CardWords> = {
  en: {
    title: "Account closure form",
    body: "To close your Vircle account, please open the form below and fill in your details.",
    button: "Open closure form",
  },
  ms: {
    title: "Borang penutupan akaun",
    body: "Untuk menutup akaun Vircle anda, sila buka borang di bawah dan isi butiran anda.",
    button: "Buka borang",
  },
  zh: {
    title: "账户关闭表格",
    body: "如需关闭您的 Vircle 账户，请打开下方表格并填写您的资料。",
    button: "打开表格",
  },
  ko: {
    title: "계정 해지 신청서",
    body: "Vircle 계정을 해지하시려면 아래 양식을 열어 정보를 입력해 주세요.",
    button: "양식 열기",
  },
};

/** WhatsApp's limit for the label of a call-to-action button. */
export const WHATSAPP_BUTTON_MAX = 20;
/** WhatsApp's limit for a header text. */
export const WHATSAPP_HEADER_MAX = 60;

/** A language code from anywhere ("ms-MY", "zh_CN", "english") as one of the four, or null. */
export function cardLocaleOf(value: string | null | undefined): CustomerLocale | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (CARD_LOCALES as readonly string[]).includes(base) ? (base as CustomerLocale) : null;
}

/** The language of the card: the contact's, else the case's, else English. (A conversation has no language of its own.) */
export const cardLocale = (contactLanguage: string | null | undefined, caseLocale?: string | null): CustomerLocale => cardLocaleOf(contactLanguage) ?? cardLocaleOf(caseLocale) ?? "en";

/** The words of the card in a language, with the button cut to what WhatsApp accepts. */
export function cardWords(locale: CustomerLocale): CardWords {
  const w = CARD_WORDS[locale] ?? CARD_WORDS.en;
  return { ...w, button: Array.from(w.button).slice(0, WHATSAPP_BUTTON_MAX).join("") };
}

/** The plain-text message for a channel with no button: "Account closure form: <address>". */
export const fallbackText = (locale: CustomerLocale, url: string): string => `${cardWords(locale).title}: ${url}`;

/** What the message row stores (and the Inbox renders): the words and the link's id. Never the address. */
export interface StoredCard {
  link_id: string;
  title: string;
  body: string;
  button: string;
  locale: CustomerLocale;
}

export const storedCard = (linkId: string, locale: CustomerLocale): StoredCard => ({ link_id: linkId, ...cardWords(locale), locale });

/** Is this value a card as the message row stores it? (For the renderers: anything else is not a card.) */
export function parseStoredCard(v: unknown): StoredCard | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = (v as Record<string, unknown>).link_card ?? v;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const c = o as Record<string, unknown>;
  const s = (x: unknown, max: number): string => (typeof x === "string" ? x.slice(0, max) : "");
  const id = s(c.link_id, 40);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const locale = cardLocaleOf(typeof c.locale === "string" ? c.locale : null) ?? "en";
  return { link_id: id, title: s(c.title, 120), body: s(c.body, 600), button: s(c.button, 60), locale };
}

/** The line shown for the card in a conversation list, a notification, an export or a summary. */
export const cardPreview = (card: Pick<StoredCard, "title">): string => card.title;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The email: a short paragraph and one button (an HTML button for a client that shows it, the address as text under it for one that does not). */
export function cardEmail(locale: CustomerLocale, url: string): { subject: string; html: string; text: string } {
  const w = CARD_WORDS[locale] ?? CARD_WORDS.en;
  const safe = esc(url);
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">` +
    `<p style="margin:0 0 16px">${esc(w.body)}</p>` +
    `<p style="margin:0 0 16px"><a href="${safe}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">${esc(w.button)}</a></p>` +
    `<p style="margin:0;font-size:12px;color:#6b7280">${safe}</p>` +
    `</div>`;
  return { subject: w.title, html, text: `${w.body}\n\n${w.button}: ${url}` };
}
