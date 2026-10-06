import React from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The registration page, first paint, in every language, with the page's real messages: the workspace's frame, only the
// details the form asks for, the agreement with its tick, the hidden field, and none of it a raw message key. Effects do
// not run under renderToStaticMarkup, so what is checked is what the server sends, which is what a person sees first.

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import type { SignerMessages } from "@/components/sign/signer/use-language";
import { readRegisterMessages, leaves, placeholders, REGISTER_LOCALES, type RegisterLocale, type Tree } from "@/lib/sign/client/register-test-messages";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { DEFAULT_REGISTRATION_CONSENT } from "@/lib/sign/registration/consent";
import type { RegisterView } from "@/lib/sign/service/registration";

import { RegisterNotFoundRoot, RegisterRoot } from "./register-root";

const register = readRegisterMessages();
const run = register ? describe : describe.skip;

let messages: SignerMessages;

beforeAll(async () => {
  const loaded = await loadSignerMessages({ register: true });
  if (!register) return;
  // the words of this page, from the message files (or from the fragments while they are not merged yet)
  messages = Object.fromEntries(REGISTER_LOCALES.map((l) => [l, { Sign: { ...((loaded[l] as { Sign: Tree }).Sign), register: register[l] } }])) as unknown as SignerMessages;
});

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const view = (over: Partial<RegisterView> = {}): RegisterView => ({
  slug: "merchant-sign-up-7k2m9x4q",
  workspace: { name: "Kedai Runcit Ali", logoUrl: "https://example.test/logo.png" },
  asked: { full_name: "required", email: "required", phone: "optional", company: "required" },
  defaultLocale: "en",
  sendsDocument: true,
  consent: Object.fromEntries(REGISTER_LOCALES.map((l) => [l, DEFAULT_REGISTRATION_CONSENT[l].replace("{workspace}", "Kedai Runcit Ali")])) as RegisterView["consent"],
  success: {},
  token: "t",
  captchaKey: null,
  ...over,
});

const page = (v: RegisterView, locale: SignerLocale = "en") => renderToStaticMarkup(<RegisterRoot view={v} initialLocale={locale} messages={messages} product="Halo" />);

/** A message key left untranslated reads like "Sign.register.title" or "fields.email.label". */
const looksLikeKey = (html: string) => /Sign\.register|Sign\.signer|\b(?:fields|problems|errors|notice|success|captcha|intro)\.[a-z_]+(?:\.[a-z_]+)?\b(?![^<]*<\/script)/.test(html.replace(/<script[\s\S]*?<\/script>/g, ""));

run("the registration page, first paint", () => {
  it("shows the workspace, the form, the agreement and the button", () => {
    const html = page(view());
    expect(html).toContain('alt="Kedai Runcit Ali"');
    expect(html).toContain("Start your registration");
    expect(html).toContain("We will email you the document to read and sign.");
    for (const label of ["Full name", "Company or business name", "Email address", "Phone number"]) expect(html).toContain(label);
    expect(html).toContain("Kedai Runcit Ali may keep the details I enter here");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(">Send<");
    expect(html).toContain('<form noValidate=""');
    expect(html).toContain('lang="en"');
  });

  it("asks only for what the form asks, and marks what may be left empty", () => {
    const html = page(view({ asked: { full_name: "off", email: "required", phone: "off", company: "optional" } }));
    expect(html).not.toContain("Full name");
    expect(html).not.toContain("Phone number");
    expect(html).toContain("Email address");
    expect(html).toContain("Company or business name");
    expect(html).toContain("(optional)");
    expect(page(view())).toContain("Phone number</label>".replace("</label>", "")); // phone is asked, as optional
    expect(page(view()).match(/\(optional\)/g)).toHaveLength(1);
  });

  it("uses the right kind of keyboard and the browser's own autofill, and never names an input", () => {
    const html = page(view());
    expect(html).toContain('type="email"');
    expect(html).toContain('inputMode="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('autoComplete="tel"');
    expect(html).toContain('autoComplete="name"');
    expect(html).toContain('autoComplete="organization"');
    // no name= on any input: a submit before the page has loaded cannot put a detail in the address
    expect(html).not.toMatch(/<input[^>]*\sname=/);
    expect(html).toContain('placeholder="+60 12-345 6789"');
    // each field has its label, and the required ones say so to a screen reader
    expect(html).toMatch(/<label[^>]*for="register-email"/);
    expect(html).toContain('aria-required="true"');
  });

  it("carries the hidden field a person never reaches", () => {
    const html = page(view());
    const hidden = html.match(/<div aria-hidden="true"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(hidden).toContain('tabindex="-1"');
    expect(hidden).toContain('autoComplete="off"');
    expect(hidden).toContain("Leave this field empty");
    expect(hidden).not.toMatch(/\sname=/);
  });

  it("says the details are only kept when the form sends no document", () => {
    expect(page(view({ sendsDocument: false }))).toContain("Enter your details below and we will be in touch.");
    expect(page(view({ sendsDocument: false }))).not.toContain("read and sign");
  });

  it("holds the button until the bot check is done, when there is one", () => {
    const html = page(view({ captchaKey: "0x4AAA" }));
    expect(html).toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain("Checking that you are a person...");
    expect(page(view())).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(page(view())).not.toContain("Checking that you are a person");
  });

  it("is the workspace's name in the page, not a script, whatever the name is", () => {
    const html = page(view({ workspace: { name: "A & B <script>alert(1)</script> Sdn Bhd", logoUrl: null } }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("A &amp; B &lt;script&gt;");
  });

  it("starts in the language it is given, with the agreement in that language", () => {
    for (const l of REGISTER_LOCALES) {
      const html = page(view(), l);
      expect(html, l).toContain(`lang="${l}"`);
      expect(html, l).toContain((register![l] as { title: string }).title);
      expect(html, l).toContain(DEFAULT_REGISTRATION_CONSENT[l].replace("{workspace}", "Kedai Runcit Ali").replace(/&/g, "&amp;"));
      expect(looksLikeKey(html), l).toBe(false);
      expect(html, l).not.toMatch(/\{(workspace|email)\}/);
    }
    expect(errors).toEqual([]);
  });

  it("would notice a raw key: the check has teeth", () => {
    const without = Object.fromEntries(REGISTER_LOCALES.map((l) => [l, { Sign: { signer: ((messages[l] as { Sign: { signer: Tree } }).Sign).signer, register: {} } }])) as unknown as SignerMessages;
    const html = renderToStaticMarkup(<RegisterRoot view={view()} initialLocale="en" messages={without} product="Halo" />);
    expect(looksLikeKey(html)).toBe(true);
    errors = [];
  });

  it("uses the form's own agreement words when it has them", () => {
    const html = page(view({ consent: { en: "Custom words for Kedai.", ms: "x", zh: "x", ko: "x" } }));
    expect(html).toContain("Custom words for Kedai.");
    expect(html).not.toContain("may keep the details I enter here");
  });
});

run("the page that is not there", () => {
  const notFound = (locale: SignerLocale = "en", kind?: "notFound" | "busy" | "unavailable") => renderToStaticMarkup(<RegisterNotFoundRoot kind={kind} initialLocale={locale} messages={messages} product="Halo" />);

  it("says the same plain thing every time, and nothing about any workspace or why", () => {
    const html = notFound();
    expect(html).toContain("This page is not available");
    expect(html).toContain("The link may be wrong, or registration may be closed.");
    expect(html).not.toContain("Kedai");
    expect(html).not.toMatch(/<img/);
    expect(notFound()).toBe(html);
    expect(notFound("en", "notFound")).toBe(html);
  });

  it("tells a busy page and an unavailable one apart from a missing one, in words that do not accuse", () => {
    expect(notFound("en", "busy")).toContain("Please wait a moment");
    expect(notFound("en", "unavailable")).toContain("This page is not available right now");
    expect(notFound("en", "busy")).not.toBe(notFound());
  });

  it("reads in every language with no raw key", () => {
    for (const l of REGISTER_LOCALES) {
      for (const kind of ["notFound", "busy", "unavailable"] as const) {
        const html = notFound(l, kind);
        expect(html, `${l} ${kind}`).toContain(`lang="${l}"`);
        expect(looksLikeKey(html), `${l} ${kind}`).toBe(false);
      }
    }
    expect(errors).toEqual([]);
  });
});

// ---- the words ---------------------------------------------------------------------------------------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [join(dir, name)] : []));
}

/**
 * Keys this page asks for by name. In the form `t` is `Sign.register`; in the root `r` is, and `t` there is the signing
 * page's own (`Sign.signer`: its busy words), which the frame brings.
 */
function staticKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sources(join(process.cwd(), "src", "components", "sign", "register"))) {
    const pattern = file.endsWith("register-root.tsx") ? /\br\(\s*"([^"$]+)"/g : /\bt\(\s*"([^"$]+)"/g;
    for (const m of readFileSync(file, "utf8").matchAll(pattern)) keys.add(m[1]);
  }
  return [...keys];
}

/** The families asked for with a variable: t(`fields.${detail}.label`). Each value the variable can take. */
const DETAILS = ["full_name", "company", "email", "phone"];
const FAMILIES: string[] = [
  ...DETAILS.map((d) => `fields.${d}.label`),
  ...DETAILS.flatMap((d) => ["required", "too_long", "invalid"].map((p) => `problems.${d}.${p}`)),
  "problems.consent.required",
  // the banner above the form: the server's retry codes, the notices that leave the form in place, and "invalid"
  ...["invalid", "token_invalid", "token_expired", "token_too_fast", "captcha_failed", "rate_limited", "try_later", "generic", "network"].map((c) => `errors.${c}`),
  ...["form_cap", "send_failed", "unavailable", "not_found"].flatMap((n) => [`notice.${n}.title`, `notice.${n}.body`]),
];

run("the registration page's words", () => {
  it("has, in every language, every key the page asks for", () => {
    const wanted = [...staticKeys(), ...FAMILIES];
    expect(wanted.length).toBeGreaterThan(40);
    for (const l of REGISTER_LOCALES) {
      const have = leaves(register![l]);
      for (const key of wanted) expect(have.has(key), `${l}: ${key}`).toBe(true);
    }
  });

  it("has the same keys and the same placeholders in every language, and no empty sentence", () => {
    const en = leaves(register!.en);
    for (const l of REGISTER_LOCALES.filter((x): x is Exclude<RegisterLocale, "en"> => x !== "en")) {
      const other = leaves(register![l]);
      expect([...other.keys()].sort(), l).toEqual([...en.keys()].sort());
      for (const [key, text] of en) {
        expect(placeholders(other.get(key)!), `${l}: ${key}`).toEqual(placeholders(text));
        expect(other.get(key)!.trim().length, `${l}: ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("is real Bahasa Melayu, Chinese and Korean, not English copies", () => {
    const en = leaves(register!.en);
    for (const l of ["ms", "zh", "ko"] as const) {
      const other = leaves(register![l]);
      const same = [...en].filter(([k, v]) => other.get(k) === v && /[a-z]{4}/i.test(v) && !/^\+60|^\(|\.\.\.$/.test(v));
      // a few are the same in two languages by nature ("Email" style words); a sentence never is
      expect(same.filter(([, v]) => v.split(" ").length > 3).map(([k]) => k), l).toEqual([]);
    }
  });

  it("asks for nothing from the signing page's words that the page does not have", () => {
    // the frame's own words come from Sign.signer: the shell uses these and the not-found page uses the busy ones
    const signer = (messages?.en as { Sign?: { signer?: Tree } } | undefined)?.Sign?.signer ?? {};
    for (const key of ["common.skipToContent", "common.language", "common.secured", "busy.title", "busy.body"]) expect(leaves(signer).has(key), key).toBe(true);
  });
});
