import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The people who receive a copy on the detail screen of a document on its own, and the two history sentences, in every language with the real
// wording (next-intl is told to throw on a missing key or argument). Effects do not run in a static render.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { SignCopyRecipientRow, SignDocumentRow } from "@/lib/sign/types";
import { CopyRecipients } from "./copy-recipients";
import { describeEvent, type DescribeContext, type SignEventRow } from "./events";
import { dataFingerprint, type DocumentDetailData } from "./use-document-detail";

type Tree = Record<string, unknown>;
function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: Tree & { detail?: Tree & { copies?: Tree } } }).Sign;
  return sign?.detail?.copies?.title ? (sign as Tree) : null;
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

const doc = (over: Partial<SignDocumentRow> = {}): SignDocumentRow =>
  ({ id: "d1", account_id: "a1", reference: "SGN-2026-000123", title: "Merchant Agreement", status: "in_progress", envelope_id: null, roles_snapshot: [], sign_in_order: false, ...over }) as unknown as SignDocumentRow;
const copy = (over: Partial<SignCopyRecipientRow> = {}): SignCopyRecipientRow => ({
  id: "c1",
  account_id: "a1",
  document_id: "d1",
  envelope_id: null,
  full_name: "Mei Lin",
  email: "mei@example.com",
  notified_at: null,
  created_by: "u1",
  created_at: "2026-10-05T08:00:00Z",
  ...over,
});
const copies = [copy(), copy({ id: "c2", full_name: "Raj Kumar", email: "raj@example.com", notified_at: "2026-10-06T08:30:00Z" })];
const render = (locale: string, props: Partial<React.ComponentProps<typeof CopyRecipients>> = {}) => page(locale, <CopyRecipients document={doc()} copies={copies} canSend onChanged={async () => {}} {...props} />);

describe.skipIf(LOCALES.length === 0)("people who receive a copy on a document's detail screen", () => {
  for (const locale of LOCALES) {
    it(`lists them with the label and when the copy was sent, or that it is not sent yet (${locale})`, () => {
      const html = render(locale);
      expect(html).toContain("data-copy-recipients");
      expect(html).toContain("Mei Lin");
      expect(html).toContain("raj@example.com");
      expect(html).toContain("mei@example.com");
      if (locale === "en") {
        expect(html).toContain("People who receive a copy");
        expect(html.match(/Receives a copy/g)).toHaveLength(2);
        expect(html).toContain("Not sent yet");
        expect(html).toMatch(/Copy sent [^<]*2026/);
      }
    });

    it(`while the document is open and the viewer can send, they can add one and remove each (${locale})`, () => {
      const html = render(locale);
      expect(html).toContain("<button");
      // one remove button per person, named for the person, and the add button
      expect(html.match(/aria-label="[^"]*Mei Lin[^"]*"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(html.match(/<button/g)).toHaveLength(3);
      for (const status of ["sent", "in_progress"] as const) expect(render(locale, { document: doc({ status }) }).match(/<button/g)).toHaveLength(3);
    });

    it(`they cannot be added or removed once the document is completed, declined, expired or cancelled, or by someone who cannot send (${locale})`, () => {
      for (const status of ["sealing", "completed", "declined", "expired", "voided", "failed", "draft"] as const) {
        expect(render(locale, { document: doc({ status }) }), status).not.toContain("<button");
      }
      expect(render(locale, { canSend: false })).not.toContain("<button");
      // still listed
      expect(render(locale, { document: doc({ status: "completed" }) })).toContain("Mei Lin");
    });

    it(`says no copy was sent for a document that ended without completing (${locale})`, () => {
      const ended = render(locale, { document: doc({ status: "voided" }), copies: [copy()] });
      const completed = render(locale, { document: doc({ status: "completed" }), copies: [copy()] });
      expect(ended).not.toBe(completed);
      if (locale === "en") {
        expect(ended).toContain("No copy was sent");
        expect(completed).toContain("Not sent yet");
      }
    });

    it(`shows nothing for a document of a collection, and nothing when there is nobody and nothing to add (${locale})`, () => {
      expect(render(locale, { document: doc({ envelope_id: "e1" }) })).toBe("");
      expect(render(locale, { copies: [], canSend: false })).toBe("");
      expect(render(locale, { copies: [], document: doc({ status: "completed" }) })).toBe("");
      // nobody yet, but the sender can add the first
      const first = render(locale, { copies: [] });
      expect(first).toContain("data-copy-recipients");
      expect(first.match(/<button/g)).toHaveLength(1);
    });

    it(`stops offering to add at ten (${locale})`, () => {
      const ten = Array.from({ length: 10 }, (_, i) => copy({ id: `c${i}`, full_name: `P${i}`, email: `p${i}@example.com` }));
      const html = render(locale, { copies: ten });
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?[^<]*<\/button>/);
      if (locale === "en") expect(html).toContain("Up to 10 people can receive a copy.");
    });
  }
});

// ---- the history sentences ----------------------------------------------------------------------

describe.skipIf(LOCALES.length === 0)("the history says who added or removed a person who receives a copy", () => {
  const ctx: DescribeContext = { signers: [], signInOrder: false, userName: (id) => (id === "u1" ? "Gokula" : null), someone: "Someone", teammate: "A teammate" };
  const row = (type: string): SignEventRow => ({ id: "e1", doc_seq: 5, signer_id: null, type, actor_type: "user", actor_user_id: "u1", detail: { name: "Mei Lin", email: "m***@example.com", reference: "SGN-2026-000123" }, ip: null, device: null, created_at: "2026-10-06T08:00:00Z" });

  for (const locale of LOCALES) {
    it(`words both events with the name and the masked address, never a raw key (${locale})`, () => {
      const t = createTranslator({ locale, messages: { Sign: { detail: (wording(locale) as { detail: Tree }).detail } }, namespace: "Sign.detail", onError: (e) => { throw e; } });
      const added = describeEvent(row("copy_recipient_added"), ctx);
      const removed = describeEvent(row("copy_recipient_removed"), ctx);
      expect(added.key).toBe("events.copy_recipient_added");
      expect(removed.key).toBe("events.copy_recipient_removed");
      const a = t(added.key as never, added.values as never);
      const r = t(removed.key as never, removed.values as never);
      for (const text of [a, r]) {
        expect(text).toContain("Gokula");
        expect(text).toContain("Mei Lin");
      }
      expect(a).toContain("m***@example.com");
      expect(r).not.toContain("example.com");
      if (locale === "en") {
        expect(a).toBe("Gokula added Mei Lin (m***@example.com) to receive a copy");
        expect(r).toBe("Gokula removed Mei Lin from the people who receive a copy");
      }
    });
  }
});

describe("the detail data", () => {
  const data = (c: SignCopyRecipientRow[] | undefined): DocumentDetailData => ({ document: { updated_at: "2026-10-06T08:00:00Z" } as SignDocumentRow, signers: [], files: [], copies: c });

  it("reads the history again when a person is added, removed or sent their copy", () => {
    const none = dataFingerprint(data(undefined));
    expect(dataFingerprint(data([]))).toBe(none);
    const one = dataFingerprint(data([copy()]));
    expect(one).not.toBe(none);
    expect(dataFingerprint(data([copy({ notified_at: "2026-10-07T01:00:00Z" })]))).not.toBe(one);
    expect(dataFingerprint(data([copy(), copy({ id: "c2" })]))).not.toBe(one);
  });
});
