import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for cancelling a completed document (migration 181), in every language with the real wording from messages/<locale>.json. next-intl is told
// to throw on a missing key or argument instead of printing a raw key path. What is checked: the Cancelled chip (a muted red that follows the theme, never a
// Tailwind dark: variant), the row menu (only for the person who made the document and for admins, only on a completed row that is not cancelled), the
// dialog (title, the warning for a collection, a required reason with a counter, "Notify everyone" off and who it reaches), the banner, the filter help, the
// history, the signer's screens and the public verify page. Effects do not run under renderToStaticMarkup, so this is the first paint.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({ members: [], nameOf: (id: string | null | undefined) => (id === "u1" ? "Gokula" : ""), profileOf: () => undefined }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { Dialog } from "@/components/ui/dialog";
import type { SignListRow } from "@/hooks/use-sign-documents";
import { STATUS_GROUPS } from "@/lib/sign/client/list-filters";
import type { SigningView } from "@/lib/sign/service/signing";
import type { VerifyView } from "@/lib/sign/service/verify";
import type { SignDocumentRow } from "@/lib/sign/types";

import { CancelBody, audienceOf } from "./detail/cancel-dialog";
import { CancelledBanner } from "./detail/cancelled-banner";
import { DetailHeader } from "./detail/detail-header";
import { describeEvent } from "./detail/events";
import { documentActions } from "./detail/logic";
import { DocumentCards, DocumentTable } from "./list/document-rows";
import { GroupHelp } from "./list/group-help";
import { RowActions, cancelTargetOf } from "./list/row-actions";
import { DocumentStatusBadge } from "./send/status-badge";
import { EnvelopeEnd } from "./signer/envelope-bar";
import { EndScreen } from "./signer/end-screens";
import { loadSignerMessages } from "./signer/load-messages";
import type { SignerMessages } from "./signer/use-language";
import { VerifyRoot } from "./verify/verify-root";

const TOKEN = "t".repeat(40);
const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;

const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const translatorFor = (locale: Locale, namespace: string) =>
  createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

/** The word for "Cancelled" in each language, as the messages have it. */
const CANCELLED: Record<Locale, string> = { en: "Cancelled", ms: "Dibatalkan", zh: "已取消", ko: "취소됨" };
const COMPLETED: Record<Locale, string> = { en: "Completed", ms: "Selesai", zh: "已完成", ko: "완료됨" };

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const inDialog = (node: React.ReactNode) => (
  <Dialog open onOpenChange={() => undefined}>
    {node}
  </Dialog>
);

const row = (over: Partial<SignListRow> = {}): SignListRow => ({
  id: "d1",
  reference: "SGN-2026-000123",
  title: "Merchant Agreement",
  status: "completed",
  mode: "sign",
  category_id: null,
  contact_id: null,
  sign_in_order: false,
  sent_at: "2026-10-01T08:00:00Z",
  expires_at: null,
  completed_at: "2026-10-02T09:00:00Z",
  cancelled_at: null,
  created_by: "maker",
  created_at: "2026-10-01T08:00:00Z",
  updated_at: "2026-10-02T09:00:00Z",
  contacts: null,
  sign_signers: [{ id: "s1", full_name: "Ali", status: "signed", order_no: 1, kind: "signer" }],
  ...over,
});
const CANCELLED_ROW = row({ id: "d2", title: "Lease", status: "completed", cancelled_at: "2026-10-08T02:00:00Z" });

describe("the Cancelled chip", () => {
  for (const locale of LOCALES) {
    it(`${locale}: reads Cancelled instead of Completed for a completed document that was cancelled, in a colour pair that follows the theme`, () => {
      const cancelled = page(locale, <DocumentStatusBadge status="completed" cancelled />);
      expect(cancelled).toContain(CANCELLED[locale]);
      expect(cancelled).not.toContain(COMPLETED[locale]);
      expect(cancelled).toContain("light-dark(");
      expect(cancelled).not.toMatch(/\bdark:/);
      const completed = page(locale, <DocumentStatusBadge status="completed" />);
      expect(completed).toContain(COMPLETED[locale]);
      expect(completed).not.toContain(CANCELLED[locale]);
      // a cancelled flag on any other status changes nothing
      expect(page(locale, <DocumentStatusBadge status="sent" cancelled />)).not.toContain(CANCELLED[locale]);
    });
  }
});

describe("the list's rows", () => {
  const rows = [row(), CANCELLED_ROW, row({ id: "d3", title: "Draft one", status: "draft", completed_at: null })];
  const props = { categories: [], now: Date.parse("2026-10-09T00:00:00Z") };

  for (const locale of LOCALES) {
    it(`${locale}: shows the Cancelled chip and the cancel date on a cancelled row, the Completed chip on the others, in the table and in the cards`, () => {
      for (const html of [page(locale, <DocumentTable rows={rows} {...props} />), page(locale, <DocumentCards rows={rows} {...props} />)]) {
        expect(html).toContain("Lease");
        // the cancelled row has its chip; the completed row keeps Completed
        expect(html).toContain(CANCELLED[locale]);
        expect(html).toContain(COMPLETED[locale]);
        expect(html).toMatch(/2026/);
        expect(errors).toEqual([]);
      }
      // the cancelled row's date line says when it was cancelled, not when it was completed
      const table = page(locale, <DocumentTable rows={[CANCELLED_ROW]} {...props} />);
      const cancelledOn = (CATALOGUES[locale] as { Sign: { send: { list: { cancelledOn: string } } } }).Sign.send.list.cancelledOn.replace("{date}", "");
      expect(table).toContain(cancelledOn.trim());
      const completedOn = (CATALOGUES[locale] as { Sign: { send: { list: { completedOn: string } } } }).Sign.send.list.completedOn.replace("{date}", "").trim();
      expect(table).not.toContain(completedOn);
    });

    it(`${locale}: has a menu on a completed row for the person who made it or an admin, and on no other row`, () => {
      const label = (title: string) => (CATALOGUES[locale] as { Sign: { send: { list: { rowActions: string } } } }).Sign.send.list.rowActions.replace("{title}", title);
      const maker = { userId: "maker", isAdmin: false };
      const html = page(locale, <DocumentTable rows={rows} {...props} viewer={maker} onChanged={() => undefined} />);
      // the completed row of the maker: yes. The cancelled row (made by the same person) and the draft: no
      expect(html).toContain(`aria-label="${label("Merchant Agreement")}"`);
      expect(html).not.toContain(`aria-label="${label("Lease")}"`);
      expect(html).not.toContain(`aria-label="${label("Draft one")}"`);
      // an admin sees it on a row somebody else made; another agent does not
      const theirs = [row({ created_by: "someone else" })];
      expect(page(locale, <DocumentTable rows={theirs} {...props} viewer={{ userId: "x", isAdmin: true }} onChanged={() => undefined} />)).toContain(`aria-label="${label("Merchant Agreement")}"`);
      expect(page(locale, <DocumentTable rows={theirs} {...props} viewer={{ userId: "x", isAdmin: false }} onChanged={() => undefined} />)).not.toContain("aria-label=\"" + label("Merchant Agreement"));
      // without a viewer (a screen that does not offer it) there is no menu and no extra column
      expect(page(locale, <DocumentTable rows={rows} {...props} />)).not.toContain(label("Merchant Agreement"));
      expect(page(locale, <DocumentCards rows={rows} {...props} viewer={maker} onChanged={() => undefined} />)).toContain(label("Merchant Agreement"));
    });
  }

  it("is a menu of its own: nothing is rendered for a row that cannot be cancelled", () => {
    expect(page("en", <RowActions row={CANCELLED_ROW} viewer={{ userId: "maker", isAdmin: true }} onChanged={() => undefined} />)).toBe("");
    expect(page("en", <RowActions row={row({ status: "sent" })} viewer={{ userId: "maker", isAdmin: true }} onChanged={() => undefined} />)).toBe("");
    expect(page("en", <RowActions row={row()} viewer={{ userId: "stranger", isAdmin: false }} onChanged={() => undefined} />)).toBe("");
  });

  it("cancels the document for a document row and the whole collection for a collection row, with how many documents go", () => {
    expect(cancelTargetOf(row())).toEqual({ kind: "document", id: "d1" });
    expect(cancelTargetOf(row({ id: "e1", kind: "envelope", envelope_documents: [{ id: "a", title: "A", status: "completed", position: 1 }, { id: "b", title: "B", status: "completed", position: 2 }] }))).toEqual({ kind: "collection", id: "e1", documents: 2 });
  });

  it("has a Cancelled filter and a sentence for Completed, Cancelled and All in every language, saying Completed leaves the cancelled ones out", () => {
    expect(STATUS_GROUPS).toContain("cancelled");
    for (const locale of LOCALES) {
      const list = (CATALOGUES[locale] as { Sign: { send: { list: { group: Record<string, string>; groupHelp: Record<string, string> } } } }).Sign.send.list;
      expect(list.group.cancelled, locale).toBe(CANCELLED[locale]);
      for (const g of STATUS_GROUPS) expect(list.group[g], `${locale} ${g}`).toEqual(expect.any(String));
      // the Completed sentence points at Cancelled by its name
      expect(list.groupHelp.completed, locale).toContain(CANCELLED[locale]);
      expect(page(locale, <GroupHelp group="completed" />)).toContain(list.groupHelp.completed);
      expect(page(locale, <GroupHelp group="cancelled" />)).toContain(list.groupHelp.cancelled);
      expect(page(locale, <GroupHelp group="all" />)).toContain(list.groupHelp.all);
      for (const g of ["draft", "waiting", "stopped", "test"] as const) expect(page(locale, <GroupHelp group={g} />)).toBe("");
    }
  });
});

describe("the confirmation dialog", () => {
  const noop = () => undefined;
  const body = (locale: Locale, props: Partial<React.ComponentProps<typeof CancelBody>> = {}) =>
    page(locale, inDialog(<CancelBody target={{ kind: "document", id: "d1" }} title="Merchant Agreement" audience={{ signers: 2, copies: 1 }} onClose={noop} onCancelled={noop} busy={false} setBusy={noop} {...props} />));

  for (const locale of LOCALES) {
    const detail = (CATALOGUES[locale] as { Sign: { detail: { cancel: Record<string, string> } } }).Sign.detail.cancel;

    it(`${locale}: asks Cancel this document? and says the signed copy stays as a record and the document cannot be reactivated`, () => {
      const html = body(locale);
      expect(html).toContain(detail.title);
      expect(html).toContain(detail.body);
      expect(html).toContain("Merchant Agreement");
      expect(html).not.toContain(detail.collectionWarning.slice(0, 6) + "x");
      // a required reason, with a real label, a limit of 500 and a counter
      expect(html).toContain('id="sign-cancel-reason"');
      expect(html).toContain('maxLength="500"');
      expect(html).toMatch(/for="sign-cancel-reason"/);
      expect(html).toContain("0 / 500");
      expect(html).toContain(detail.reasonHint);
      // Notify everyone is a tick box, off, with who it reaches
      expect(html).toContain(detail.notify);
      expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"/);
      expect(html).toContain('aria-describedby="sign-cancel-notify-who"');
      // the destructive action and the way out
      expect(html).toContain(detail.keep);
      expect(html).toContain(detail.action);
      expect(html).toMatch(/type="submit"/);
      expect(errors).toEqual([]);
    });

    it(`${locale}: for a collection says it cancels all the documents in it, with their number, and uses the collection's wording`, () => {
      const html = body(locale, { target: { kind: "collection", id: "e1", documents: 3 }, title: "Merchant onboarding" });
      const translator = translatorFor(locale, "Sign.detail");
      expect(html).toContain(translator("cancel.collectionWarning", { count: 3 }).replace(/&/g, "&amp;"));
      expect(html).toContain(detail.bodyCollection);
      expect(html).toContain('role="note"');
      expect(html).toMatch(/3/);
    });

    it(`${locale}: counts who would be emailed, and says it plainly while the counts are not known`, () => {
      const translator = translatorFor(locale, "Sign.detail");
      expect(body(locale)).toContain(translator("cancel.notifyWho", { signers: 2, copies: 1 }));
      expect(body(locale, { audience: undefined })).toContain(detail.notifyWhoPlain);
      expect(body(locale)).toContain(detail.notifyNote);
    });
  }

  it("counts the people the notice reaches: a person of a collection once, never a person handed only a part", () => {
    expect(audienceOf({ signers: [{ id: "a1", party_id: "a1" }, { id: "a2", party_id: "a1" }, { id: "b1", party_id: "b1" }, { id: "c1", party_id: "b1", part_keys: ["bank"] }], copies: [{}, {}] })).toEqual({ signers: 2, copies: 2 });
    expect(audienceOf({})).toEqual({ signers: 0, copies: 0 });
  });
});

describe("the banner", () => {
  for (const locale of LOCALES) {
    const detail = (CATALOGUES[locale] as { Sign: { detail: { cancelledBanner: Record<string, string> } } }).Sign.detail.cancelledBanner;
    it(`${locale}: says who cancelled it, when and why, and that the signed copy is kept as a record that is no longer in force`, () => {
      const html = page(locale, <CancelledBanner at="2026-10-08T02:00:00Z" by="Gokula" reason="Wrong price list" />);
      expect(html).toContain(detail.title);
      expect(html).toContain("Gokula");
      expect(html).toContain("Wrong price list");
      expect(html).toContain(detail.note);
      expect(html).toContain('role="status"');
      expect(html).toContain("light-dark(");
      expect(html).not.toMatch(/\bdark:/);
      // without a name (the person left) or a reason it still reads
      const bare = page(locale, <CancelledBanner at="2026-10-08T02:00:00Z" by={null} reason={null} />);
      expect(bare).toContain(detail.title);
      expect(bare).not.toContain("Gokula");
      expect(bare).not.toContain("undefined");
    });

    it(`${locale}: for a collection says so, and a document that was cancelled with its collection links to it`, () => {
      expect(page(locale, <CancelledBanner isCollection at="2026-10-08T02:00:00Z" by="Gokula" reason="Wrong price list" />)).toContain(detail.titleCollection);
      const withLink = page(locale, <CancelledBanner at="2026-10-08T02:00:00Z" by="Gokula" reason="Wrong price list" collection={{ id: "e1", reference: "COL-2026-000004", title: "Merchant onboarding" }} />);
      expect(withLink).toContain('href="/sign/envelopes/e1"');
      expect(withLink).toContain("Merchant onboarding");
      expect(withLink).toContain(detail.withCollection);
    });
  }
});

describe("a document's page", () => {
  const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
    ({ id: "d1", account_id: "a1", reference: "SGN-2026-000123", title: "Merchant Agreement", status: "completed", mode: "sign", created_by: "u1", created_at: "2026-10-01T08:00:00Z", sent_at: "2026-10-01T08:00:00Z", completed_at: "2026-10-02T09:00:00Z", expires_at: null, final_path: "a/final.pdf", certificate_path: "a/certificate.pdf", original_path: null, base_path: "a/base.pdf", sign_in_order: false, code_required: false, is_private: false, test: false, ...over }) as SignDocumentRow;
  const links = { category: null, contact: null, ticket: null, deal: null };
  const header = (locale: Locale, d: SignDocumentRow, viewer: { userId: string; isAdmin: boolean }) =>
    page(locale, <DetailHeader document={d} links={links} actions={documentActions(d, { void: false }, viewer)} downloading={null} onView={() => undefined} onDownload={() => undefined} onVoid={() => undefined} onCancel={() => undefined} />);

  for (const locale of LOCALES) {
    it(`${locale}: shows Cancel document to the person who made it, hides it from others and once it is cancelled, and keeps the downloads`, () => {
      const detail = (CATALOGUES[locale] as { Sign: { detail: { cancel: Record<string, string>; meta: Record<string, string> } } }).Sign.detail;
      const open = header(locale, doc(), { userId: "u1", isAdmin: false });
      expect(open).toContain(detail.cancel.action);
      expect(open).toContain(COMPLETED[locale]);
      expect(header(locale, doc(), { userId: "u2", isAdmin: true })).toContain(detail.cancel.action);
      expect(header(locale, doc(), { userId: "u2", isAdmin: false })).not.toContain(detail.cancel.action);
      const gone = header(locale, doc({ cancelled_at: "2026-10-08T02:00:00Z", cancelled_by: "u1", cancel_reason: "Wrong price list" }), { userId: "u1", isAdmin: true });
      expect(gone).toContain(CANCELLED[locale]);
      expect(gone).not.toContain(COMPLETED[locale] + "</span>");
      expect(gone).not.toContain(detail.cancel.action);
      expect(gone).toContain(detail.meta.cancelled);
      // the downloads of the signed document and the certificate are still there, and nothing about the reason is in the header
      expect(gone).toContain("download");
      expect(gone).not.toContain("Wrong price list");
    });
  }

  it("never offers Cancel document on anything that is not completed", () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"] as const) {
      expect(documentActions(doc({ status }), { void: true }, { userId: "u1", isAdmin: true }).cancel, status).toBe(false);
    }
    expect(documentActions(doc(), { void: true }).cancel).toBe(false);
  });
});

describe("the history", () => {
  const ctx = { signers: [], signInOrder: false, userName: (id: string | null) => (id === "u1" ? "Gokula" : null), someone: "Someone", teammate: "A teammate" };
  const line = (type: string, detail: Record<string, unknown>) => describeEvent({ id: "e1", doc_seq: 9, signer_id: null, type, actor_type: type === "cancelled" ? "user" : "system", actor_user_id: "u1", detail, ip: null, device: null, created_at: "2026-10-08T02:00:00Z" }, ctx);

  it("words a cancellation with the reason the person gave, a collection's with its reference and size, and the notice with counts", () => {
    expect(line("cancelled", { reason: "Wrong price list" })).toMatchObject({ key: "events.cancelled", reason: "Wrong price list", values: { sender: "Gokula" } });
    expect(line("cancelled", { reason: "Wrong price list", envelope_id: "e1", reference: "COL-2026-000004", count: 3 })).toMatchObject({ key: "events.cancelledCollection", values: { reference: "COL-2026-000004", count: "3" } });
    expect(line("cancel_notice_sent", { sent: 4, failed: 0 })).toMatchObject({ key: "events.cancel_notice_sent", values: { sent: "4", failed: "0" } });
    expect(line("cancel_notice_sent", { sent: 3, failed: 1 }).key).toBe("events.cancel_notice_sentSome");
  });

  for (const locale of LOCALES) {
    it(`${locale}: has every sentence the history needs for a cancellation`, () => {
      const t = translatorFor(locale, "Sign.detail");
      for (const l of [line("cancelled", { reason: "x" }), line("cancelled", { reason: "x", envelope_id: "e1", reference: "COL-1", count: 3 }), line("cancel_notice_sent", { sent: 4, failed: 0 }), line("cancel_notice_sent", { sent: 3, failed: 1 })]) {
        const text = t(l.key, l.values);
        expect(text, `${locale} ${l.key}`).not.toContain(l.key);
        expect(text, `${locale} ${l.key}`).not.toMatch(/\{|\}/);
      }
      expect(t("events.cancelledCollection", { sender: "Gokula", reference: "COL-1", count: "3" })).toContain("3");
    });
  }
});

describe("the error words", () => {
  for (const locale of LOCALES) {
    it(`${locale}: has a sentence for every way cancelling can be refused`, () => {
      const t = translatorFor(locale, "Sign.detail");
      for (const code of ["cancel_not_allowed", "cancel_reason_invalid", "document_not_completed", "document_already_cancelled", "envelope_not_completed", "envelope_already_cancelled", "belongs_to_collection"]) {
        expect(t(`errors.${code}`), `${locale} ${code}`).not.toContain(code);
      }
    });
  }
});

describe("the signer's screens", () => {
  let messages: SignerMessages;
  const signerView = (document: Partial<SigningView["document"]> = {}): SigningView => ({
    state: "completed",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree.", version: "v1" },
    document: { title: "Merchant Agreement", reference: "SGN-1", pageCount: 2, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false, hasCertificate: true, ...document },
    workspace: { name: "Vircle", logoUrl: null },
    signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "signed" },
    content: null,
  });
  const signer = async (locale: Locale, node: React.ReactNode) => {
    messages ??= await loadSignerMessages({ verify: true });
    return renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC" onError={(e) => { throw e; }}>
        {node}
      </NextIntlClientProvider>,
    );
  };
  const words = (locale: Locale, key: "title" | "titleCollection" | "note" | "noteForm", date = "") => {
    const s = ((CATALOGUES[locale] as { Sign: { signer: { end: { cancelled: Record<string, string> } } } }).Sign.signer.end.cancelled)[key];
    return date ? s.replace("{date}", date) : s;
  };

  for (const locale of LOCALES) {
    it(`${locale}: a calm notice with the date on the completed screen, the downloads still there, and never the reason or who`, async () => {
      const html = await signer(locale, <EndScreen state="completed" view={signerView({ cancelledAt: "2026-10-08T02:00:00Z" })} token={TOKEN} canDownload />);
      expect(html).toContain('role="note"');
      expect(html).toContain(words(locale, "note"));
      expect(html).toMatch(/2026/);
      // the signed copy, the certificate and everything in one zip are all still offered
      expect(html.match(/<a [^>]*href=/g)?.length).toBeGreaterThanOrEqual(4);
      expect(html).not.toMatch(/reason|Wrong price/i);
      // not cancelled: no notice
      const plain = await signer(locale, <EndScreen state="completed" view={signerView()} token={TOKEN} canDownload />);
      expect(plain).not.toContain('role="note"');
      expect(plain).not.toContain(words(locale, "note"));
    });

    it(`${locale}: says the same for a form's record, and for a collection of documents`, async () => {
      const form = await signer(locale, <EndScreen state="completed" view={signerView({ cancelledAt: "2026-10-08T02:00:00Z", mode: "form" })} token={TOKEN} canDownload />);
      expect(form).toContain(words(locale, "noteForm"));
      const envelope = {
        title: "Merchant onboarding",
        reference: "COL-1",
        count: 2,
        current: "d1",
        state: "completed" as const,
        documents: [1, 2].map((n) => ({ id: `d${n}`, position: n, title: `Document ${n}`, reference: `SGN-${n}`, pageCount: 1, mode: "sign" as const, state: "completed" as const })),
        cancelledAt: "2026-10-08T02:00:00Z",
      };
      const html = await signer(locale, <EnvelopeEnd envelope={envelope} scope={TOKEN} name="Ali" canDownload />);
      expect(html).toContain('role="note"');
      expect(html).toContain(words(locale, "note"));
      expect(html).toContain("Document 1");
      expect(await signer(locale, <EnvelopeEnd envelope={{ ...envelope, cancelledAt: undefined }} scope={TOKEN} name="Ali" canDownload />)).not.toContain('role="note"');
    });
  }
});

describe("the verify page", () => {
  let messages: SignerMessages;
  const view = (over: Partial<VerifyView> = {}): VerifyView => ({
    title: "Merchant Application: Kedai Runcit",
    reference: "MA-0001",
    pageCount: 4,
    completedAt: "2026-10-06T08:30:00Z",
    workspace: { name: "Kedai Runcit Ali", logoUrl: null },
    signers: [{ name: "Ali bin Ahmad", signedAt: "2026-10-06T08:20:00Z" }],
    sha256: "ab".repeat(32),
    chain: "intact",
    events: 14,
    ...over,
  });
  const verify = async (locale: Locale, v: VerifyView) => {
    messages ??= await loadSignerMessages({ verify: true });
    return renderToStaticMarkup(<VerifyRoot view={v} initialLocale={locale} messages={messages} product="Halo" />);
  };

  for (const locale of LOCALES) {
    it(`${locale}: keeps what the page proves and adds Cancelled on <date>, without the reason or who`, async () => {
      const tr = (CATALOGUES[locale] as { Sign: { verify: { cancelled: Record<string, string>; signedTitle: string } } }).Sign.verify;
      const cancelled = await verify(locale, view({ cancelledAt: "2026-10-08T02:00:00Z" }));
      // the truth is unchanged: signed, who signed, the fingerprint, the record is intact, the copy can still be checked
      expect(cancelled).toContain(tr.signedTitle);
      expect(cancelled).toContain("Ali bin Ahmad");
      expect(cancelled).toContain("ab".repeat(32));
      expect(cancelled).toContain('type="file"');
      // and the notice
      expect(cancelled).toContain(tr.cancelled.body);
      expect(cancelled).toContain('aria-labelledby="verify-cancelled"');
      expect(cancelled).toMatch(/2026/);
      const notice = cancelled.slice(cancelled.indexOf('aria-labelledby="verify-cancelled"'));
      const section = notice.slice(0, notice.indexOf("</section>"));
      expect(section).toContain("light-dark(");
      expect(section).not.toMatch(/\bdark:/);
      // not cancelled: no notice at all
      const plain = await verify(locale, view());
      expect(plain).not.toContain("verify-cancelled");
      expect(plain).not.toContain(tr.cancelled.body);
    });
  }

  it("says a form's record was cancelled in the form's words", async () => {
    const html = await verify("en", view({ mode: "form", cancelledAt: "2026-10-08T02:00:00Z" }));
    expect(html).toContain("This record was cancelled after it was submitted.");
  });
});
