import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for the raise dialog's chat-link changes (migration 185), in every language, with the real wording from messages/<locale>.json (next-intl is
// told to throw on a missing key): the type choices and their order, the Description field, Account change (what changes, the parent-name note, only the
// fields that apply), Account closure with "Send the closure form to the customer in this chat" (ticked, unticked, switched off for each reason, absent on a
// ticket) and the done view with its Copy link. The pure pieces behind them are tested directly.
//
// NOT covered (no DOM renderer in this repo, and renderToStaticMarkup paints only the FIRST render): clicking or typing, ticking the box and the fields
// appearing or going as it is ticked, choosing another "What is changing", keyboard focus and the Copy link button itself (the clipboard and its select-by-hand
// fallback), the real fetches and the toast-free flow after Raise request. What a click does is the same pure functions tested here (closureChoice,
// fieldsToAsk, invalidAnswerFields) wired to state.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "officer@example.test" }, profile: { full_name: "Olivia Officer", email: "officer@example.test" }, capabilities: new Set(["menu.compliance"]), refreshCapabilities: () => undefined }),
  useCapability: () => true,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { NOT_SENT_REASONS, type ChatLinkOutcome } from "@/lib/compliance/chat-link/types";
import type { RaiseContext } from "@/lib/compliance/raise-types";
import type { FieldDef, L10n } from "@/lib/compliance/types";
import { typeFromRow } from "@/lib/compliance/service/rows";
import { TYPE_ROWS } from "@/lib/compliance/test-support";

import { RaiseDone, RaiseForm, closureChoice, fieldsToAsk, invalidAnswerFields, orderTypeChoices, typeChoiceLabel } from "./raise";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

// ---- fixtures: the three system types as the migrations leave them -----------------------------------------------------------------------

const L = (en: string, ms?: string, zh?: string, ko?: string): L10n => ({ en, ...(ms ? { ms } : {}), ...(zh ? { zh } : {}), ...(ko ? { ko } : {}) });
const showWhen = (v: string): FieldDef["showIf"] => ({ field: "what_changes", in: [v] });
const f = (key: string, type: FieldDef["type"], label: L10n, over: Partial<FieldDef> = {}): FieldDef => ({ key, type, label, required: true, sensitive: false, ...over });

const ACCOUNT_CHANGE_FIELDS: FieldDef[] = [
  f("what_changes", "choice", L("What is changing", "Apakah yang berubah", "变更内容", "변경 내용"), {
    help: L("A parent's name cannot be changed here."),
    options: [
      { value: "parent_phone", label: L("Parent phone number", "Nombor telefon ibu bapa", "家长手机号码", "부모 전화번호") },
      { value: "parent_email", label: L("Parent email address", "Alamat e-mel ibu bapa", "家长电子邮件地址", "부모 이메일 주소") },
      { value: "child_name", label: L("Child's name", "Nama anak", "孩子的姓名", "자녀 이름") },
    ],
  }),
  f("current_phone", "phone", L("Current phone number"), { showIf: showWhen("parent_phone") }),
  f("new_phone", "phone", L("New phone number"), { showIf: showWhen("parent_phone") }),
  f("current_email", "email", L("Current email address"), { showIf: showWhen("parent_email") }),
  f("new_email", "email", L("New email address"), { showIf: showWhen("parent_email") }),
  f("child_current_name", "text", L("Child's current name"), { showIf: showWhen("child_name") }),
  f("child_new_name", "text", L("Child's new name"), { showIf: showWhen("child_name") }),
];

const closureType = typeFromRow(TYPE_ROWS[0]);
const withdrawalType = typeFromRow(TYPE_ROWS[1]);
const closureFields = closureType.fields.filter((x) => x.type !== "file");

const context = (over: Partial<RaiseContext> = {}): RaiseContext => ({
  contact: { id: "c1", name: "Siti Aminah", phone: "012-334 4556", email: "siti@example.test", language: "ms" },
  channel: "whatsapp",
  chatLink: { available: true },
  types: [
    { key: "closure", label: "Account closure", labelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" }, fields: closureFields },
    { key: "withdrawal", label: "Fund withdrawal", labelL10n: {}, fields: withdrawalType.fields.filter((x) => x.type !== "file") },
    { key: "phone_change", label: "Phone number change", labelL10n: {}, fields: ACCOUNT_CHANGE_FIELDS },
  ],
  open: [],
  ...over,
});

const form = (locale: Locale, ctx: RaiseContext, target: { conversationId: string } | { ticketId: string }, initial: React.ComponentProps<typeof RaiseForm>["initial"] = {}) =>
  page(locale, <RaiseForm target={target} context={ctx} canOpen onRaised={() => undefined} onCancel={() => undefined} initial={initial} />);
/** The opening tag of the control with this id, and whether it carries an attribute (renderToStaticMarkup writes attributes in the component's order). */
const tag = (html: string, id: string): string => html.match(new RegExp(`<(?:input|select|textarea)[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
const has = (t: string, attr: string): boolean => new RegExp(String.raw`\s${attr}(=|\s|/|>)`).test(t);
const CONV = { conversationId: "cv1" };
const TICKET = { ticketId: "tk1" };

// ---- the pure pieces ---------------------------------------------------------------------------------------------------------------------

describe("type choices", () => {
  it("lists phone_change, withdrawal, closure, then custom types in their own order, without touching the input", () => {
    const input = [{ key: "custom_b" }, { key: "closure" }, { key: "custom_a" }, { key: "phone_change" }, { key: "withdrawal" }];
    const before = JSON.stringify(input);
    expect(orderTypeChoices(input).map((x) => x.key)).toEqual(["phone_change", "withdrawal", "closure", "custom_b", "custom_a"]);
    expect(JSON.stringify(input)).toBe(before);
    expect(orderTypeChoices([])).toEqual([]);
  });

  describe.each(LOCALES)("in %s", (locale) => {
    const t = tr(locale, "Compliance.raise");
    it("words the system types with the dialog's own names, whatever the database holds, and a custom type with its own label", () => {
      expect(typeChoiceLabel("closure", "Anything", { ms: "Lain" }, locale, t)).toBe(t("types.closure"));
      expect(typeChoiceLabel("withdrawal", "Fund withdrawal", {}, locale, t)).toBe(t("types.withdrawal"));
      expect(typeChoiceLabel("phone_change", "Phone number change", {}, locale, t)).toBe(t("types.phone_change"));
      expect(typeChoiceLabel("complaint", "Complaint", { ms: "Aduan", zh: "投诉", ko: "민원" }, locale, t)).toBe(locale === "en" ? "Complaint" : { ms: "Aduan", zh: "投诉", ko: "민원" }[locale]);
      // a custom type with no words in this language falls back to its main label
      expect(typeChoiceLabel("complaint", "Complaint", {}, locale, t)).toBe("Complaint");
      expect(typeChoiceLabel("complaint", "Complaint", { ms: "  " }, locale, t)).toBe("Complaint");
    });
  });

  it("has the three names in every language and they differ from one another", () => {
    for (const locale of LOCALES) {
      const t = tr(locale, "Compliance.raise");
      expect(new Set([t("types.closure"), t("types.withdrawal"), t("types.phone_change")]).size).toBe(3);
    }
    expect(tr("en", "Compliance.raise")("types.closure")).toBe("Account closure");
    expect(tr("en", "Compliance.raise")("types.withdrawal")).toBe("Withdrawal");
    expect(tr("en", "Compliance.raise")("types.phone_change")).toBe("Account change");
  });
});

describe("closureChoice", () => {
  it("is shown for an account closure raised from a conversation, ticked when the chat can take the form", () => {
    expect(closureChoice("closure", CONV, { available: true }, true)).toEqual({ show: true, checked: true, disabled: false, reason: null });
    expect(closureChoice("closure", CONV, { available: true }, false)).toEqual({ show: true, checked: false, disabled: false, reason: null });
  });
  it("is off and disabled, with the reason, when the chat cannot take the form, whatever the tick was", () => {
    for (const reason of NOT_SENT_REASONS) expect(closureChoice("closure", CONV, { available: false, reason }, true)).toEqual({ show: true, checked: false, disabled: true, reason });
    expect(closureChoice("closure", CONV, { available: false }, true).reason).toBe("no_channel");
  });
  it("is absent for a ticket and for any other type", () => {
    expect(closureChoice("closure", TICKET, { available: true }, true).show).toBe(false);
    expect(closureChoice("closure", TICKET, { available: true }, true).checked).toBe(false);
    for (const key of ["withdrawal", "phone_change", "custom"]) expect(closureChoice(key, CONV, { available: true }, true)).toEqual({ show: false, checked: false, disabled: false, reason: null });
  });
});

describe("fieldsToAsk", () => {
  const keys = (fields: FieldDef[]) => fields.map((x) => x.key);
  it("asks every staff field of a closure when the form is not sent", () => {
    expect(keys(fieldsToAsk(closureFields, {}, false))).toEqual(["confirm_closure", "children_finished_school", "allowances_cancelled", "reason", "bank_name", "bank_account_number", "bank_account_holder"]);
  });
  it("leaves out the confirmations and the bank details when the closure form goes to the customer, and requires none of them", () => {
    const asked = fieldsToAsk(closureFields, {}, true);
    expect(keys(asked)).toEqual(["reason"]);
  });
  it("asks only what the choice in Account change needs", () => {
    expect(keys(fieldsToAsk(ACCOUNT_CHANGE_FIELDS, {}, false))).toEqual(["what_changes"]);
    expect(keys(fieldsToAsk(ACCOUNT_CHANGE_FIELDS, { what_changes: "parent_phone" }, false))).toEqual(["what_changes", "current_phone", "new_phone"]);
    expect(keys(fieldsToAsk(ACCOUNT_CHANGE_FIELDS, { what_changes: "parent_email" }, false))).toEqual(["what_changes", "current_email", "new_email"]);
    expect(keys(fieldsToAsk(ACCOUNT_CHANGE_FIELDS, { what_changes: "child_name" }, false))).toEqual(["what_changes", "child_current_name", "child_new_name"]);
    expect(keys(fieldsToAsk(ACCOUNT_CHANGE_FIELDS, { what_changes: "parent_name" }, false))).toEqual(["what_changes"]);
  });
});

describe("invalidAnswerFields", () => {
  const asked = (what: string) => fieldsToAsk(ACCOUNT_CHANGE_FIELDS, { what_changes: what }, false);
  it("names a phone number or an email address the server would refuse, on its own field", () => {
    expect(invalidAnswerFields(asked("parent_phone"), { what_changes: "parent_phone", current_phone: "abc", new_phone: "012-334 4556" })).toEqual(["current_phone"]);
    expect(invalidAnswerFields(asked("parent_email"), { what_changes: "parent_email", current_email: "siti@example.test", new_email: "not-an-email" })).toEqual(["new_email"]);
  });
  it("accepts a Malaysian phone number in the forms people type, and an empty answer is not an invalid one", () => {
    expect(invalidAnswerFields(asked("parent_phone"), { what_changes: "parent_phone", current_phone: "012-334 4556", new_phone: "+60 12 998 7766" })).toEqual([]);
    expect(invalidAnswerFields(asked("parent_phone"), { what_changes: "parent_phone" })).toEqual([]);
  });
  it("ignores answers to fields the choice hides", () => {
    expect(invalidAnswerFields(asked("child_name"), { what_changes: "child_name", child_current_name: "Aiman", child_new_name: "Aiman Hakim", current_phone: "abc" })).toEqual([]);
  });
});

// ---- the markup, in every language -------------------------------------------------------------------------------------------------------

describe.each(LOCALES)("the raise dialog in %s", (locale) => {
  const r = tr(locale, "Compliance.raise");
  const link = tr(locale, "Compliance.chatLink");

  it("lists the types in order with the dialog's names, and starts on Account change when it is not already open", () => {
    const html = form(locale, context(), CONV);
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]).filter(([v]) => ["phone_change", "withdrawal", "closure"].includes(v));
    expect(options).toEqual([["phone_change", r("types.phone_change")], ["withdrawal", r("types.withdrawal")], ["closure", r("types.closure")]]);
    expect(html).toMatch(/<option value="phone_change"[^>]*selected/);
    expect(errors).toEqual([]);
  });

  it("starts on the first type that is not already open", () => {
    const html = form(locale, context({ open: ["phone_change"] }), CONV);
    expect(html).toMatch(/<option value="withdrawal"[^>]*selected/);
  });

  it("calls the note Description, optional, with its help", () => {
    const s = text(form(locale, context(), CONV));
    expect(s).toContain(r("note"));
    expect(s).toContain(r("noteHelp"));
    expect(form(locale, context(), CONV)).toContain('aria-describedby="cmp-rs-note-help"');
    expect(form(locale, context(), CONV)).not.toMatch(/<textarea[^>]*id="cmp-rs-note"[^>]*required/);
  });

  it("Account change: asks what is changing first, says a parent's name cannot be changed, and asks no pair until one is chosen", () => {
    const html = form(locale, context(), CONV, { typeKey: "phone_change" });
    const s = text(html);
    expect(s).toContain(r("parentNameNote"));
    expect(html.indexOf("cmp-rs-what_changes")).toBeGreaterThan(-1);
    expect(html).not.toContain("cmp-rs-current_phone");
    expect(html).not.toContain("cmp-rs-new_email");
    expect(html).not.toContain("cmp-rs-child_current_name");
    // the choices are in the person's language
    const choose = tr(locale, "Compliance.form")("choose");
    expect(html).toContain(">" + choose + "<");
    expect(html).toContain(">" + ({ en: "Parent phone number", ms: "Nombor telefon ibu bapa", zh: "家长手机号码", ko: "부모 전화번호" })[locale] + "<");
    // no closure tick, no acknowledgement help
    expect(html).not.toContain("cmp-rs-send-form");
    expect(s).not.toContain(r("tickHelp"));
    expect(errors).toEqual([]);
  });

  it.each([
    ["parent_phone", ["current_phone", "new_phone"], ["current_email", "new_email", "child_current_name", "child_new_name"]],
    ["parent_email", ["current_email", "new_email"], ["current_phone", "new_phone", "child_current_name", "child_new_name"]],
    ["child_name", ["child_current_name", "child_new_name"], ["current_phone", "new_phone", "current_email", "new_email"]],
  ])("Account change, %s: asks its own pair and no other", (what, shown, hidden) => {
    const html = form(locale, context(), CONV, { typeKey: "phone_change", values: { what_changes: what } });
    for (const k of shown) expect(html, k).toContain(`id="cmp-rs-${k}"`);
    for (const k of hidden) expect(html, k).not.toContain(`id="cmp-rs-${k}"`);
    expect(text(html)).toContain(r("parentNameNote"));
  });

  it("Account change: shows the server's issues on the right field", () => {
    const html = form(locale, context(), CONV, { typeKey: "phone_change", values: { what_changes: "parent_phone", new_phone: "abc" }, invalid: ["new_phone"], error: "validation_failed" });
    expect(has(tag(html, "cmp-rs-new_phone"), "aria-invalid")).toBe(true);
    expect(tag(html, "cmp-rs-current_phone")).not.toBe("");
    expect(has(tag(html, "cmp-rs-current_phone"), "aria-invalid")).toBe(false);
    expect(text(html)).toContain(tr(locale, "Compliance.errors")("validation_failed"));
  });

  it("Account closure, chat can take the form: the box is ticked and the confirmations and bank details are not asked", () => {
    const html = form(locale, context(), CONV, { typeKey: "closure" });
    const s = text(html);
    expect(has(tag(html, "cmp-rs-send-form"), "checked")).toBe(true);
    expect(has(tag(html, "cmp-rs-send-form"), "disabled")).toBe(false);
    expect(s).toContain(r("sendClosureForm"));
    expect(s).toContain(r("sendClosureFormHelp"));
    expect(html).toContain('data-closure-form="on"');
    expect(html).toContain('id="cmp-rs-reason"');
    for (const k of ["confirm_closure", "children_finished_school", "allowances_cancelled", "bank_name", "bank_account_number", "bank_account_holder"]) expect(html, k).not.toContain(`id="cmp-rs-${k}"`);
    expect(s).not.toContain(r("tickHelp"));
    expect(errors).toEqual([]);
  });

  it("Account closure, box unticked: every staff field is asked, as before", () => {
    const html = form(locale, context(), CONV, { typeKey: "closure", sendClosureForm: false });
    const s = text(html);
    expect(tag(html, "cmp-rs-send-form")).not.toBe("");
    expect(has(tag(html, "cmp-rs-send-form"), "checked")).toBe(false);
    expect(has(tag(html, "cmp-rs-send-form"), "disabled")).toBe(false);
    expect(html).toContain('data-closure-form="off"');
    expect(s).toContain(r("sendClosureFormManual"));
    expect(s).toContain(r("tickHelp"));
    for (const k of ["confirm_closure", "children_finished_school", "allowances_cancelled", "reason", "bank_name", "bank_account_number", "bank_account_holder"]) expect(html, k).toContain(`id="cmp-rs-${k}"`);
  });

  it.each(NOT_SENT_REASONS)("Account closure, chat cannot take the form (%s): the box is off and disabled and says why in words, and every staff field is asked", (reason) => {
    const html = form(locale, context({ chatLink: { available: false, reason } }), CONV, { typeKey: "closure" });
    expect(has(tag(html, "cmp-rs-send-form"), "disabled")).toBe(true);
    expect(has(tag(html, "cmp-rs-send-form"), "checked")).toBe(false);
    expect(html).toContain('data-closure-form="unavailable"');
    expect(text(html)).toContain(link(`outcome.reason.${reason}`));
    expect(text(html)).toContain(r("sendClosureFormUnavailable"));
    expect(html).toContain('id="cmp-rs-bank_name"');
    expect(html).toContain('id="cmp-rs-confirm_closure"');
  });

  it("Account closure raised from a ticket: no box at all, every staff field asked", () => {
    const html = form(locale, context(), TICKET, { typeKey: "closure" });
    expect(html).not.toContain("cmp-rs-send-form");
    expect(text(html)).not.toContain(r("sendClosureForm"));
    expect(html).toContain('id="cmp-rs-bank_name"');
  });

  it("Withdrawal: no box", () => {
    const html = form(locale, context(), CONV, { typeKey: "withdrawal" });
    expect(html).not.toContain("cmp-rs-send-form");
    expect(html).toContain('id="cmp-rs-amount"');
  });
});

describe.each(LOCALES)("the done view in %s", (locale) => {
  const r = tr(locale, "Compliance.raise");
  const link = tr(locale, "Compliance.chatLink");
  const done = (chatLink?: ChatLinkOutcome) => page(locale, <RaiseDone done={{ reference: "CMP-2026-000021", id: "case-21", chatLink }} canOpen onClose={() => undefined} />);
  const URL_OF_LINK = "https://crm.example.test/c/link/personal-token-abcdef";

  it("shows the reference alone when no closure form was asked for", () => {
    const html = done();
    expect(text(html)).toContain(r("done.title", { reference: "CMP-2026-000021" }));
    expect(html).not.toContain("data-chat-link");
    expect(html).toContain('href="/compliance/case-21"');
  });

  it("says in words that the form was sent, as a card or as a line, with no address", () => {
    const card = done({ status: "sent", linkId: "l1", expiresAt: "2026-10-27T08:00:00Z", mode: "card", channel: "whatsapp" });
    expect(text(card)).toContain(link("outcome.sentCard"));
    expect(card).toContain('data-chat-link="sent"');
    expect(card).not.toContain("Copy");
    const line = done({ status: "sent", linkId: "l1", expiresAt: "2026-10-27T08:00:00Z", mode: "text", channel: "messenger" });
    expect(text(line)).toContain(link("outcome.sentText"));
  });

  it("not sent: says so, why, and offers Copy link, without printing the personal address", () => {
    for (const reason of NOT_SENT_REASONS) {
      const html = done({ status: "not_sent", linkId: "l1", expiresAt: "2026-10-27T08:00:00Z", reason, channel: "whatsapp", url: URL_OF_LINK });
      const s = text(html);
      expect(s, reason).toContain(link("outcome.notSent"));
      expect(s, reason).toContain(link(`outcome.reason.${reason}`));
      expect(s, reason).toContain(link("copy"));
      expect(s, reason).toContain(link("copyHint"));
      expect(html).toContain('data-action="copy-link"');
      expect(html).toContain('data-chat-link="not_sent"');
      // the address is held for the Copy button; it is not in the markup, a link, an attribute or a title
      expect(html).not.toContain(URL_OF_LINK);
      expect(html).not.toContain("personal-token");
    }
    expect(errors).toEqual([]);
  });

  it("no link could be made: says why", () => {
    for (const reason of ["not_closure", "no_conversation", "no_key"] as const) expect(text(done({ status: "unavailable", reason }))).toContain(link(`outcome.unavailable.${reason}`));
  });
});
