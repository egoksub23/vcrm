// ============================================================
// Merchant Application, Part 5 "Commercial terms / Terma komersial": the DEFAULT TEXT of its two boxes.
//
//   >>> The owner's agreed default points go here. <<<
//
// Part 5 of the template is exactly two boxes of text the sender writes (static text placements, see ./layout.ts):
//   * "Platform fee / Yuran platform"  ->  DEFAULT_COMMERCIAL_TERMS   the fee lines (FPX, credit card, debit card) and the payment channel note,
//                                                                     one per line
//   * "Key terms / Terma utama"        ->  DEFAULT_KEY_TERMS          up to 15 numbered points
// A box starts with the text below and the sender replaces it in the template editor (or per document, on a draft) before sending; the
// merchant sees it printed, read-only. There is no data field behind the boxes: the text is the placement's own `text`.
//
// How to drop the owner's text in
//   1. Easiest: replace the two strings at the bottom (DEFAULT_COMMERCIAL_TERMS, DEFAULT_KEY_TERMS) with the real text, written as plain
//      lines. English and Bahasa Malaysia on the same line, "English / Bahasa Malaysia", is the convention of the whole template; a line
//      break between two points (or between the two languages of a point) is printed as a break.
//   2. Or fill in the `text` of the points below (the title stays "English / Bahasa Malaysia"; the text is whatever the owner wrote).
//   Then rebuild the template file and raise the add-on version (docs/doc-sign-setup.md, "Merchant Registration 3.0"): the text is part of the
//   placements, so a workspace that already installed an older version only gets it by pressing Update, and then as a new copy of the template.
//
// What fits
//   Both boxes print at a FIXED 8 pt (see ./layout.ts), wrapped to the box and honouring line breaks, so the sealed file looks the same whatever
//   the length. A text that does not fit its box is never cut silently: the template editor warns when it is saved, and sending a document is
//   REFUSED with a clear message (static_text_does_not_fit) until the text is shortened or the box is made bigger. The ceiling a request may
//   carry is MAX_STATIC_TEXT (6,000 characters, ../../rules.ts); the real limit is what the box holds (see PART5 in ./layout.ts): 49 lines
//   of 8 pt for the key terms and 17 for the platform fee. Fifteen points of about 250 characters each (30 to 45 lines) fit, in Malay or
//   English, and so do fifteen of 350 characters; fifteen of about 400 do not, and are refused.
// ============================================================

/** The most points the key terms box is designed for. More than this is not refused by a count: the box simply has to hold the lines. */
export const KEY_TERMS_MAX_POINTS = 15;

/** A line in both languages. */
interface Bi {
  en: string;
  ms: string;
}

const bi = (b: Bi) => `${b.en} / ${b.ms}`;

/** What stands where the agreed wording goes. The sender replaces it in the template editor. */
const WORDING = "[insert the agreed wording / masukkan perkataan yang dipersetujui]";
const RATE = "[insert the agreed rate / masukkan kadar yang dipersetujui]";
const NOTE = "[insert the payment channel note / masukkan nota saluran pembayaran]";

// ---- the platform fee box ---------------------------------------------------------------------------------------------

interface FeeLine {
  /** The label, "English / Bahasa Malaysia" where it has both. */
  label: string;
  /** The agreed rate or note, written however the owner likes; absent means the placeholder. */
  text?: string;
  placeholder: string;
}

/** One line each. The sender replaces the placeholder after the colon; a line may be added, removed or run onto a second line. */
export const DEFAULT_FEE_LINES: FeeLine[] = [
  { label: "FPX", placeholder: RATE },
  { label: "Credit card / Kad kredit", placeholder: RATE },
  { label: "Debit card / Kad debit", placeholder: RATE },
  { label: "Payment channel note / Nota saluran pembayaran", placeholder: NOTE },
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

/** "FPX: [insert the agreed rate / masukkan kadar yang dipersetujui]", one line per fee. */
export function commercialTermsText(lines: readonly FeeLine[] = DEFAULT_FEE_LINES): string {
  return lines.map((l) => `${l.label}: ${l.text ?? l.placeholder}`).join("\n");
}

/** "1. Partner / Rakan kongsi: [insert the agreed wording / masukkan perkataan yang dipersetujui]", one numbered point per line. */
export function keyTermsText(points: readonly KeyPoint[] = DEFAULT_KEY_POINTS): string {
  return points.map((p, i) => `${i + 1}. ${bi(p.title)}: ${p.text ?? WORDING}`).join("\n");
}

/** The text the commercial box starts with. */
export const DEFAULT_COMMERCIAL_TERMS: string = commercialTermsText();

/** The text the key terms box starts with. */
export const DEFAULT_KEY_TERMS: string = keyTermsText();
