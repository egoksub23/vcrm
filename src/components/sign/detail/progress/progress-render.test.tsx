import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for the form screens of a document in progress (the progress panel, the new history lines, the
// form-aware steps of the send flow), in every language, with the real wording. next-intl is told to throw on a missing
// key or argument instead of printing a raw key path. Effects do not run under renderToStaticMarkup.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({ members: [], nameOf: (id: string | null | undefined) => (id === "u1" ? "Gokula" : ""), profileOf: () => undefined }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/sign/editor/draft-fields-editor", () => ({ DraftFieldsEditor: () => React.createElement("div", { "data-testid": "field-editor" }) }));

import { HistoryView } from "../history-view";
import { ReminderParts } from "../signer-dialogs";
import { FormFieldsStep } from "@/components/sign/send/form-fields-step";
import { FormProblemText } from "@/components/sign/send/form-problem-text";
import { FormReviewSummary } from "@/components/sign/send/form-review-summary";
import { FormRolesCard } from "@/components/sign/send/form-roles-card";
import { PeopleStep } from "@/components/sign/send/people-step";
import { ReviewStep } from "@/components/sign/send/review-step";
import type { StaffProgress } from "@/lib/sign/forms/api-types";
import type { FormDefinition } from "@/lib/sign/forms/types";
import { optionsFromDocument } from "@/lib/sign/client/draft-options";
import { emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { ProgressPanel } from "./progress-panel";

type Tree = Record<string, unknown>;

/** Sign.progress for a language, from the merged messages. */
function progressWording(locale: string): Tree | null {
  const merged = join(process.cwd(), "messages", `${locale}.json`);
  if (existsSync(merged)) {
    const found = (JSON.parse(readFileSync(merged, "utf8")) as { Sign?: { progress?: Tree } }).Sign?.progress;
    if (found) return found;
  }
  return null;
}

function sign(locale: string, key: "detail" | "send"): Tree | null {
  const merged = join(process.cwd(), "messages", `${locale}.json`);
  return existsSync(merged) ? ((JSON.parse(readFileSync(merged, "utf8")) as { Sign?: Record<string, Tree> }).Sign?.[key] ?? null) : null;
}

const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => progressWording(l) !== null && sign(l, "detail") !== null && sign(l, "send") !== null);

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { progress: progressWording(locale), detail: sign(locale, "detail"), send: sign(locale, "send") } }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const L = (en: string, ms?: string) => ({ en, ...(ms ? { ms } : {}) });

const form: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company and tax", "Syarikat dan cukai"), role: "merchant" },
    { key: "address", title: L("Address and contacts"), role: "merchant" },
    { key: "invoice", title: L("e-Invoice input"), role: "merchant" },
    { key: "bank", title: L("Bank account"), role: "finance" },
  ],
  fields: [
    { key: "legalName", type: "multiline", part: "company", label: L("Legal name"), required: true, contactField: "name" },
    { key: "bizType", type: "choice", part: "company", label: L("Type", "Jenis"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }] },
    { key: "msic", type: "list", part: "company", label: L("MSIC codes"), required: true },
    { key: "terms", type: "acknowledge", part: "company", label: L("Terms"), required: true, text: L("I agree") },
    { key: "street", type: "text", part: "address", label: L("Street"), required: true, contactField: "custom:Street" },
    { key: "ssm", type: "file", part: "invoice", label: L("Form 9"), required: true, accept: ["pdf"] },
    { key: "logo", type: "image", part: "invoice", label: L("Signature"), required: false },
    { key: "account", type: "text", part: "bank", label: L("Account"), required: true },
  ],
};

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const progress = (): StaffProgress => ({
  form,
  roles: [
    {
      roleKey: "merchant",
      roleLabel: "Merchant",
      signer: { id: "s1", name: "Ali bin Ahmad", email: "ali@kedairuncit.example", status: "viewed" },
      parts: [
        { key: "company", title: form.parts[0].title, state: "done", done: 4, total: 4, visible: 4, lastSavedAt: "2026-10-05T16:20:00Z" },
        { key: "address", title: form.parts[1].title, state: "in_progress", done: 0, total: 1, visible: 1, lastSavedAt: "2026-10-06T09:12:00Z" },
        { key: "invoice", title: form.parts[2].title, state: "not_started", done: 0, total: 1, visible: 2, lastSavedAt: null },
      ],
      percent: 67,
      lastActivityAt: "2026-10-06T09:12:00Z",
    },
    {
      roleKey: "finance",
      roleLabel: "Finance",
      signer: { id: "s2", name: "Siti", email: "siti@example.com", status: "sent" },
      parts: [{ key: "bank", title: form.parts[3].title, state: "not_started", done: 0, total: 1, visible: 1, lastSavedAt: null }],
      percent: 0,
      lastActivityAt: null,
    },
  ],
  answers: [
    { key: "legalName", type: "multiline", part: "company", label: form.fields[0].label, role: "merchant", value: { text: "Kedai Runcit\nAli" }, source: "signer", savedAt: "2026-10-05T16:00:00Z" },
    { key: "bizType", type: "choice", part: "company", label: form.fields[1].label, role: "merchant", value: { text: "sdn_bhd" }, source: "contact", savedAt: null },
    { key: "msic", type: "list", part: "company", label: form.fields[2].label, role: "merchant", value: { list: ["47111", "47211"] }, source: "signer", savedAt: "2026-10-05T16:05:00Z" },
    { key: "terms", type: "acknowledge", part: "company", label: form.fields[3].label, role: "merchant", value: { checked: true }, source: "signer", savedAt: "2026-10-05T16:10:00Z" },
    { key: "street", type: "text", part: "address", label: form.fields[4].label, role: "merchant", value: null, source: "signer", savedAt: null },
    { key: "ssm", type: "file", part: "invoice", label: form.fields[5].label, role: "merchant", value: { files: [{ id: "f1", name: "form9.pdf", mime: "application/pdf", size: 120_000, sha256: "ab" }] }, source: "signer", savedAt: "2026-10-06T09:00:00Z" },
    { key: "logo", type: "image", part: "invoice", label: form.fields[6].label, role: "merchant", value: { image: PNG, mime: "image/png" }, source: "signer", savedAt: "2026-10-06T09:01:00Z" },
  ],
  lastActivityAt: "2026-10-06T09:12:00Z",
  issues: [{ code: "answer_does_not_fit", field: "legalName", detail: "p1" }, { code: "other_thing" }],
});

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({
    id: "d1",
    reference: "SGN-2026-000123",
    title: "Merchant Application",
    status: "in_progress",
    category_id: null,
    contact_id: "c1",
    roles_snapshot: [
      { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
      { key: "finance", label: "Finance", kind: "filler", color: 1 },
    ],
    form_snapshot: form,
    fields_snapshot: [],
    sign_in_order: false,
    code_required: false,
    locale: "en",
    message: null,
    expires_at: "2026-10-20T00:00:00Z",
    ...over,
  }) as unknown as SignDocumentRow;

const signer = (over: Partial<SignSignerRow>): SignSignerRow =>
  ({
    id: "s1",
    document_id: "d1",
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedairuncit.example",
    phone: null,
    channel: "email",
    order_no: 1,
    status: "viewed",
    invited_at: "2026-10-05T10:00:00Z",
    viewed_at: "2026-10-05T10:05:00Z",
    signed_at: null,
    declined_at: null,
    decline_reason: null,
    device: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
    last_reminded_at: null,
    reminder_count: 0,
    created_at: "2026-10-05T09:00:00Z",
    updated_at: "2026-10-06T09:12:00Z",
    ...over,
  }) as unknown as SignSignerRow;

const caps = { send: true, void: true, settings: true };
const NOW = Date.parse("2026-10-06T11:12:00Z");

// the sign statuses are read from the merged messages' Sign.send; a fixture event row:
const event = (type: string, seq: number, detail: Record<string, unknown> = {}) => ({
  id: `e${seq}`,
  doc_seq: seq,
  signer_id: "s1",
  type,
  actor_type: (type === "expiry_extended" ? "user" : "signer") as "user" | "signer",
  actor_user_id: type === "expiry_extended" ? "u1" : null,
  detail,
  ip: null,
  device: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1",
  created_at: "2026-10-06T09:12:00Z",
});

describe.skipIf(LOCALES.length === 0)("the form screens render in every language", () => {
  for (const locale of LOCALES) {
    it(`progress panel: loading, failed and the full view (${locale})`, () => {
      const base = { document: doc(), signers: [signer({}), signer({ id: "s2", role_key: "finance", kind: "filler", full_name: "Siti", status: "sent", device: null })], events: [event("viewed", 1), event("writeback", 2, { field: "email", old: "a", new: "b" })], caps, now: NOW, onChanged: async () => {}, onRetry: () => {} };
      expect(page(locale, <ProgressPanel {...base} progress={null} loading error={null} />)).toContain('role="status"');
      expect(page(locale, <ProgressPanel {...base} progress={null} loading={false} error={null} />)).toContain('role="alert"');

      const html = page(locale, <ProgressPanel {...base} progress={progress()} loading={false} error={null} />);
      // the people and the parts
      expect(html).toContain("Ali bin Ahmad");
      expect(html).toContain("Siti");
      expect(html).toContain('role="progressbar"');
      expect(html).toContain('aria-valuenow="67"');
      // the answers, as given: the multi-line text, a choice by label, a list one per line, a file, a picture
      expect(html).toContain("Kedai Runcit");
      expect(html).toContain("47211");
      expect(html).toContain("form9.pdf");
      expect(html).toContain(PNG);
      // the issues and the contact link
      expect(html).toContain('href="/contacts?contact=c1"');
      expect(html).toContain("sign-progress-issues");
    });

    it(`progress panel keeps actions to the people who may use them (${locale})`, () => {
      const base = { signers: [signer({}), signer({ id: "s2", role_key: "finance", kind: "filler", status: "sent", full_name: "Siti" })], events: null, now: NOW, onChanged: async () => {}, onRetry: () => {}, progress: progress(), loading: false, error: null };
      const open = page(locale, <ProgressPanel {...base} document={doc()} caps={caps} />);
      expect(open.match(/<button[^>]*>/g)?.length).toBeGreaterThan(3);
      // a finished document offers neither Remind nor Extend expiry
      const done = page(locale, <ProgressPanel {...base} document={doc({ status: "completed" })} caps={caps} />);
      const without = page(locale, <ProgressPanel {...base} document={doc()} caps={{ send: false, void: false, settings: false }} />);
      expect(done.length).toBeLessThan(open.length);
      expect(without.length).toBeLessThan(open.length);
    });

    it(`the reminder confirmation names the parts still open (${locale})`, () => {
      const html = page(locale, <ReminderParts parts={["Address and contacts", "e-Invoice input"]} />);
      expect(html).toContain("e-Invoice input");
    });

    it(`history words every event of a form (${locale})`, () => {
      const types = ["part_completed", "part_reopened", "uploaded", "upload_removed", "writeback", "expiry_extended"];
      const rows = types.flatMap((type, i) => [
        event(type, i * 2 + 1, { part: "company", field: type === "writeback" ? "email" : "ssm", name: "form9.pdf", expires_at: "2026-10-20T15:59:00Z", old: "SECRET-OLD", new: "SECRET-NEW" }),
        event(type, i * 2 + 2, {}),
      ]);
      const signers = [{ id: "s1", full_name: "Ali bin Ahmad", order_no: 1 }];
      const html = page(locale, <HistoryView events={rows} chain={{ state: "intact", events: 12 }} loading={false} failed={false} signers={signers} signInOrder={false} technical form={form} contactId="c1" />);
      expect(html).toMatch(/Company and tax|Syarikat dan cukai/);
      expect(html).toContain("form9.pdf");
      expect(html).toContain('href="/contacts?contact=c1"');
      // only that a value changed is said, never the old or new value
      expect(html).not.toContain("SECRET-OLD");
      expect(html).not.toContain("SECRET-NEW");
    });

    it(`the fields step shows the form, not the editor, until Edit fields is chosen (${locale})`, () => {
      const html = page(locale, <FormFieldsStep documentId="d1" form={form} roles={doc().roles_snapshot} readOnly={false} onChanged={() => {}} />);
      expect(html).toMatch(/Company and tax|Syarikat dan cukai/);
      expect(html).toContain("Finance");
      expect(html).not.toContain("field-editor");
      expect(html).toContain("aria-expanded=\"false\"");
    });

    it(`the people step lists what each role holds, and flags a role with nobody (${locale})`, () => {
      const rows: SignerRow[] = [{ ...emptyRow("merchant"), fullName: "Ali", email: "ali@example.com" }];
      const html = page(locale, <FormRolesCard form={form} roles={doc().roles_snapshot} rows={rows} />);
      expect(html).toContain("Merchant");
      expect(html).toContain('role="status"');
      const both = page(locale, <FormRolesCard form={form} roles={doc().roles_snapshot} rows={[...rows, { ...emptyRow("finance"), fullName: "Siti", email: "siti@example.com" }]} />);
      expect(both).not.toContain('role="status"');

      const step = page(locale, <PeopleStep roles={doc().roles_snapshot} rows={rows} signInOrder={false} showInvalid={false} whatsappConfigured={false} readOnly={false} onRows={() => {}} onSignInOrder={() => {}} onGoToFields={() => {}} form={form} />);
      expect(step).toContain("form-roles-title");
    });

    it(`the review step summarises the form, the prefill and the blocking problem (${locale})`, () => {
      const rows: SignerRow[] = [{ ...emptyRow("merchant"), fullName: "Ali", email: "ali@example.com" }];
      const withContact = page(locale, <FormReviewSummary form={form} roles={doc().roles_snapshot} rows={rows} contactId="c1" />);
      expect(withContact).toContain('role="status"');
      const without = page(locale, <FormReviewSummary form={form} roles={doc().roles_snapshot} rows={rows} contactId={null} />);
      expect(without).toContain("review-form");
      expect(without).not.toBe(withContact);

      const options = { ...optionsFromDocument(doc()), title: "Merchant Application" };
      const review = page(
        locale,
        <ReviewStep
          roles={doc().roles_snapshot}
          rows={rows}
          options={options}
          categoryName={null}
          contactName={null}
          defaultExpiryDays={14}
          now={NOW}
          problems={[{ code: "part_without_person", role: "finance" }]}
          checking={false}
          canSend
          sending={false}
          sendErrorCode={null}
          onSend={() => {}}
          onGoToStep={() => {}}
          form={form}
        />,
      );
      expect(review).toContain("review-form");
      expect(review).toContain("review-problems");
      expect(page(locale, <FormProblemText issue={{ code: "part_without_person", role: "finance" }} roleLabel="Finance" />)).toContain("Finance");
    });
  }
});

describe("every sentence of Sign.progress can be said in every language", () => {
  const sample: Record<string, string | number> = {
    count: 2, done: 1, total: 3, percent: 50, name: "Ali", when: "today", device: "a phone", date: "20 Oct 2026", field: "Legal name", code: "x", role: "Merchant", parts: "1 to 4", from: 1, to: 4,
    mode: "partsSign", hasPart: "yes", part: "Company", hasFile: "yes", file: "form9.pdf", hasField: "yes", actor: "Ali", sender: "Gokula", hasFields: "yes", fields: "name, email", hasDate: "yes", parts_: "x", fieldsCount: 3,
  };
  const leaves = (o: Tree, prefix = ""): [string, string][] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? leaves(v as Tree, prefix + k + ".") : [[prefix + k, String(v)] as [string, string]]));

  for (const locale of ["en", "ms", "zh", "ko"]) {
    const tree = progressWording(locale);
    it.skipIf(tree === null)(`formats with real values (${locale})`, () => {
      const t = createTranslator({
        locale,
        messages: { progress: tree as Tree },
        namespace: "progress",
        onError: (e) => {
          throw e;
        },
      });
      for (const variant of ["yes", "no"]) {
        const values = { ...sample, hasPart: variant, hasFile: variant, hasField: variant, hasFields: variant, hasDate: variant, mode: variant === "yes" ? "partsFill" : "signOnly" };
        for (const [key] of leaves(tree as Tree)) {
          expect(() => t(key as never, values as never), key).not.toThrow();
          expect(String(t(key as never, values as never)).trim().length, key).toBeGreaterThan(0);
        }
      }
    });
  }
});
