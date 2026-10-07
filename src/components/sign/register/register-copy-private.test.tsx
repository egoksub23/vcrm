import React from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The people who receive a copy of the documents a registration form sends (migration 176) are the sender's business. The public page, which anyone
// can open without logging in, must show nothing of them: not a name, not an address, not even that there is such a list. Three guards: the view the
// server builds for the browser (a fixed list of keys, so a field added by mistake fails here), the page drawn from it in every language, and the
// source of the public page and its loader (none of it reads the list).

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import type { SignerMessages } from "@/components/sign/signer/use-language";
import { readRegisterMessages, REGISTER_LOCALES, type Tree } from "@/lib/sign/client/register-test-messages";
import { DEFAULT_ASKED, type RegistrationFormRow } from "@/lib/sign/registration/types";
import { buildRegisterView, type PublicForm } from "@/lib/sign/service/registration";

import { RegisterRoot } from "./register-root";

const register = readRegisterMessages();
const run = register ? describe : describe.skip;

let messages: SignerMessages;
beforeAll(async () => {
  const loaded = await loadSignerMessages({ register: true });
  if (!register) return;
  messages = Object.fromEntries(REGISTER_LOCALES.map((l) => [l, { Sign: { ...((loaded[l] as { Sign: Tree }).Sign), register: register[l] } }])) as unknown as SignerMessages;
});

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const SECRETS = ["Mei Lin Secret", "Raj Kumar Secret", "mei.secret@vircle.example", "raj.secret@vircle.example"];

const row: RegistrationFormRow = {
  id: "f1",
  account_id: "a",
  slug: "merchant-sign-up-7k2m9x4q",
  name: "Merchant sign-up",
  active: true,
  mode: "sign",
  send_document: true,
  template_id: "tpl",
  applicant_role_key: "merchant",
  signers_other: [],
  copy_recipients: [
    { fullName: SECRETS[0], email: SECRETS[2] },
    { fullName: SECRETS[1], email: SECRETS[3] },
  ],
  contact_tag_id: null,
  fields: DEFAULT_ASKED,
  consent_text: {},
  success_message: {},
  default_locale: "en",
  daily_cap: 100,
  created_by: "u",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const found: PublicForm = { form: row, workspace: { name: "Kedai Runcit Ali", logoUrl: null } };

describe("the view the server hands to the public registration page", () => {
  it("has the same keys whether or not the form has a copy list, and none of them is the list", () => {
    const withList = buildRegisterView(found, "token", null);
    const without = buildRegisterView({ ...found, form: { ...row, copy_recipients: [] } }, "token", null);
    expect(Object.keys(withList).sort()).toEqual(["asked", "captchaKey", "consent", "defaultLocale", "documentMode", "sendsDocument", "slug", "success", "token", "workspace"]);
    expect(Object.keys(without).sort()).toEqual(Object.keys(withList).sort());
    // the list changes nothing the page reads
    expect(withList).toEqual(without);
  });

  it("carries no name and no address of the list, and no mention of copies, anywhere in what the browser receives", () => {
    const json = JSON.stringify(buildRegisterView(found, "token", "0x4AAA"));
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toMatch(/copy_recipients|copyRecipients|copy_to|copyTo/i);
  });
});

run("the public registration page", () => {
  it("shows nothing of the copy list in any language, and its words do not say there is one", () => {
    const view = buildRegisterView(found, "token", null);
    for (const l of REGISTER_LOCALES) {
      const html = renderToStaticMarkup(<RegisterRoot view={view} initialLocale={l} messages={messages} product="Halo" />);
      for (const secret of SECRETS) expect(html, `${l} ${secret}`).not.toContain(secret);
      expect(html, l).not.toMatch(/copy_recipients|copyRecipients|data-copy/i);
      // the same page as for a form with no list at all
      const plain = renderToStaticMarkup(<RegisterRoot view={buildRegisterView({ ...found, form: { ...row, copy_recipients: [] } }, "token", null)} initialLocale={l} messages={messages} product="Halo" />);
      expect(html, l).toBe(plain);
    }
  });
});

describe("the source of the public page", () => {
  const SRC = join(process.cwd(), "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
    });

  it("never reads the list: not the loader of /r/[slug], not the page components, not the list editor", () => {
    const sources = [...files(join(SRC, "app", "r")), ...files(join(SRC, "components", "sign", "register"))];
    expect(sources.length).toBeGreaterThan(3);
    for (const f of sources) expect(readFileSync(f, "utf8"), f).not.toMatch(/copy_recipients|copyRecipients|CopyListEditor|copy-list/);
  });
});
