import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for the detail screen's parts, in every language, with the real wording. next-intl is told to
// throw on a missing key or argument instead of printing a raw key path. Effects do not run under
// renderToStaticMarkup, so the Supabase stub is never awaited.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({ members: [], nameOf: (id: string | null | undefined) => (id === "u1" ? "Gokula" : ""), profileOf: () => undefined }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { ContactDocuments } from "./contact-documents";
import { DetailHeader } from "./detail-header";
import { FilesList } from "./files-list";
import { HistoryView } from "./history-view";
import { documentActions, bannerFor } from "./logic";
import { PeopleList } from "./people-list";
import { StatusBanner } from "./status-banner";

function wording(locale: string): Record<string, unknown> | null {
  const merged = join(process.cwd(), "messages", `${locale}.json`);
  if (existsSync(merged)) {
    const detail = (JSON.parse(readFileSync(merged, "utf8")) as { Sign?: { detail?: Record<string, unknown> } }).Sign?.detail;
    if (detail) return detail;
  }
  return null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

// The status words live in another namespace (Sign.send); a stand-in with the same shape.
const STATUS = {
  document: { draft: "Draft", sent: "Sent", in_progress: "In progress", sealing: "Sealing", completed: "Completed", declined: "Declined", expired: "Expired", voided: "Cancelled", failed: "Failed" },
  signer: { pending: "Pending", sent: "Invited", viewed: "Opened", signed: "Signed", declined: "Declined", filled: "Filled in" },
  unknown: "Unknown",
};

// the words of the lock on a private document (migration 176)
function privateWords(locale: string): Record<string, unknown> | undefined {
  return (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign?: { private?: Record<string, unknown> } }).Sign?.private;
}

function page(locale: string, node: React.ReactNode) {
  const detail = wording(locale);
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { detail, send: { status: STATUS }, private: privateWords(locale) } }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({
    id: "d1",
    account_id: "a1",
    reference: "SGN-2026-000123",
    title: "Merchant Agreement",
    status: "in_progress",
    category_id: null,
    template_version_id: null,
    contact_id: null,
    ticket_id: null,
    deal_id: null,
    merge_values: {},
    fields_snapshot: [],
    roles_snapshot: [
      { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
      { key: "director", label: "Director", kind: "signer", color: 1 },
    ],
    sign_in_order: true,
    code_required: true,
    locale: "en",
    message: null,
    expires_at: "2026-10-20T00:00:00Z",
    sent_at: "2026-10-06T09:10:00Z",
    completed_at: null,
    retain_until: null,
    original_path: "x",
    original_type: "application/pdf",
    original_sha256: null,
    base_path: "y",
    base_sha256: null,
    page_count: 3,
    final_path: null,
    final_sha256: null,
    void_reason: null,
    reminder_days: null,
    sealing_started_at: null,
    sealing_attempts: 0,
    seal_error: null,
    created_by: "u1",
    created_at: "2026-10-06T09:04:00Z",
    updated_at: "2026-10-06T09:10:00Z",
    ...over,
  }) as SignDocumentRow;

const signer = (over: Partial<SignSignerRow>): SignSignerRow =>
  ({
    id: "s1",
    account_id: "a1",
    document_id: "d1",
    role_key: "merchant",
    kind: "signer",
    full_name: "Ali bin Ahmad",
    email: "ali@kedairuncit.example",
    phone: "+60123456789",
    channel: "email",
    order_no: 1,
    status: "signed",
    internal_user_id: null,
    invited_at: "2026-10-06T09:10:00Z",
    viewed_at: "2026-10-06T10:36:00Z",
    signed_at: "2026-10-06T10:42:00Z",
    declined_at: null,
    decline_reason: null,
    ip: null,
    device: null,
    locale: null,
    consent_version: null,
    consented_at: null,
    last_reminded_at: null,
    reminder_count: 0,
    created_at: "2026-10-06T09:04:00Z",
    updated_at: "2026-10-06T10:42:00Z",
    ...over,
  }) as SignSignerRow;

describe.skipIf(LOCALES.length === 0)("the detail screen renders in every language", () => {
  const caps = { send: true, void: true, reveal: true, settings: true };

  for (const locale of LOCALES) {
    it(`banner, header, people, files and history (${locale})`, () => {
      const signers = [signer({}), signer({ id: "s2", full_name: "Gokula", role_key: "director", order_no: 2, status: "sent", viewed_at: null, signed_at: null, reminder_count: 2, last_reminded_at: "2026-10-06T11:00:00Z" })];

      // every banner
      const base = { completed_at: "2026-10-07T00:00:00Z", expires_at: "2026-10-20T00:00:00Z", void_reason: "Wrong fee", seal_error: "font missing" };
      for (const status of ["sent", "in_progress", "sealing", "completed", "declined", "expired", "voided", "failed"]) {
        const declined = status === "declined" ? [signer({ status: "declined", declined_at: "2026-10-07T00:00:00Z", decline_reason: "Fee is wrong" })] : signers;
        const html = page(locale, <StatusBanner banner={bannerFor({ status, ...base }, declined, caps)} />);
        expect(html).toContain('role="status"');
      }
      expect(page(locale, <StatusBanner banner={bannerFor({ status: "sent", ...base }, [signer({ status: "sent", full_name: "A" }), signer({ id: "s3", status: "sent", full_name: "B" }), signer({ id: "s4", status: "sent", full_name: "C" })], caps)} />)).toContain("A");

      const d = doc();
      const header = page(
        locale,
        <DetailHeader
          document={d}
          links={{ category: "Merchant agreements", contact: { id: "c1", label: "Ali" }, ticket: { id: "t1", number: 4, subject: "KYC" }, deal: { id: "p1", title: "Kedai" } }}
          actions={documentActions({ ...d, status: "completed", final_path: "z" }, caps)}
          downloading={null}
          onView={() => {}}
          onDownload={() => {}}
          onVoid={() => {}}
        />,
      );
      expect(header).toContain("Merchant Agreement");
      expect(header).toContain("/contacts?contact=c1");

      const people = page(locale, <PeopleList document={d} signers={signers} undelivered={new Set(["s2"])} caps={caps} onChanged={async () => {}} />);
      expect(people).toContain("Ali bin Ahmad");
      expect(people).toContain("Gokula");

      expect(page(locale, <FilesList files={[{ id: "f1", kind: "source", name: "Merchant Agreement.docx", mime: null, size_bytes: 123456, sha256: null, created_at: "2026-10-06T09:04:00Z" }]} />)).toContain("Merchant Agreement.docx");

      const types = ["created", "sent", "invited", "resent", "reminded", "recipient_changed", "viewed", "code_sent", "code_verified", "code_failed", "consented", "saved", "signed", "submitted", "declined", "all_signed", "seal_attempt_failed", "sealed", "completed", "voided", "expired", "seal_failed", "downloaded", "delivery_failed", "no_such_type"];
      const events = types.map((type, i) => ({
        id: `e${i}`,
        doc_seq: i + 1,
        signer_id: i % 2 ? "s1" : "s2",
        type,
        actor_type: "signer" as const,
        actor_user_id: i === 1 ? "u1" : null,
        detail: type === "recipient_changed" ? { from_email: "a@x.com", to_email: "b@x.com" } : type === "delivery_failed" ? { channel: "whatsapp", reason: "no such number" } : { reason: "Fee is wrong", version: "v1", error: "x" },
        ip: "203.0.113.5",
        device: "Android Chrome",
        created_at: "2026-10-06T09:00:00Z",
      }));
      for (const chain of [{ state: "intact" as const, events: 25 }, { state: "broken" as const, at: 3 }, { state: "broken" as const, at: null }, { state: "unknown" as const }, null]) {
        const html = page(locale, <HistoryView events={events} chain={chain} loading={false} failed={false} signers={signers} signInOrder technical />);
        expect(html).toContain("<details");
      }
      expect(page(locale, <HistoryView events={null} chain={null} loading failed={false} signers={signers} signInOrder={false} technical={false} />)).toContain('role="status"');
      expect(page(locale, <HistoryView events={[]} chain={null} loading={false} failed={false} signers={signers} signInOrder={false} technical={false} />)).toContain("<h2");
    });

    it(`marks a private document in the header with the lock, and an ordinary one without (${locale})`, () => {
      const header = (d: SignDocumentRow) =>
        page(locale, <DetailHeader document={d} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions(d, caps)} downloading={null} onView={() => {}} onDownload={() => {}} onVoid={() => {}} />);
      const secret = header(doc({ is_private: true }));
      expect(secret).toContain("data-private-badge");
      expect(secret).toContain("lucide-lock");
      expect(header(doc({ is_private: false }))).not.toContain("data-private-badge");
      expect(header(doc())).not.toContain("data-private-badge");
    });

    it(`contact tab shows its loading state (${locale})`, () => {
      expect(page(locale, <ContactDocuments contactId="c1" />)).toContain("/sign/new?contactId=c1");
    });
  }
});
