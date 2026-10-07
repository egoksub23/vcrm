import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The single document's People step with people who receive a copy, and the review's lines about them, in every language with the real wording
// (next-intl is told to throw on a missing key or argument). Effects do not run in a static render, so the contact search never starts.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));

import { emptyCopy } from "@/lib/sign/client/copy-form";
import type { DraftOptions } from "@/lib/sign/client/draft-options";
import { emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignRole } from "@/lib/sign/types";
import { PeopleStep } from "./people-step";
import { ReviewStep } from "./review-step";

type Tree = Record<string, unknown>;
function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: Tree & { send?: Tree & { copies?: Tree } } }).Sign;
  return sign?.send?.copies?.heading ? (sign as Tree) : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale)! }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const person = (name: string, roleKey: string, step: number, email = `${name.toLowerCase()}@example.com`): SignerRow => ({ ...emptyRow(roleKey, step), fullName: name, email });
const rows = [person("Ali", "merchant", 1), person("Siti", "director", 2)];
const copies = [emptyCopy({ fullName: "Mei Lin", email: "mei@example.com" }), emptyCopy({ fullName: "Raj Kumar", email: "raj@example.com" })];

const props = { roles, signInOrder: false, showInvalid: false, whatsappConfigured: true, readOnly: false, onRows: () => {}, onSignInOrder: () => {}, onGoToFields: () => {}, onCopies: () => {} };
const options: DraftOptions = { title: "Merchant Agreement", categoryId: null, contactId: null, locale: "en", message: "", expiryDate: "", reminderText: "3, 7", codeRequired: false, signInOrder: false, allowForwarding: true };
const review = (r: readonly SignerRow[], c: typeof copies) =>
  <ReviewStep roles={roles} rows={r} copies={c} options={options} categoryName={null} contactName={null} defaultExpiryDays={14} now={Date.parse("2026-10-06T08:00:00Z")} problems={[]} checking={false} canSend sending={false} sendErrorCode={null} onSend={() => {}} onGoToStep={() => {}} />;

/** The copy section of a People step, alone. */
const copySection = (html: string): string => {
  const start = html.indexOf("data-copy-section");
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
};

describe.skipIf(LOCALES.length === 0)("people who receive a copy on a document's People step", () => {
  for (const locale of LOCALES) {
    it(`lists them after the people who must sign, as rows with a name, an email, a type and remove, and no role, channel, step or Halo user (${locale})`, () => {
      const html = page(locale, <PeopleStep {...props} rows={rows} copies={copies} signInOrder />);
      const section = copySection(html);
      // two rows, listed after the signers
      expect(section.match(/data-copy-row/g)).toHaveLength(2);
      expect(html.indexOf("Siti")).toBeLessThan(html.indexOf("data-copy-section"));
      expect(section).toContain("Mei Lin");
      expect(section).toContain("raj@example.com");
      // the name box is the contact search for both kinds of row
      expect(section.match(/role="combobox"/g)).toHaveLength(2);
      expect(html.match(/role="combobox"/g)).toHaveLength(4);
      // a type dropdown on every row of both lists, each saying what the person is
      expect(html.match(/id="[^"]*-type"/g)).toHaveLength(4);
      expect(section).toMatch(/<select[^>]*>[\s\S]*?<option value="copy" selected="">/);
      // nothing a signer has
      expect(section).not.toContain("-role");
      expect(section).not.toContain("-channel");
      expect(section).not.toContain("-phone");
      expect(section).not.toContain('type="number"');
      expect(section).not.toContain("data-halo-user");
      expect(section).not.toContain("data-step");
      if (locale === "en") {
        expect(section).toContain("People who receive a copy");
        expect(section).toContain("They get the signed copy by email when everyone has signed. They never get a signing link.");
        expect(section).toContain("Must sign");
        expect(section).toContain("Receives a copy");
      }
    });

    it(`the signing rows keep their role, channel and step exactly as before, with the type dropdown beside them (${locale})`, () => {
      const html = page(locale, <PeopleStep {...props} rows={rows} copies={copies} signInOrder />);
      const signing = html.slice(0, html.indexOf("data-copy-section"));
      expect(signing.match(/id="[^"]*-role"/g)).toHaveLength(2);
      expect(signing.match(/id="[^"]*-channel"/g)).toHaveLength(2);
      expect(signing.match(/type="number"/g)).toHaveLength(2);
      expect(signing).toContain('data-step="1"');
    });

    it(`shows the copy section even before any field is placed, below the "place the fields first" state (${locale})`, () => {
      const html = page(locale, <PeopleStep {...props} roles={[]} rows={[]} copies={[emptyCopy({ fullName: "Mei Lin", email: "mei@example.com" })]} />);
      expect(html).toContain("data-copy-section");
      expect(html.indexOf("data-copy-section")).toBeGreaterThan(html.indexOf("<h2"));
      expect(html.match(/<h2/g)).toHaveLength(1);
      // "Must sign" cannot be chosen yet: there is no role to sign
      expect(copySection(html)).toMatch(/<option value="signer" disabled=""/);
    });

    it(`has no copy section and no type dropdown unless the screen takes copy people (${locale})`, () => {
      const html = page(locale, <PeopleStep {...props} onCopies={undefined} rows={rows} signInOrder={false} />);
      expect(html).not.toContain("data-copy-section");
      expect(html).not.toMatch(/id="[^"]*-type"/);
      // and the empty state alone, as before
      expect(page(locale, <PeopleStep {...props} onCopies={undefined} roles={[]} rows={[]} />)).not.toContain("data-copy-section");
    });

    it(`has no copy section for a form without a signature (${locale})`, () => {
      expect(page(locale, <PeopleStep {...props} rows={rows} copies={copies} mode="form" />)).not.toContain("data-copy-section");
    });

    it(`says an address listed twice or one that signs is left out, and shows the limit (${locale})`, () => {
      const twice = [emptyCopy({ fullName: "Mei", email: "mei@example.com" }), emptyCopy({ fullName: "Mei 2", email: "MEI@example.com" })];
      const html = page(locale, <PeopleStep {...props} rows={rows} copies={twice} />);
      expect(copySection(html).match(/text-amber-700/g)).toHaveLength(2);
      const signs = page(locale, <PeopleStep {...props} rows={rows} copies={[emptyCopy({ fullName: "Ali", email: "ALI@example.com" })]} />);
      expect(copySection(signs).match(/text-amber-700/g)).toHaveLength(1);
      const ten = Array.from({ length: 10 }, (_, i) => emptyCopy({ fullName: `P${i}`, email: `p${i}@example.com` }));
      const limited = page(locale, <PeopleStep {...props} rows={rows} copies={ten} />);
      if (locale === "en") expect(limited).toContain("Up to 10 people can receive a copy.");
      // the signing rows cannot choose "Receives a copy" any more
      expect(limited.slice(0, limited.indexOf("data-copy-section"))).toMatch(/<option value="copy" disabled=""/);
    });

    it(`the review lists them apart from the signers, and says what was left out (${locale})`, () => {
      const html = page(locale, review(rows, copies));
      expect(html).toContain("data-copy-review");
      expect(html).toContain("Mei Lin (mei@example.com)");
      expect(html).toContain("Raj Kumar (raj@example.com)");
      if (locale === "en") expect(html).toContain("Will also get the signed copy: Mei Lin (mei@example.com), Raj Kumar (raj@example.com)");
      // nobody is listed in the numbered list of people who sign
      expect(html.match(/<li class="flex gap-3 text-sm">/g)).toHaveLength(2);

      const none = page(locale, review(rows, []));
      expect(none).not.toContain("data-copy-review");

      // a copy person who is also a signer, and an address listed twice: not blocking (the button is still on), and named
      const odd = page(locale, review(rows, [emptyCopy({ fullName: "Ali", email: "ALI@example.com" }), emptyCopy({ fullName: "Mei", email: "mei@example.com" }), emptyCopy({ fullName: "Mei 2", email: "mei@example.com" })]));
      expect(odd).toContain("Mei (mei@example.com)");
      expect(odd).not.toContain("Ali (ALI@example.com)");
      expect(odd.match(/text-amber-700 dark:text-amber-300">/g)?.length).toBeGreaterThanOrEqual(2);
      expect(odd).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*lucide-send/);
    });
  }
});
