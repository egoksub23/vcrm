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

// Migration 178: a document whose certificate is a file of its own offers the signed document, the certificate and everything in one zip; one sealed before
// it keeps the single button it always had (its certificate is inside the signed PDF).
const OWN_CERTIFICATE_WORDS: Record<string, { signed: string; sealed: string; certificate: string; all: string; old: string }> = {
  en: { signed: "Signed document", sealed: "Sealed record", certificate: "Certificate", all: "Download all (zip)", old: "Download signed PDF" },
  ms: { signed: "Dokumen bertandatangan", sealed: "Rekod termeterai", certificate: "Sijil", all: "Muat turun semua (zip)", old: "" },
  zh: { signed: "已签署文件", sealed: "封存记录", certificate: "证书", all: "全部下载 (zip)", old: "" },
  ko: { signed: "서명된 문서", sealed: "봉인된 기록", certificate: "증명서", all: "모두 다운로드 (zip)", old: "" },
};

describe("the download buttons of a document with a certificate of its own", () => {
  const completed = (over: Partial<SignDocumentRow> = {}) => doc({ status: "completed", final_path: "z/final.pdf", completed_at: "2026-10-06T10:00:00Z", ...over });
  const header = (locale: string, d: SignDocumentRow, downloading: "final" | "original" | "certificate" | "zip" | null = null) =>
    page(locale, <DetailHeader document={d} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions(d, { void: false })} downloading={downloading} onView={() => {}} onDownload={() => {}} onVoid={() => {}} />);
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

  for (const locale of LOCALES) {
    it(`offers the signed document, the certificate and everything in one zip, as three separate buttons (${locale})`, () => {
      const words = OWN_CERTIFICATE_WORDS[locale];
      const own = buttons(header(locale, completed({ certificate_path: "z/certificate.pdf" })));
      expect(own).toEqual(expect.arrayContaining([words.signed, words.certificate, words.all]));
      expect(own.indexOf(words.signed)).toBeLessThan(own.indexOf(words.certificate));
      expect(own.indexOf(words.certificate)).toBeLessThan(own.indexOf(words.all));
      // no raw key, and the old single label is gone
      expect(header(locale, completed({ certificate_path: "z/certificate.pdf" }))).not.toMatch(/actions\.|Sign\.detail/);
      if (words.old) expect(own).not.toContain(words.old);
    });

    it(`says "record" for a form without a signature (${locale})`, () => {
      const words = OWN_CERTIFICATE_WORDS[locale];
      const own = buttons(header(locale, completed({ certificate_path: "z/certificate.pdf", mode: "form" })));
      expect(own).toEqual(expect.arrayContaining([words.sealed, words.certificate, words.all]));
      expect(own).not.toContain(words.signed);
    });

    it(`keeps the one button a document sealed earlier had, with no certificate or zip (${locale})`, () => {
      const words = OWN_CERTIFICATE_WORDS[locale];
      for (const d of [completed(), completed({ certificate_path: null })]) {
        const old = buttons(header(locale, d));
        expect(old).not.toContain(words.certificate);
        expect(old).not.toContain(words.all);
        expect(old).not.toContain(words.signed);
        expect(old.some((b) => /signed|bertandatangan|已签署|서명/i.test(b)), locale).toBe(true);
      }
    });
  }

  it("offers neither before the document is completed, whatever the row says", () => {
    expect(buttons(header("en", doc({ status: "sealing", final_path: null, certificate_path: "z/certificate.pdf" })))).not.toContain("Certificate");
  });

  it("shows a spinner on the button that is working, and disables the others", () => {
    const html = header("en", completed({ certificate_path: "z/certificate.pdf" }), "zip");
    expect(html).toContain("animate-spin");
    expect([...html.matchAll(/<button[^>]*disabled[^>]*>/g)].length).toBeGreaterThanOrEqual(3);
  });
});

describe("the note under the viewer", () => {
  const note = (locale: string, key: string) => ((wording(locale)?.viewer ?? {}) as Record<string, string>)[key];

  it("says the certificate is a separate file for a document that has one of its own, and still says 'certificate pages' only for one sealed earlier", () => {
    for (const locale of LOCALES) {
      for (const key of ["noteSignedOwn", "noteRecordOwn", "noteSigned", "noteRecord"]) expect(note(locale, key), `${locale}.${key}`).toBeTruthy();
      expect(note(locale, "noteSignedOwn")).not.toBe(note(locale, "noteSigned"));
      if (locale !== "en") expect(note(locale, "noteSignedOwn")).not.toBe(note("en", "noteSignedOwn"));
    }
    expect(note("en", "noteSignedOwn")).toBe("The signed copy, with every answer. Its certificate is a separate file.");
    expect(note("en", "noteRecordOwn")).toBe("The sealed submission record: the answers and the people who submitted. Its certificate is a separate file.");
    expect(note("en", "noteSignedOwn")).not.toMatch(/certificate pages/i);
    expect(note("en", "noteSigned")).toContain("certificate pages");
  });
});
