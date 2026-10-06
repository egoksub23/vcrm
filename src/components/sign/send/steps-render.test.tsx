import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for the sender's signing list and options with steps and forwarding (F-68, F-95), in every
// language, with the real wording; next-intl is told to throw on a missing key or argument. They run once the Doc
// Sign message fragments of this package are merged into messages/*.json.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));

import type { SignCategory } from "@/hooks/use-sign-categories";
import type { DraftOptions } from "@/lib/sign/client/draft-options";
import { emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignRole } from "@/lib/sign/types";
import { OptionsStep } from "./options-step";
import { PeopleStep } from "./people-step";
import { ReviewStep } from "./review-step";

type Tree = Record<string, unknown>;
function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: Tree & { send?: Tree & { people?: Tree } } }).Sign;
  const send = sign?.send as (Tree & { people?: Tree; options?: Tree }) | undefined;
  if (!send?.people?.stepHeading || !send.options?.allowForwarding) return null;
  return sign as Tree;
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
  { key: "witness", label: "Witness", kind: "signer", color: 2 },
];
const person = (name: string, roleKey: string, step: number): SignerRow => ({ ...emptyRow(roleKey, step), fullName: name, email: `${name.toLowerCase()}@example.com` });
const rows = [person("Ali", "merchant", 1), person("Siti", "director", 1), person("Lim", "witness", 2)];

const options: DraftOptions = { title: "Merchant Agreement", categoryId: null, contactId: null, locale: "en", message: "", expiryDate: "", reminderText: "3, 7", codeRequired: false, signInOrder: true, allowForwarding: true };

describe.skipIf(LOCALES.length === 0)("the signing list and options with steps and forwarding", () => {
  for (const locale of LOCALES) {
    it(`headings for each step, a step number for each person (${locale})`, () => {
      const props = { roles, showInvalid: false, whatsappConfigured: true, readOnly: false, onRows: () => {}, onSignInOrder: () => {}, onGoToFields: () => {} };
      const ordered = page(locale, <PeopleStep {...props} rows={rows} signInOrder />);
      expect(ordered.match(/data-step="/g)).toHaveLength(2);
      expect(ordered.match(/type="number"/g)).toHaveLength(3);
      // the first step holds two people and the second one
      expect(ordered).toMatch(/data-step="1"[^>]*>[^<]*(Step 1 \(2 people\)|Langkah 1|第 1 步|1단계)/);
      const flat = page(locale, <PeopleStep {...props} rows={rows} signInOrder={false} />);
      expect(flat).not.toContain("data-step=");
      expect(flat).not.toContain('type="number"');
      if (locale === "en") expect(ordered).toContain("Step 2 (1 person)");
    });

    it(`the review says who signs together, and whether forwarding is allowed (${locale})`, () => {
      const html = (o: DraftOptions) =>
        page(
          locale,
          <ReviewStep roles={roles} rows={rows} options={o} categoryName={null} contactName={null} defaultExpiryDays={14} now={Date.parse("2026-10-06T08:00:00Z")} problems={[]} checking={false} canSend sending={false} sendErrorCode={null} onSend={() => {}} onGoToStep={() => {}} />,
        );
      const on = html(options);
      expect(on).toContain("Ali");
      if (locale === "en") {
        expect(on).toContain("Signs together with the others in step 1");
        expect(on).toContain("Everyone in step 1 is invited when you send");
        expect(on).toContain("People can hand their turn, or a part of the form, to someone else");
        expect(html({ ...options, allowForwarding: false })).toContain("Not allowed");
        // without signing order nothing is said about steps
        expect(html({ ...options, signInOrder: false })).not.toContain("Signs together");
      }
    });

    it(`the options carry the forwarding switch, off unless it is set (${locale})`, () => {
      const categories: SignCategory[] = [];
      const html = (o: DraftOptions) => page(locale, <OptionsStep options={o} categories={categories} defaultExpiryDays={14} now={Date.parse("2026-10-06T08:00:00Z")} showInvalid={false} readOnly={false} onChange={() => {}} />);
      expect(html(options)).toMatch(/aria-checked="true"[^>]*>/);
      expect(html({ ...options, allowForwarding: false }).match(/role="checkbox"/g)).toHaveLength(2);
    });
  }
});
