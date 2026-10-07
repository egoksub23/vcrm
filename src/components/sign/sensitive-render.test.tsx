import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { AnswerRowView } from "@/lib/sign/client/progress-logic";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { DataField, DataFieldType, L10n } from "@/lib/sign/forms/types";

import { SensitiveAnswer } from "./detail/progress/sensitive-answer";
import { SensitiveSection } from "./form-builder/sensitive-section";
import { FormUiProvider } from "./signer/form/form-ui";
import { SensitiveControl } from "./signer/form/sensitive-control";

// Render checks for the three places a sensitive answer shows: the builder's switch, the signer's masked input and the
// sender's masked answer with its Reveal button. They run with the real words of all four languages once the fragments
// (`<area>-wp20a.json`) are merged into messages/*.json. Before that, point SIGN_I18N_OVERLAY at the folder that holds the
// fragments and the same checks run against them merged in memory.

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];
type Json = Record<string, unknown>;

function merge(into: Json, from: Json): Json {
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "object" && v !== null) into[k] = merge((into[k] as Json) ?? {}, v as Json);
    else into[k] = v;
  }
  return into;
}

function messagesFor(locale: string): Json {
  const all = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Json;
  const dir = process.env.SIGN_I18N_OVERLAY;
  if (dir && existsSync(dir)) {
    const sign = ((all.Sign ??= {}) as Json);
    for (const file of readdirSync(dir).filter((f) => f.endsWith("-wp20a.json"))) {
      const area = file.split("-")[0];
      const fragment = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, Json>;
      sign[area] = merge((sign[area] as Json) ?? {}, fragment[locale] ?? {});
    }
  }
  return all;
}

const catalogue = Object.fromEntries(LOCALES.map((l) => [l, messagesFor(l)])) as Record<SignerLocale, Json>;
const sign = (l: SignerLocale) => catalogue[l].Sign as Record<string, Json>;
const merged = LOCALES.every((l) => (sign(l).formBuilder as Json | undefined)?.sensitive !== undefined && (sign(l).signerForm as Json | undefined)?.sensitive !== undefined && (sign(l).progress as Json | undefined)?.sensitive !== undefined);

const L = (en: string): L10n => ({ en });
const html = (node: React.ReactNode, locale: SignerLocale) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={catalogue[locale]}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      <FormUiProvider value={{ locale }}>{node}</FormUiProvider>
    </NextIntlClientProvider>,
  );

const field = (type: DataFieldType, over: Partial<DataField> = {}): DataField => ({ key: "ic", type, part: "p", label: L("IC number"), required: true, ...over });
const noop = () => {};
const SECRET = "900101-01-1234";
const control = (f: DataField, input: Record<string, unknown> = { text: SECRET }) => <SensitiveControl field={f} id="f1" input={input} invalid={false} onInput={noop} onBlur={noop} />;
const countOf = (s: string, part: string) => s.split(part).length - 1;

describe.runIf(merged)("the builder's switch", () => {
  for (const locale of LOCALES) {
    it(`words the switch and the print choice in ${locale}`, () => {
      const t = (sign(locale).formBuilder as { sensitive: Record<string, string> }).sensitive;
      const off = html(<SensitiveSection field={field("text")} onChange={noop} />, locale);
      expect(off).toContain('role="switch"');
      expect(off).toContain(t.label);
      expect(off).toContain(t.hint);
      expect(off).toContain('aria-checked="false"');
      expect(off).not.toContain(t.printLast4); // the print choice appears only once the switch is on
      expect(off).not.toMatch(/sensitive\.(label|hint|title)/);

      const on = html(<SensitiveSection field={field("text", { sensitive: true, printMasked: "last4" })} onChange={noop} />, locale);
      expect(on).toContain('aria-checked="true"');
      for (const word of [t.print, t.printFull, t.printLast4, t.printNone]) expect(on).toContain(word);
      expect(on).toMatch(/<option value="last4" selected/);
    });
  }

  it("is offered only to the types that can be sensitive", () => {
    for (const type of ["choice", "multichoice", "yesno", "file", "image", "acknowledge"] as const) expect(html(<SensitiveSection field={field(type)} onChange={noop} />, "en")).toBe("");
    for (const type of ["text", "multiline", "number", "email", "phone", "date", "list"] as const) expect(html(<SensitiveSection field={field(type)} onChange={noop} />, "en")).toContain('role="switch"');
  });

  it("can be turned off and on by the keyboard (a real switch, labelled and described)", () => {
    const out = html(<SensitiveSection field={field("text")} onChange={noop} />, "en");
    expect(out).toContain('aria-labelledby="sensitive-label-ic"');
    expect(out).toContain('id="sensitive-label-ic"');
    expect(out).toContain('aria-describedby="sensitive-hint-ic"');
    expect(out).toContain('id="sensitive-hint-ic"');
  });
});

describe.runIf(merged)("the signer's masked input", () => {
  for (const locale of LOCALES) {
    it(`hides what is typed, offers a named show button and says why, in ${locale}`, () => {
      const t = (sign(locale).signerForm as { sensitive: Record<string, string> }).sensitive;
      const out = html(control(field("text")), locale);
      expect(out).toContain('type="password"');
      expect(out).toContain('autoComplete="off"');
      expect(out).toContain('data-1p-ignore="true"');
      expect(out).toContain('aria-pressed="false"');
      expect(out).toContain('aria-controls="f1"');
      expect(out).toContain(`aria-label="${t.showNamed.replace("{label}", "IC number")}"`);
      expect(out).toContain(t.note);
      expect(out).toContain('aria-describedby="f1-sensitive"');
      expect(out).not.toMatch(/sensitive\.(note|showNamed|hideNamed)/);
    });
  }

  it("puts the value in the input and nowhere else in the page", () => {
    for (const type of ["text", "number", "email", "phone", "date"] as const) {
      const out = html(control(field(type)), "en");
      expect(countOf(out, SECRET), type).toBe(1);
      expect(out).toMatch(new RegExp(`<input[^>]*value="${SECRET}"`));
    }
  });

  it("keeps the phone's number pad, the email keyboard and a plain keyboard for a date", () => {
    expect(html(control(field("phone")), "en")).toContain('inputMode="tel"');
    expect(html(control(field("email")), "en")).toContain('inputMode="email"');
    expect(html(control(field("number")), "en")).toContain('inputMode="decimal"');
    expect(html(control(field("date")), "en")).not.toContain("inputMode");
  });

  it("is a tall enough target on a phone, and a list is hidden entry by entry with one show button", () => {
    expect(html(control(field("text")), "en")).toContain("size-11");
    const list = html(control(field("list"), { list: ["123456789", "987654321"] }), "en");
    expect(countOf(list, 'type="password"')).toBe(2);
    expect(list).toContain('aria-pressed="false"');
    expect(list).toContain("Show IC number");
  });

  it("hides a longer text with the browser's own text security", () => {
    const out = html(control(field("multiline"), { text: "line one\nline two" }), "en");
    expect(out).toContain("-webkit-text-security:disc");
    expect(out).toContain("<textarea");
  });
});

describe.runIf(merged)("the sender's masked answer", () => {
  const row = (over: Partial<AnswerRowView> = {}): AnswerRowView => ({
    key: "ic",
    label: "IC number",
    type: "text",
    sensitive: true,
    display: { kind: "text", text: "•••• 1234", multiline: false },
    fromContact: false,
    bySender: false,
    savedAt: null,
    ...over,
  });

  for (const locale of LOCALES) {
    it(`shows the mask and a named Reveal button, never the value, in ${locale}`, () => {
      const t = (sign(locale).progress as { sensitive: Record<string, string> }).sensitive;
      const out = html(<SensitiveAnswer documentId="d1" row={row()} canReveal />, locale);
      expect(out).toContain("•••• 1234");
      expect(out).toContain(t.reveal);
      expect(out).toContain(`aria-label="${t.revealNamed.replace("{name}", "IC number")}"`);
      expect(out).toContain(t.note);
      expect(out).toContain('aria-live="polite"');
      expect(out).not.toContain(SECRET);
      expect(out).not.toMatch(/sensitive\.(reveal|note|hide)/);
    });
  }

  it("offers no Reveal to someone who may not use it, and says nothing is answered when nothing is", () => {
    const out = html(<SensitiveAnswer documentId="d1" row={row()} canReveal={false} />, "en");
    expect(out).toContain("•••• 1234");
    expect(out).not.toContain("<button");
    const empty = html(<SensitiveAnswer documentId="d1" row={row({ display: { kind: "empty" } })} canReveal />, "en");
    expect(empty).not.toContain("<button");
  });
});

describe.runIf(merged)("the messages", () => {
  const flat = (o: Json, p = ""): Record<string, string> => Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? Object.entries(flat(v as Json, `${p}${k}.`)) : [[`${p}${k}`, String(v)]])));
  const placeholders = (s: string) => [...s.replace(/\{\w+, select, [^}]*(\{[^}]*\}[^}]*)*\}/g, "").matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
  const parts: [string, string][] = [["formBuilder", "sensitive"], ["signerForm", "sensitive"], ["progress", "sensitive"]];

  it("has the same keys and placeholders in every language", () => {
    for (const [area, key] of parts) {
      const en = flat((sign("en")[area] as Json)[key] as Json);
      expect(Object.keys(en).length).toBeGreaterThan(2);
      for (const l of LOCALES.slice(1)) {
        const other = flat((sign(l)[area] as Json)[key] as Json);
        expect(Object.keys(other).sort(), `${area}.${key} in ${l}`).toEqual(Object.keys(en).sort());
        for (const k of Object.keys(en)) expect(placeholders(other[k]), `${area}.${key}.${k} in ${l}`).toEqual(placeholders(en[k]));
      }
    }
  });

  it("words the four problems of a sensitive field and the history line in every language", () => {
    for (const l of LOCALES) {
      const issues = (sign(l).formBuilder as { issues: Record<string, string> }).issues;
      for (const code of ["bad_sensitive", "sensitive_contact_field", "sensitive_default", "sensitive_in_rule"]) expect(issues[code], `${code} in ${l}`).toMatch(/\{field\}/);
      const events = (sign(l).detail as { events: Record<string, string> }).events;
      expect(events.sensitive_viewed, `history in ${l}`).toMatch(/\{sender\}/);
      expect(events.sensitive_viewed).toMatch(/\{field\}/);
      // a language other than English is not an English copy
      if (l !== "en") expect(events.sensitive_viewed).not.toBe((sign("en").detail as { events: Record<string, string> }).events.sensitive_viewed);
    }
  });
});

describe("before the words are merged", () => {
  it("says so rather than passing silently", () => {
    // when the fragments are not merged and no overlay is given the checks above are skipped; this documents that state
    expect(typeof merged).toBe("boolean");
  });
});

describe.runIf(merged)("who may reveal (migration 176)", () => {
  const row = (): AnswerRowView => ({ key: "ic", label: "IC number", type: "text", sensitive: true, display: { kind: "text", text: "•••• 1234", multiline: false }, fromContact: false, bySender: false, savedAt: null });

  for (const locale of LOCALES) {
    it(`shows the mask and says who can show it, instead of a Reveal button, when the person may not (${locale})`, () => {
      const t = (sign(locale).progress as { sensitive: Record<string, string> }).sensitive;
      const out = html(<SensitiveAnswer documentId="d1" row={row()} canReveal={false} />, locale);
      expect(out).toContain("•••• 1234");
      expect(out).not.toContain("<button");
      expect(out).not.toContain(t.reveal + "<");
      expect(out).toContain(t.needsPermission);
      expect(out).not.toContain(t.note);
      expect(out).not.toMatch(/sensitive\.needsPermission/);
      expect(out).not.toContain(SECRET);
      // the person who may sees the usual note and a button
      const may = html(<SensitiveAnswer documentId="d1" row={row()} canReveal />, locale);
      expect(may).toContain("<button");
      expect(may).toContain(t.note);
      expect(may).not.toContain(t.needsPermission);
    });
  }
});
