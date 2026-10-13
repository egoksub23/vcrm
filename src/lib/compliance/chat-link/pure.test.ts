import { describe, expect, it } from "vitest";

import { CARD_LOCALES, CARD_WORDS, WHATSAPP_BUTTON_MAX, cardEmail, cardLocale, cardLocaleOf, cardPreview, cardWords, fallbackText, parseStoredCard, storedCard } from "./card";
import { planDelivery } from "./channels";
import { LINK_STATES, LINK_TTL_DAYS, canRevoke, canSendAnother, expiryFor, isActiveLink, linkState, type LinkTimes } from "./link-state";
import { LINK_WORDS, linkWords } from "./link-words";
import { maskPhone } from "./mask";
import { hashLinkToken, linkIdOf, linkPath, linkTokensConfigured, mintLinkToken, tokenMatches } from "./token";
import { formSubmittedNoteText, raisedNoteHref, raisedNoteReference, raisedNoteText } from "../raised-note";

// Pure parts of the personal closure form link (migration 185): the state machine, the masked phone, the token, the card and how each channel carries it.

const NOW = new Date("2026-10-13T10:00:00Z");
const link = (over: Partial<LinkTimes> = {}): LinkTimes => ({
  created_at: "2026-10-12T10:00:00Z",
  expires_at: "2026-10-26T10:00:00Z",
  sent_at: null,
  opened_at: null,
  submitted_at: null,
  revoked_at: null,
  revoked_reason: null,
  ...over,
});

describe("the state of a link", () => {
  it("reads made / sent / opened as far as the link got", () => {
    expect(linkState(link(), NOW)).toBe("created");
    expect(linkState(link({ sent_at: "2026-10-12T10:01:00Z" }), NOW)).toBe("sent");
    expect(linkState(link({ sent_at: "2026-10-12T10:01:00Z", opened_at: "2026-10-12T11:00:00Z" }), NOW)).toBe("opened");
  });

  it("is submitted once the form came back, whatever else happened to it", () => {
    expect(linkState(link({ submitted_at: "2026-10-13T09:00:00Z", opened_at: "2026-10-13T08:00:00Z" }), NOW)).toBe("submitted");
    expect(linkState(link({ submitted_at: "2026-10-13T09:00:00Z", expires_at: "2026-10-01T00:00:00Z" }), NOW)).toBe("submitted");
  });

  it("tells a link an agent withdrew from one a newer link replaced", () => {
    expect(linkState(link({ revoked_at: "2026-10-13T09:00:00Z", revoked_reason: "revoked" }), NOW)).toBe("revoked");
    expect(linkState(link({ revoked_at: "2026-10-13T09:00:00Z", revoked_reason: "replaced" }), NOW)).toBe("replaced");
  });

  it("expires at its expiry, to the millisecond", () => {
    expect(linkState(link({ sent_at: "2026-10-12T10:01:00Z" }), new Date("2026-10-26T09:59:59.999Z"))).toBe("sent");
    expect(linkState(link({ sent_at: "2026-10-12T10:01:00Z" }), new Date("2026-10-26T10:00:00Z"))).toBe("expired");
    expect(linkState(link({ opened_at: "2026-10-12T10:01:00Z" }), new Date("2026-11-30T00:00:00Z"))).toBe("expired");
  });

  it("is active only while it can still be used", () => {
    expect(LINK_STATES.filter((s) => s === "created" || s === "sent" || s === "opened").every((s) => canRevoke(s))).toBe(true);
    expect(isActiveLink(link(), NOW)).toBe(true);
    expect(isActiveLink(link({ submitted_at: "2026-10-13T09:00:00Z" }), NOW)).toBe(false);
    expect(isActiveLink(link({ revoked_at: "2026-10-13T09:00:00Z", revoked_reason: "revoked" }), NOW)).toBe(false);
    expect(isActiveLink(link({ expires_at: "2026-10-13T09:00:00Z" }), NOW)).toBe(false);
  });

  it("allows a new link after everything except a form that came back, and a withdrawal only while the link can be used", () => {
    for (const s of LINK_STATES) expect(canSendAnother(s)).toBe(s !== "submitted");
    expect(LINK_STATES.filter(canRevoke)).toEqual(["created", "sent", "opened"]);
  });

  it("makes expiries between 1 and 30 days, 14 by default", () => {
    expect(LINK_TTL_DAYS).toBe(14);
    expect(expiryFor(NOW).toISOString()).toBe("2026-10-27T10:00:00.000Z");
    expect(expiryFor(NOW, 0).toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(expiryFor(NOW, 400).toISOString()).toBe("2026-11-12T10:00:00.000Z");
    expect(expiryFor(NOW, Number.NaN).toISOString()).toBe("2026-10-27T10:00:00.000Z");
  });
});

describe("the masked phone number", () => {
  it("keeps the country code and the next digits at the start and the last three, hiding the middle", () => {
    expect(maskPhone("+601234567881")).toBe("+6012•••••881");
    expect(maskPhone("+60123456881")).toBe("+6012••••881");
    expect(maskPhone("+60123456881")).not.toContain("3456");
  });

  it("never gives the whole number back, and says nothing for what is not a number", () => {
    for (const p of ["+60123456881", "+6591234567", "0123456789", "+8210123456789"]) {
      const m = maskPhone(p);
      expect(m).toContain("•");
      expect(m.replace(/\D/g, "").length).toBeLessThan(p.replace(/\D/g, "").length);
    }
    for (const p of ["", null, undefined, "abc", "12", "1234567890123456789"]) expect(maskPhone(p as never)).toBe("");
  });
});

describe("the token", () => {
  const ID = "b0000000-0000-4000-8000-000000000001";

  it("has the link's id in front and 256 random bits behind, and is different every time", () => {
    expect(linkTokensConfigured()).toBe(true);
    const a = mintLinkToken(ID)!;
    const b = mintLinkToken(ID)!;
    expect(a.token).toMatch(/^b0000000000040008000000000000001\.[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(linkIdOf(a.token)).toBe(ID);
  });

  it("is stored only as a keyed hash that does not contain the token", () => {
    const a = mintLinkToken(ID)!;
    expect(a.tokenHash).toBe(hashLinkToken(a.token));
    expect(a.tokenHash).not.toContain(a.token.split(".")[1]);
    expect(a.tokenHash).toBe(hashLinkToken(a.token));
  });

  it("matches its own hash and nothing else, in constant time", () => {
    const a = mintLinkToken(ID)!;
    const b = mintLinkToken(ID)!;
    expect(tokenMatches(a.token, a.tokenHash)).toBe(true);
    expect(tokenMatches(a.token, b.tokenHash)).toBe(false);
    expect(tokenMatches(b.token, a.tokenHash)).toBe(false);
    // the same id with one character of the secret changed
    const flipped = `${a.token.slice(0, -1)}${a.token.endsWith("A") ? "B" : "A"}`;
    expect(tokenMatches(flipped, a.tokenHash)).toBe(false);
    for (const bad of [null, undefined, 42, "", "x", `${a.token}x`, a.token.toUpperCase(), a.token.replace(".", "")]) expect(tokenMatches(bad, a.tokenHash)).toBe(false);
    for (const bad of [null, undefined, "", "nothex", "0".repeat(63), "0".repeat(64)]) expect(tokenMatches(a.token, bad)).toBe(false);
  });

  it("reads the id only from something shaped like a token", () => {
    expect(linkIdOf("b0000000000040008000000000000001.short")).toBeNull();
    expect(linkIdOf(`zz${"0".repeat(30)}.${"A".repeat(43)}`)).toBeNull();
    expect(linkIdOf(undefined)).toBeNull();
    expect(linkIdOf("a".repeat(500))).toBeNull();
  });

  it("is a path on the site, never a full address (the caller adds its own origin)", () => {
    const a = mintLinkToken(ID)!;
    expect(linkPath(a.token)).toBe(`/c/link/${a.token}`);
  });
});

describe("the card", () => {
  it("says the same thing in four languages, with a button WhatsApp accepts", () => {
    expect([...CARD_LOCALES]).toEqual(["en", "ms", "zh", "ko"]);
    expect(CARD_WORDS.en.title).toBe("Account closure form");
    expect(CARD_WORDS.en.body).toBe("To close your Vircle account, please open the form below and fill in your details.");
    expect(CARD_WORDS.en.button).toBe("Open closure form");
    for (const l of CARD_LOCALES) {
      const w = cardWords(l);
      expect(w.title.length).toBeGreaterThan(0);
      expect(w.body.length).toBeGreaterThan(20);
      expect(Array.from(w.button).length).toBeLessThanOrEqual(WHATSAPP_BUTTON_MAX);
      expect(w.body).toContain("Vircle");
    }
    expect(new Set(CARD_LOCALES.map((l) => CARD_WORDS[l].title)).size).toBe(4);
  });

  it("takes the contact's language, else the case's, else English", () => {
    expect(cardLocale("ms-MY", "ko")).toBe("ms");
    expect(cardLocale("zh_CN", null)).toBe("zh");
    expect(cardLocale(null, "ko")).toBe("ko");
    expect(cardLocale("fr", "de")).toBe("en");
    expect(cardLocale(undefined, undefined)).toBe("en");
    expect(cardLocaleOf("English")).toBeNull();
  });

  it("is the plain line where a channel has no button", () => {
    expect(fallbackText("en", "https://halo.test/c/link/x.y")).toBe("Account closure form: https://halo.test/c/link/x.y");
    expect(fallbackText("ko", "https://h/x")).toBe("계정 해지 신청서: https://h/x");
  });

  it("is stored as its words and the link's id, never the address", () => {
    const stored = storedCard("b0000000-0000-4000-8000-000000000001", "ms");
    expect(stored).toEqual({ link_id: "b0000000-0000-4000-8000-000000000001", title: CARD_WORDS.ms.title, body: CARD_WORDS.ms.body, button: CARD_WORDS.ms.button, locale: "ms" });
    expect(JSON.stringify(stored)).not.toMatch(/https?:|\/c\/link/);
    expect(cardPreview(stored)).toBe("Borang penutupan akaun");
  });

  it("is read back from a message row, or not at all", () => {
    const stored = storedCard("b0000000-0000-4000-8000-000000000001", "zh");
    expect(parseStoredCard({ link_card: stored })).toEqual(stored);
    expect(parseStoredCard(stored)).toEqual(stored);
    for (const bad of [null, undefined, "x", 3, [], {}, { link_card: null }, { link_card: { link_id: "nope" } }, { link_card: { link_id: 5 } }]) expect(parseStoredCard(bad)).toBeNull();
    // a hostile row cannot stretch the card
    const huge = parseStoredCard({ link_card: { ...stored, title: "x".repeat(5000), body: "y".repeat(5000), locale: "xx" } })!;
    expect(huge.title.length).toBe(120);
    expect(huge.body.length).toBe(600);
    expect(huge.locale).toBe("en");
  });

  it("is an HTML email with one button and the address in text under it, escaped", () => {
    const m = cardEmail("en", 'https://halo.test/c/link/a.b?x="1"&y=<2>');
    expect(m.subject).toBe("Account closure form");
    expect(m.html).toContain('href="https://halo.test/c/link/a.b?x=&quot;1&quot;&amp;y=&lt;2&gt;"');
    expect(m.html).toContain("Open closure form");
    expect(m.html).not.toContain("<2>");
    expect(m.text).toContain("Open closure form: https://halo.test/c/link/a.b");
  });
});

describe("how each channel carries the card", () => {
  it("sends a button where the channel has one", () => {
    expect(planDelivery("whatsapp", { whatsappWindowOpen: true })).toEqual({ send: true, mode: "whatsapp_cta", card: true });
    expect(planDelivery("messenger", { whatsappWindowOpen: false })).toEqual({ send: true, mode: "messenger_button", card: true });
    expect(planDelivery("instagram", { whatsappWindowOpen: false })).toEqual({ send: true, mode: "instagram_generic", card: true });
    expect(planDelivery("email", { whatsappWindowOpen: false })).toEqual({ send: true, mode: "email_button", card: true });
    expect(planDelivery("gmail", { whatsappWindowOpen: false })).toEqual({ send: true, mode: "email_button", card: true });
  });

  it("sends the plain line where it has none", () => {
    expect(planDelivery("vircle_chat", { whatsappWindowOpen: false })).toEqual({ send: true, mode: "text", card: false });
  });

  it("makes the link but sends nothing outside the WhatsApp window, in the web chat, or with no channel", () => {
    expect(planDelivery("whatsapp", { whatsappWindowOpen: false })).toEqual({ send: false, reason: "window_expired" });
    expect(planDelivery("web_widget", { whatsappWindowOpen: true })).toEqual({ send: false, reason: "channel_unsupported" });
    for (const c of [null, undefined, "", "tiktok", "sms"]) expect(planDelivery(c, { whatsappWindowOpen: true })).toEqual({ send: false, reason: "no_channel" });
  });
});

describe("the words particular to the personal form", () => {
  it("are in four languages, and the invalid page says one calm thing", () => {
    expect(Object.keys(LINK_WORDS)).toEqual(["en", "ms", "zh", "ko"]);
    expect(linkWords("en").invalid).toEqual({ title: "This link is not valid any more", body: "Please contact support." });
    for (const l of CARD_LOCALES) {
      const w = linkWords(l);
      expect(w.email.label).not.toBe("");
      expect(w.phone.help).not.toBe("");
      expect(w.invalid.title).not.toMatch(/expired|used|revoked|withdrawn|replaced/i);
    }
  });
});

describe("the notes left on a conversation", () => {
  it("reads the reference out of both texts, and out of nothing else", () => {
    expect(raisedNoteReference(raisedNoteText("CMP-2026-000014"))).toBe("CMP-2026-000014");
    expect(raisedNoteReference(formSubmittedNoteText("CMP-2026-000014"))).toBe("CMP-2026-000014");
    expect(formSubmittedNoteText("CMP-2026-000014")).toBe("Closure form submitted · CMP-2026-000014");
    expect(raisedNoteReference("Closure form submitted CMP-2026-000014")).toBeNull();
    expect(raisedNoteReference("Closure form submitted · CMP-2026-000014 and more")).toBeNull();
    expect(raisedNoteReference(null)).toBeNull();
    expect(raisedNoteHref("CMP-2026-000014")).toBe("/compliance?q=CMP-2026-000014");
  });
});
