import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The editor of the people who receive a copy (a bulk send's list, a registration form's list), first paint, in every language, with the real
// messages. Effects do not run under renderToStaticMarkup, so what is checked is what is drawn from the rows it is given: the rows, the limit, what is
// flagged once the sender has tried to go on, and the lines about an address listed twice or one that also signs. What each click does to the rows
// is the pure logic of copy-form.ts (tested there: add, remove, stop at ten, update).

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a1" }) }));

import { addCopy, emptyCopy, type CopyRow } from "@/lib/sign/client/copy-form";
import { MAX_COPY_RECIPIENTS } from "@/lib/sign/copy-list";

import { CopyListEditor } from "./copy-list-editor";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;

const sign = (locale: Locale): Tree => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;
const words = (locale: Locale) => sign(locale).copyList as Record<string, string>;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

function draw(locale: Locale, rows: readonly CopyRow[], over: Partial<React.ComponentProps<typeof CopyListEditor>> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      // the contact search's own words (Sign.send.contact) are not this package's: the English ones stand in
      messages={{ Sign: { copyList: sign(locale).copyList, send: sign("en").send } }}
      onError={(e) => {
        throw e;
      }}
    >
      <CopyListEditor idPrefix="t" rows={rows} onChange={() => {}} help="HELP-LINE" {...over} />
    </NextIntlClientProvider>,
  );
}

const person = (n: number) => emptyCopy({ fullName: `Person ${n}`, email: `p${n}@kedai.example` });
const rowsIn = (html: string) => (html.match(/data-copy-row/g) ?? []).length;
/** The opening tag of the "add" button. */
const addTag = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`))?.[0] ?? "";

describe("the list of people who receive a copy", () => {
  it("has a sentence for everything it can say, in every language", () => {
    for (const l of LOCALES) for (const k of ["title", "fullName", "email", "add", "remove", "count", "limit", "nameRequired", "emailInvalid", "duplicate", "signer"]) expect(words(l)[k], `${l}.${k}`).toBeTypeOf("string");
  });

  it("shows the title, the parent's sentence, the add button and how many of ten, with no row when nobody is on it", () => {
    for (const l of LOCALES) {
      const html = draw(l, []);
      const t = words(l);
      expect(html, l).toContain(t.title);
      expect(html, l).toContain("HELP-LINE");
      expect(html, l).toContain(t.add);
      expect(html, l).toContain(t.count.replace("{count}", "0").replace("{max}", String(MAX_COPY_RECIPIENTS)));
      expect(rowsIn(html), l).toBe(0);
      expect(html, l).not.toContain('role="alert"');
      expect(html, l).not.toMatch(/Sign\.copyList|\{(count|max|number)\}/);
    }
    expect(errors).toEqual([]);
  });

  it("draws each person with their name and email in the boxes, and a way to take them off", () => {
    for (const l of LOCALES) {
      const html = draw(l, [person(1), person(2)]);
      expect(rowsIn(html), l).toBe(2);
      for (const n of [1, 2]) {
        expect(html, l).toContain(`value="Person ${n}"`);
        expect(html, l).toContain(`value="p${n}@kedai.example"`);
        expect(html, l).toContain(`aria-label="${words(l).remove.replace("{number}", String(n))}"`);
      }
      expect(html, l).toContain('type="email"');
      expect(html, l).toContain('role="combobox"');
      // nothing is wrong with them: no alert, no notice
      expect(html, l).not.toContain('role="alert"');
      expect(html, l).not.toContain("data-copy-notice");
    }
    expect(errors).toEqual([]);
  });

  it("stops at ten: the add button is off and the limit is said", () => {
    let rows: CopyRow[] = [];
    for (let i = 1; i <= MAX_COPY_RECIPIENTS + 2; i++) rows = addCopy(rows, { fullName: `Person ${i}`, email: `p${i}@kedai.example` });
    expect(rows).toHaveLength(MAX_COPY_RECIPIENTS);
    for (const l of LOCALES) {
      const html = draw(l, rows);
      expect(rowsIn(html), l).toBe(MAX_COPY_RECIPIENTS);
      expect(html, l).toContain(words(l).limit.replace("{max}", String(MAX_COPY_RECIPIENTS)));
      expect(addTag(html, words(l).add), l).toContain('disabled=""');
    }
    // one under the limit can still add
    expect(addTag(draw("en", rows.slice(1)), words("en").add)).not.toContain('disabled=""');
  });

  it("flags a person who is started but not complete once the sender has tried to go on, and not before; a blank row is not flagged", () => {
    const rows = [emptyCopy({ fullName: "Mei" }), emptyCopy({ email: "raj@kedai.example" }), emptyCopy({ fullName: "Sam", email: "sam@" }), emptyCopy()];
    for (const l of LOCALES) {
      const t = words(l);
      const before = draw(l, rows);
      expect(before, l).not.toContain('role="alert"');
      const after = draw(l, rows, { showInvalid: true });
      // Mei: email; Raj: name; Sam: email. The blank row has no message.
      expect(after.split(t.emailInvalid).length - 1, l).toBe(2);
      expect(after.split(t.nameRequired).length - 1, l).toBe(1);
      expect(after, l).toContain('aria-invalid="true"');
    }
    // a complete person is never flagged
    expect(draw("en", [person(1)], { showInvalid: true })).not.toContain('role="alert"');
  });

  it("names an address listed twice, on the entry that is left out and not on the first", () => {
    const rows = [emptyCopy({ fullName: "Mei", email: "mei@kedai.example" }), emptyCopy({ fullName: "Raj", email: "raj@kedai.example" }), emptyCopy({ fullName: "Mei again", email: " MEI@kedai.example" })];
    for (const l of LOCALES) {
      const html = draw(l, rows);
      expect(html.split("data-copy-notice").length - 1, l).toBe(1);
      expect(html, l).toContain(words(l).duplicate);
      expect(html, l).not.toContain(words(l).signer);
    }
  });

  it("names a person who also signs as left out, whatever case they are typed in", () => {
    const rows = [emptyCopy({ fullName: "Siti", email: "SITI@vircle.example" }), person(2)];
    for (const l of LOCALES) {
      const html = draw(l, rows, { signerEmails: [" siti@vircle.example "] });
      expect(html.split("data-copy-notice").length - 1, l).toBe(1);
      expect(html, l).toContain(words(l).signer);
    }
    // nobody signs: no notice
    expect(draw("en", rows, { signerEmails: [] })).not.toContain("data-copy-notice");
  });

  it("can be switched off as a whole", () => {
    const html = draw("en", [person(1)], { disabled: true });
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(addTag(html, words("en").add)).toContain('disabled=""');
  });
});
