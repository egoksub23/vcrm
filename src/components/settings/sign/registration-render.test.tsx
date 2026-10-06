import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

// Settings > Doc Sign > Registration forms, first paint, in every language, with the screens' real messages: the editor
// (a new form and a saved one), a form's card, and none of it a raw message key. Effects do not run under
// renderToStaticMarkup and the dialog's own frame is a portal, so the editor is drawn inside the dialog's root on its own.

import { Dialog } from "@/components/ui/dialog";
import type { FormOptions } from "@/lib/sign/client/registration-admin";
import { readAdminMessages, REGISTER_LOCALES, type RegisterLocale, type Tree } from "@/lib/sign/client/register-test-messages";
import type { RegistrationFormRow } from "@/lib/sign/registration/types";

import { RegistrationFormEditor } from "./registration-form-dialog";
import { FormCard, type ListItem } from "./registration-section";

const messages = readAdminMessages();
const run = messages ? describe : describe.skip;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

const options: FormOptions = {
  templates: [
    {
      id: "tpl",
      name: "Merchant Application",
      hasForm: true,
      roles: [
        { key: "merchant", label: "Merchant", kind: "signer" },
        { key: "director", label: "Director (countersign)", kind: "signer" },
      ],
    },
  ],
  tags: [{ id: "tag", name: "Merchant applicant", color: "#f59e0b" }],
  consentDefaults: { en: "I agree that {workspace} may keep my details.", ms: "ms default", zh: "zh default", ko: "ko default" },
  turnstile: false,
  origin: "https://halo.test",
};

const saved: RegistrationFormRow = {
  id: "f1",
  account_id: "a",
  slug: "merchant-sign-up-7k2m9x4q",
  name: "Merchant sign-up",
  active: true,
  mode: "sign",
  send_document: true,
  template_id: "tpl",
  applicant_role_key: "merchant",
  signers_other: [{ role_key: "director", name: "Siti Director", email: "siti@vircle.example", channel: "email", phone: null }],
  contact_tag_id: "tag",
  fields: { full_name: "required", email: "required", phone: "off", company: "optional" },
  consent_text: { ms: "Kata-kata sendiri." },
  success_message: {},
  default_locale: "ms",
  daily_cap: 40,
  created_by: "u",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

const wrap = (locale: RegisterLocale, node: React.ReactNode) => (
  <NextIntlClientProvider locale={locale} messages={{ Sign: { admin: messages![locale] } }} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

const editor = (form: RegistrationFormRow | null, over: Partial<FormOptions> = {}, locale: RegisterLocale = "en") =>
  renderToStaticMarkup(
    wrap(
      locale,
      <Dialog open onOpenChange={() => {}}>
        <RegistrationFormEditor form={form} open options={{ ...options, ...over }} onOpenChange={() => {}} onSaved={() => {}} />
      </Dialog>,
    ),
  );

const card = (item: Partial<ListItem> = {}, canEdit = true, locale: RegisterLocale = "en") =>
  renderToStaticMarkup(
    wrap(
      locale,
      <ul>
        <FormCard
          item={{ form: saved, counts: { accepted: 12, failed: 1, rejected_spam: 3, rejected_cap: 1, today: 4 }, issues: [], url: "https://halo.test/r/merchant-sign-up-7k2m9x4q", ...item }}
          options={options}
          canEdit={canEdit}
          busy={false}
          onToggle={() => {}}
          onEdit={() => {}}
          onActivity={() => {}}
          onRenew={() => {}}
          onCopy={() => {}}
        />
      </ul>,
    ),
  );

/** The opening tag of the switch with this label. */
const switchTag = (html: string, label: string): string => html.match(new RegExp(`<[a-z]+[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>|<[a-z]+[^>]*aria-label="${label}"[^>]*role="switch"[^>]*>`))?.[0] ?? "";

/** A message key left untranslated reads like "Sign.admin.registration.name". */
const looksLikeKey = (html: string) => /Sign\.admin|registration\.[a-zA-Z_]+\b|\b(?:reasons|issues|problems|status|ask|detail)\.[A-Za-z_]+/.test(html);

run("the registration form editor", () => {
  it("starts a new form on the first template with sensible choices", () => {
    const html = editor(null);
    expect(html).toContain("New registration form");
    expect(html).toContain("The address will read like https://halo.test/r/register-xxxxxxxx.");
    expect(html).toContain("Merchant Application");
    expect(html).toContain("Merchant"); // the applicant's role
    expect(html).toContain("Director (countersign): name");
    expect(html).toContain("Director (countersign): email");
    expect(html).toContain("Merchant applicant"); // the tag choice
    expect(html).toContain("No tag");
    expect(html).toContain("Always asked (the document goes here)");
    expect(html).toContain("Registrations a day");
    expect(html).toContain('value="100"');
    expect(html).toContain("Create form");
    // a new form starts switched off
    expect(switchTag(html, "Take registrations")).toContain('aria-checked="false"');
  });

  it("shows the live address from the name", () => {
    expect(editor({ ...saved, name: "Merchant sign-up" })).toContain("Address: https://halo.test/r/merchant-sign-up-7k2m9x4q");
  });

  it("shows a saved form as it was saved", () => {
    const html = editor(saved);
    expect(html).toContain("Edit registration form");
    expect(html).toContain('value="Merchant sign-up"');
    expect(html).toContain('value="Siti Director"');
    expect(html).toContain('value="siti@vircle.example"');
    expect(html).toContain('value="40"');
    expect(switchTag(html, "Take registrations")).toContain('aria-checked="true"');
    expect(html).toContain("Save");
    expect(html).not.toContain("Create form");
    // the wording of a language it set is in the box; the others show the product's words as the placeholder
    expect(html).toContain("Kata-kata sendiri.");
    expect(html).toContain('placeholder="I agree that {workspace} may keep my details."');
  });

  it("has no template, role or people when no document is sent", () => {
    const html = editor({ ...saved, send_document: false, template_id: null, applicant_role_key: null, signers_other: [] });
    expect(html).toContain("No document is sent.");
    expect(html).not.toContain('id="reg-template"');
    expect(html).not.toContain("People for the other roles");
  });

  it("points a form with no templates to the templates", () => {
    const html = editor(null, { templates: [] });
    expect(html).toContain("There is no active template with a saved version yet.");
    expect(html).toContain('href="/sign/templates"');
    expect(html).not.toContain('id="reg-template"');
  });

  it("offers each detail as required, optional or not asked, and the email only as always asked", () => {
    const html = editor(null);
    for (const id of ["reg-ask-name", "reg-ask-company", "reg-ask-phone"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="reg-ask-email"');
    expect(html.match(/>Required</g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain(">Not asked<");
  });

  it("reads in every language with no raw key and no unfilled placeholder", () => {
    for (const l of REGISTER_LOCALES) {
      for (const html of [editor(null, {}, l), editor(saved, {}, l), editor(null, { templates: [] }, l)]) {
        expect(looksLikeKey(html), l).toBe(false);
        expect(html, l).not.toMatch(/\{(role|name|address)\}/);
      }
    }
    expect(errors).toEqual([]);
  });
});

run("a registration form's card", () => {
  it("shows the address, what it sends, today's count and the last 30 days", () => {
    const html = card();
    expect(html).toContain("Merchant sign-up");
    expect(html).toContain("https://halo.test/r/merchant-sign-up-7k2m9x4q");
    expect(html).toContain(">On<");
    expect(html).toContain("Merchant Application");
    expect(html).toContain("4 of 40");
    expect(html).toContain("12 accepted, 1 could not be completed, 4 blocked");
    expect(html).toContain('href="https://halo.test/r/merchant-sign-up-7k2m9x4q"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('aria-label="Copy the address of Merchant sign-up"');
    expect(html).toContain('aria-label="Make a new address for Merchant sign-up"');
    expect(html).toContain('aria-label="Edit Merchant sign-up"');
    expect(html).not.toContain("Needs attention");
  });

  it("says a form that is off is off, and what a form with no document keeps", () => {
    const html = card({ form: { ...saved, active: false, send_document: false, template_id: null } });
    expect(html).toContain(">Off<");
    expect(html).toContain("Switched off: the address shows a page that is not available.");
    expect(html).toContain("No document: only keeps the details");
  });

  it("lists what stops a form working, and flags it when it is live", () => {
    const issues = [{ code: "role_without_person", role: "director" }, { code: "something_new" }];
    const live = card({ issues });
    expect(live).toContain("Needs attention");
    expect(live).toContain("The role director has things to complete but nobody is named for it.");
    expect(live).toContain("This form has a problem that stops it working.");
    expect(card({ issues, form: { ...saved, active: false } })).not.toContain("Needs attention");
  });

  it("cannot be changed by someone who may only look", () => {
    const html = card({}, false);
    expect(html).toMatch(/aria-label="Edit Merchant sign-up"[^>]*disabled=""|disabled=""[^>]*aria-label="Edit Merchant sign-up"/);
    expect(switchTag(html, "Take registrations: Merchant sign-up")).toMatch(/disabled|data-disabled/);
  });

  it("reads in every language with no raw key", () => {
    for (const l of REGISTER_LOCALES) {
      const html = card({ issues: [{ code: "role_without_person", role: "director" }, { code: "no_template" }] }, true, l);
      expect(looksLikeKey(html), l).toBe(false);
      expect(html, l).not.toMatch(/\{(role|name|count|cap|accepted|failed|blocked)\}/);
      // numbers are in the sentence, in the language's own words
      expect(html, l).toContain("12");
    }
    expect(errors).toEqual([]);
  });
});

run("the screens' own words carry no stray key", () => {
  it("has the registration tab", () => {
    for (const l of REGISTER_LOCALES) expect(((messages![l] as Tree).tabs as Tree).registration, l).toBeTypeOf("string");
  });
});
