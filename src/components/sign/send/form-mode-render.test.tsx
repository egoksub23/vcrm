import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render checks for a form WITHOUT a signature (migration 169) on the sender's screens: the steps, the people, the review and the
// result of sending, the documents list, the detail banner and header, the form builder's people panel and the form step of a draft,
// in every language with the real wording (next-intl throws on a missing key or argument). They run once the message fragments of
// this work package are merged into messages/*.json, and skip until then.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({ useAccountMembers: () => ({ members: [], nameOf: () => "", profileOf: () => undefined }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { SignListRow } from "@/hooks/use-sign-documents";
import { emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignDocumentRow, SignRole } from "@/lib/sign/types";
import { DetailHeader } from "../detail/detail-header";
import { bannerFor, documentActions } from "../detail/logic";
import { StatusBanner } from "../detail/status-banner";
import { FormRolesPanel } from "../form-builder/form-roles-panel";
import { MetaLine, WaitingText } from "../list/row-parts";
import { FormFieldsStep } from "./form-fields-step";
import { PeopleStep } from "./people-step";
import { ReviewStep } from "./review-step";
import { SendResult } from "./send-result";
import { StepsNav } from "./steps-nav";

type Tree = Record<string, unknown>;

function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: Tree & { send?: { review?: Tree } } }).Sign;
  return sign?.send?.review?.sendForm ? (sign as Tree) : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

// Words of the status namespace and the list namespace that other screens own, as stand-ins with the same shape.
function page(locale: string, node: React.ReactNode) {
  const sign = wording(locale)!;
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: sign }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const roles: SignRole[] = [
  { key: "applicant", label: "Applicant", kind: "filler", color: 0 },
  { key: "accounts", label: "Accounts", kind: "filler", color: 1 },
];
const form: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: { en: "Company details" }, role: "applicant" },
    { key: "bank", title: { en: "Bank account" }, role: "accounts" },
  ],
  fields: [{ key: "legal", type: "text", part: "company", label: { en: "Legal name" }, required: true }],
};
const person = (name: string, roleKey: string, step: number): SignerRow => ({ ...emptyRow(roleKey, step), fullName: name, email: `${name.toLowerCase()}@example.com` });
const rows = [person("Ali", "applicant", 1), person("Siti", "accounts", 2)];
const options = { title: "E-invoice details", categoryId: null, contactId: null, locale: "en" as const, message: "", expiryDate: "", reminderText: "3, 7", codeRequired: true, signInOrder: true, allowForwarding: false };

describe.skipIf(LOCALES.length === 0)("a form without a signature, on the sender's screens", () => {
  for (const locale of LOCALES) {
    it(`names the first step the form, and asks for people who fill in (${locale})`, () => {
      const done = { fields: true, people: false, options: true, review: false };
      const nav = page(locale, <StepsNav current="people" done={done} onGo={() => {}} formOnly />);
      expect(nav).not.toContain("Fields</span>");
      if (locale === "en") expect(nav).toContain(">Form<");
      const props = { roles, rows: [], signInOrder: true, showInvalid: false, whatsappConfigured: true, readOnly: false, onRows: () => {}, onSignInOrder: () => {}, onGoToFields: () => {}, form, mode: "form" as const };
      const empty = page(locale, <PeopleStep {...props} />);
      if (locale === "en") {
        expect(empty).toContain("Add the people who fill this in.");
        expect(empty).toContain("People fill this in in order");
        expect(empty).not.toContain("who sign");
      }
      const agreement = page(locale, <PeopleStep {...props} mode="sign" />);
      if (locale === "en") expect(agreement).toContain("Add the people who sign or fill in this document.");
    });

    it(`the review and the result say form, not signature (${locale})`, () => {
      const review = (mode: "form" | "sign") =>
        page(
          locale,
          <ReviewStep roles={roles} rows={rows} options={options} categoryName={null} contactName={null} defaultExpiryDays={14} now={Date.parse("2026-10-06T08:00:00Z")} problems={[]} checking={false} canSend sending={false} sendErrorCode={null} onSend={() => {}} onGoToStep={() => {}} form={form} mode={mode} />,
        );
      const html = review("form");
      if (locale === "en") {
        expect(html).toContain("Send the form");
        expect(html).not.toContain("Send for signature");
        expect(html).toContain("People fill this in in order.");
        expect(html).toContain("Each person enters a one-time code first");
        expect(review("sign")).toContain("Send for signature");
      }
      const result = (mode: "form" | "sign") =>
        page(locale, <SendResult mode={mode} roles={roles} ordered result={{ documentId: "d1", reference: "SGN-1", expiresAt: "2026-10-20T00:00:00Z", invited: [{ signerId: "s1", name: "Ali", roleKey: "applicant", delivery: { channel: "email", status: "failed" }, link: "https://halo.test/s/abc" }] }} onOpenDocument={() => {}} />);
      const sent = result("form");
      if (locale === "en") {
        expect(sent).toContain("Form sent");
        expect(sent).toContain("Link for Ali");
        expect(sent).toContain("fill in the form as them");
        expect(result("sign")).toContain("Sent for signature");
      }
    });

    it(`the form step of a draft has no page editor to open (${locale})`, () => {
      const html = (formOnly: boolean) => page(locale, <FormFieldsStep documentId="d1" form={form} roles={roles} readOnly={false} onChanged={() => {}} formOnly={formOnly} />);
      expect(html(true)).toContain("Company details");
      expect(html(true)).not.toContain("<button");
      expect(html(false)).toContain("<button");
    });

    it(`marks a form in the documents list and counts who submitted (${locale})`, () => {
      const row = (mode?: "sign" | "form"): SignListRow =>
        ({ id: "d1", reference: "SGN-1", title: "E-invoice details", status: "in_progress", ...(mode ? { mode } : {}), category_id: null, contact_id: null, sign_in_order: false, sent_at: "2026-10-06T08:00:00Z", expires_at: null, completed_at: null, created_at: "2026-10-06T08:00:00Z", updated_at: "2026-10-06T08:00:00Z", contacts: null, sign_signers: [{ id: "a", full_name: "Ali", status: "signed", order_no: 1, kind: "filler" }, { id: "b", full_name: "Siti", status: "sent", order_no: 2, kind: "filler" }] }) as never;
      const meta = (m?: "sign" | "form") => page(locale, <MetaLine row={row(m)} categories={[]} />);
      const waiting = (m?: "sign" | "form") => page(locale, <WaitingText row={row(m)} />);
      if (locale === "en") {
        expect(meta("form")).toContain("Form · SGN-1");
        expect(meta("sign")).not.toContain("Form");
        expect(meta()).not.toContain("Form");
        expect(waiting("form")).toContain("1 of 2 submitted");
        expect(waiting("sign")).toContain("1 of 2 signed");
      } else {
        expect(waiting("form")).not.toBe(waiting("sign"));
      }
    });

    it(`the detail banner and header speak of submitting and the record (${locale})`, () => {
      const base = { id: "d1", account_id: "a", reference: "SGN-1", title: "E-invoice details", category_id: null, contact_id: null, ticket_id: null, deal_id: null, sign_in_order: false, code_required: false, allow_forwarding: false, created_at: "2026-10-06T08:00:00Z", sent_at: "2026-10-06T08:00:00Z", expires_at: null, base_path: "p", final_path: "f", original_path: null, retain_until: null, void_reason: null, seal_error: null } as unknown as SignDocumentRow;
      const signers = [{ full_name: "Ali", status: "signed", order_no: 1, declined_at: null, decline_reason: null }, { full_name: "Siti", status: "sent", order_no: 2, declined_at: null, decline_reason: null }] as never;
      const waiting = page(locale, <StatusBanner banner={bannerFor({ ...base, status: "in_progress", completed_at: null, mode: "form" }, signers, { settings: false })} />);
      const completed = page(locale, <StatusBanner banner={bannerFor({ ...base, status: "completed", completed_at: "2026-10-06T09:00:00Z", mode: "form" }, signers, { settings: false })} />);
      const sealing = page(locale, <StatusBanner banner={bannerFor({ ...base, status: "sealing", completed_at: null, mode: "form" }, signers, { settings: false })} />);
      if (locale === "en") {
        expect(waiting).toContain("Waiting for Siti (1 of 2 submitted)");
        expect(sealing).toContain("All submitted, sealing the record");
        expect(completed).toContain("Submitted and recorded on");
        expect(completed).not.toContain("Everyone signed");
      }
      const actions = documentActions({ ...base, status: "completed" } as never, { void: true });
      const header = (mode: "form" | "sign") =>
        page(
          locale,
          <DetailHeader document={{ ...base, status: "completed", completed_at: "2026-10-06T09:00:00Z", mode } as SignDocumentRow} links={{ category: null, contact: null, ticket: null, deal: null } as never} actions={{ ...actions, downloadSigned: true }} downloading={null} onView={() => {}} onDownload={() => {}} onVoid={() => {}} />,
        );
      if (locale === "en") {
        expect(header("form")).toContain("Download the record");
        expect(header("form")).toContain(">Form<");
        expect(header("sign")).toContain("Download signed PDF");
      }
    });

    it(`the builder's people panel lists the people who fill in (${locale})`, () => {
      const html = page(locale, <FormRolesPanel roles={roles} form={form} readOnly={false} onChange={() => {}} />);
      if (locale === "en") {
        expect(html).toContain("People who fill this in");
        expect(html).toContain("Applicant, Accounts");
      }
      expect(html).toContain('aria-expanded="false"');
    });
  }
});
