// ============================================================
// Merchant Application, Part 5 "Commercial terms / Terma komersial": the DEFAULT TEXT of its two boxes.
//
//   >>> The default text of the two boxes goes here. <<<
//
// Part 5 of the template is exactly two boxes of text the sender writes (static text placements, see ./layout.ts):
//   * "Platform fee / Yuran platform"  ->  DEFAULT_COMMERCIAL_TERMS   the owner's real rate text (since add-on 3.2), 23 lines in four groups
//   * "Key terms / Terma utama"        ->  DEFAULT_KEY_TERMS          up to 15 numbered points, still neutral placeholders
// A box starts with the text below and the sender replaces it in the template editor (or per document, on a draft) before sending; the
// merchant sees it printed, read-only. There is no data field behind the boxes: the text is the placement's own `text`, so a sender who
// duplicates the template changes the fee wording in the properties panel of the box, exactly like any fixed text.
//
// How to change the default text
//   1. The platform fee text is DEFAULT_COMMERCIAL_LINES below, one string per printed line, an empty string for a blank line between groups.
//      It is the owner's wording kept as given (capitals, spelling and punctuation included); the only normalisation is that a run of spaces
//      or tabs right before a colon is one space, because the owner aligned columns with tabs, which cannot line up in the proportional
//      PDF font.
//   2. The key terms are DEFAULT_KEY_POINTS (the title stays "English / Bahasa Malaysia"; the text is whatever the owner wrote).
//   A line break between two points (or between the two languages of a point) is printed as a break.
//   Then rebuild the template file and raise the add-on version (docs/doc-sign-setup.md, "Merchant Registration 3.2"): the text is part of the
//   placements, so a workspace that already installed an older version only gets it by pressing Update, and then as a new copy of the template.
//   The placements of the version being replaced are frozen first (./history/, see ../merchant.ts).
//
// What fits
//   Both boxes print at a FIXED 8 pt (see ./layout.ts), wrapped to the box and honouring line breaks, so the sealed file looks the same whatever
//   the length. A text that does not fit its box is never cut silently: the template editor warns when it is saved, and sending a document is
//   REFUSED with a clear message (static_text_does_not_fit) until the text is shortened or the box is made bigger. The ceiling a request may
//   carry is MAX_STATIC_TEXT (6,000 characters, ../../rules.ts); the real limit is what the box holds (see PART5 in ./layout.ts): since 3.2
//   25 lines of 8 pt for the platform fee (its default text is 23 lines) and 42 for the key terms (17 and 49 before 3.2).
// ============================================================

/** The most points the key terms box is designed for. More than this is not refused by a count: the box simply has to hold the lines. */
export const KEY_TERMS_MAX_POINTS = 15;

/** A line in both languages. */
interface Bi {
  en: string;
  ms: string;
}

const bi = (b: Bi) => `${b.en} / ${b.ms}`;

/** What stands where the agreed wording of a key term goes. The sender replaces it in the template editor. */
const WORDING = "[insert the agreed wording / masukkan perkataan yang dipersetujui]";

// ---- the platform fee box ---------------------------------------------------------------------------------------------

/**
 * The owner's rate text (add-on 3.2), one string per printed line; an empty string is the blank line between two groups. It is the owner's
 * wording as given, capitals, spelling and punctuation included ("Duit now OBW" in one line and "Duitnow OBW" in another, "Emandate", "E Wallet"),
 * with one normalisation: the owner aligned the rates with tabs or runs of spaces before the colon, which does not line up in the proportional
 * font of the PDF, so a run of white space right before a colon is one space. A line with no colon is exactly as given.
 *
 * "Payment Gateway (Local Debit Cards)" appears twice (1% and 1.35%); the second is probably meant to be Credit Cards, but it is kept as the owner
 * wrote it. At 8 pt this is 23 lines; the box (PART5.feeBoxH in ./layout.ts) holds 25.
 */
export const DEFAULT_COMMERCIAL_LINES: readonly string[] = [
  "Base platform cost per student : RM 0.00",
  "",
  "POS, E-Store, Meal Plans",
  "3% or RM 0.10 whichever higher",
  "",
  "Invoice & Weblinks Payment Collection - non School Fees Store (Average Ticket sizes under 3,000)",
  "FPX / Duit now OBW : 1% or minimum RM 2",
  "Payment Gateway (Local Cards) : 1.8%",
  "Payment Gateway (Foreign Cards) : 2.75%",
  "E Wallet & Cross Border QR : 2.5%",
  "Emandate - recurring Payment Collection (card and casa Malaysia): 1% + RM 2 per collection",
  "",
  "Invoice & Weblinks Payment Collection - School Term Fees Store (Average Ticket sizes under 3,000)",
  "FPX (Casa and Credit Card) : 0.8%",
  "FPX (Credit Card) : 1% or minimum RM 2",
  "Duitnow OBW : 0.8% or minimum RM 2",
  "Payment Gateway (Local Debit Cards) : 1%",
  "Payment Gateway (Local Debit Cards) : 1.35%",
  "Payment Gateway (Foreign Cards) : 2.5%",
  "E Wallet & Cross Border QR : 2.5%",
  "",
  "All platform fees are inclusive Bank and payment gateway charges (absorbed and paid by Vircle)",
  "All platform fees are exclusive of any applicable taxes (if any is introduced in future)",
];

// ---- the key terms box ------------------------------------------------------------------------------------------------

interface KeyPoint {
  title: Bi;
  /** The agreed wording for the point, written however the owner likes (usually both languages); absent means the placeholder. */
  text?: string;
}

/**
 * The default points, in order; they are numbered 1, 2, 3 ... when the text is made. The nine titles are the nine headings the template had
 * before version 3.0 (it printed a box under each), so the owner can see which old box became which number:
 *   1 Partner (was 5.1)  2 Right to decline (5.2)  3 Information requests (5.3)  4 Account access (5.4)  5 Refund and void (5.5)
 *   6 Termination (5.6)  7 Binding effect (5.7)  8 Hardware (5.8)  9 Settlement (5.9)
 * Add up to six more points (the box is designed for 15), or delete the ones that do not apply and the numbers follow.
 */
export const DEFAULT_KEY_POINTS: KeyPoint[] = [
  { title: { en: "Partner", ms: "Rakan kongsi" } },
  { title: { en: "Right to decline", ms: "Hak menolak" } },
  { title: { en: "Information requests", ms: "Permintaan maklumat" } },
  { title: { en: "Account access", ms: "Akses akaun" } },
  { title: { en: "Refund and void", ms: "Bayaran balik dan pembatalan" } },
  { title: { en: "Termination: 60 days' notice", ms: "Penamatan: notis 60 hari" } },
  { title: { en: "Binding effect of the merchant terms", ms: "Kesan mengikat terma peniaga" } },
  { title: { en: "Hardware", ms: "Perkakasan" } },
  { title: { en: "Settlement: twice weekly", ms: "Penyelesaian: dua kali seminggu" } },
];

// ---- the text of the two boxes ----------------------------------------------------------------------------------------

/** The platform fee text: one printed line per string (an empty string is a blank line). */
export function commercialTermsText(lines: readonly string[] = DEFAULT_COMMERCIAL_LINES): string {
  return lines.join("\n");
}

/** "1. Partner / Rakan kongsi: [insert the agreed wording / masukkan perkataan yang dipersetujui]", one numbered point per line. */
export function keyTermsText(points: readonly KeyPoint[] = DEFAULT_KEY_POINTS): string {
  return points.map((p, i) => `${i + 1}. ${bi(p.title)}: ${p.text ?? WORDING}`).join("\n");
}

/** The text the commercial box starts with. */
export const DEFAULT_COMMERCIAL_TERMS: string = commercialTermsText();

/** The text the key terms box starts with. */
export const DEFAULT_KEY_TERMS: string = keyTermsText();
