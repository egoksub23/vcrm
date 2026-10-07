import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The document collection screens in every language with the real wording (next-intl throws on a missing key): the New document page with
// "Single document / Document collection" as its first choice, the collection builder with its multi-file chooser, and the documents of a draft
// collection with Add, Remove and the order. The words come from the merged message files.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-sign-categories", () => ({ useSignCategories: () => ({ live: [] }) }));
vi.mock("@/hooks/use-sign-templates", () => ({
  useActiveTemplates: () => ({
    loading: false,
    error: false,
    templates: [
      { id: "t1", name: "Merchant Agreement", description: null, category_id: null, pages: 3, roles: 2, mode: "sign" },
      { id: "t2", name: "Fee Schedule", description: "Rates", category_id: null, pages: 1, roles: 1, mode: "sign" },
    ],
  }),
}));
// the pickers read the workspace's contacts, tickets and deals; here they only show what they were given
vi.mock("../send/contact-picker", () => ({ ContactPicker: (p: { contactId: string | null }) => <span data-picker="contact" data-value={p.contactId ?? ""} /> }));
vi.mock("../send/record-picker", () => ({ RecordPicker: (p: { kind: string; value: string | null }) => <span data-picker={p.kind} data-value={p.value ?? ""} /> }));

import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { NewDocument } from "../send/new-document";
import { EnvelopeDocuments } from "./envelope-documents";
import { NewEnvelope } from "./new-envelope";

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const wording = (locale: string): Tree => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale) }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const WORDS: Record<(typeof LOCALES)[number], { single: string; collection: string; heading: string; drop: string; choose: string; add: string; created: string; count3: string }> = {
  en: { single: "Single document", collection: "Document collection", heading: "What are you sending?", drop: "Drop files here, or", choose: "choose files", add: "Add a document", created: "Create the collection", count3: "3 of 6 documents" },
  ms: { single: "Dokumen tunggal", collection: "Koleksi dokumen", heading: "Apa yang anda hantar?", drop: "Letakkan fail di sini, atau", choose: "pilih fail", add: "Tambah dokumen", created: "Cipta koleksi", count3: "3 daripada 6 dokumen" },
  zh: { single: "单个文件", collection: "文件集", heading: "您要发送什么？", drop: "将文件拖到此处，或", choose: "选择文件", add: "添加文件", created: "创建文件集", count3: "3/6 份文件" },
  ko: { single: "단일 문서", collection: "문서 모음", heading: "무엇을 보내시나요?", drop: "여기에 파일을 놓거나", choose: "파일 선택", add: "문서 추가", created: "문서 모음 만들기", count3: "문서 3/6개" },
};

/** The attribute (not the `disabled:` classes). */
const DISABLED = /\sdisabled(=|>|\s)/;

/** The opening tag of the button whose content holds `text`. */
function openingTagOfButtonWith(html: string, text: string): string {
  const at = html.indexOf(text);
  expect(at, `"${text}" on the page`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  expect(open, `a button around "${text}"`).toBeGreaterThan(-1);
  expect(html.slice(open, at)).not.toContain("</button>");
  return html.slice(open, html.indexOf(">", open) + 1);
}

const ID = { contact: "11111111-1111-4111-8111-111111111111", ticket: "22222222-2222-4222-8222-222222222222", deal: "33333333-3333-4333-8333-333333333333" };

describe("the New document page: single document or document collection first", () => {
  for (const locale of LOCALES) {
    const w = WORDS[locale];

    it(`puts the choice before everything else, with the two options named (${locale})`, () => {
      const html = page(locale, <NewDocument />);
      expect(html).toContain(w.heading);
      expect(html).toContain(w.single);
      expect(html).toContain(w.collection);
      // the choice comes before "how do you want to start" and the details of a single document
      const choice = html.indexOf(w.heading);
      const start = html.indexOf(wording(locale) && ((wording(locale).send as Tree).new as Tree).startHeading as string);
      expect(choice).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(choice);
      // two radio options, single chosen
      expect(html.match(/name="kind"/g)).toHaveLength(2);
      expect(html).toMatch(/name="kind"[^>]*checked/);
      expect(html).not.toContain(w.created);
    });

    it(`opens with the collection chosen, builds it in place and keeps the contact, ticket and deal (${locale})`, () => {
      const html = page(locale, <NewDocument kind="collection" contactId={ID.contact} ticketId={ID.ticket} dealId={ID.deal} />);
      expect(html).toContain(w.created);
      expect(html).toContain(w.drop);
      // the single document's own sections are not shown
      expect(html).not.toContain(((wording(locale).send as Tree).new as Tree).startHeading as string);
      // the selections are carried into the collection's pickers
      expect(html).toContain(`data-picker="contact" data-value="${ID.contact}"`);
      expect(html).toContain(`data-picker="ticket" data-value="${ID.ticket}"`);
      expect(html).toContain(`data-picker="deal" data-value="${ID.deal}"`);
      // the old small link is gone
      expect(html).not.toContain("/sign/new/envelope");
    });
  }

  it("keeps every single-document control as it was", () => {
    const html = page("en", <NewDocument contactId={ID.contact} templateId={null} />);
    expect(html).toContain("Upload a file");
    expect(html).toContain("Use a template");
    expect(html).toContain("Create draft");
    expect(html).toContain(`data-picker="contact" data-value="${ID.contact}"`);
  });
});

describe("the collection builder", () => {
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`offers a chooser for several files at once, the templates, and one list (${locale})`, () => {
      const html = page(locale, <NewEnvelope contactId={ID.contact} />);
      expect(html).toContain(w.drop);
      expect(html).toContain(w.choose);
      // a multi-file input that takes PDF, Word and images
      expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple|<input[^>]*multiple[^>]*type="file"/);
      expect(html).toContain(".pdf,.docx,.doc,.png,.jpg,.jpeg");
      // the templates of the workspace are ticked from the same page
      expect(html).toContain("Merchant Agreement");
      expect(html).toContain("Fee Schedule");
      expect(html).toContain(w.created);
      // nothing is added yet, so there is nothing to create
      expect(openingTagOfButtonWith(html, w.created)).toMatch(DISABLED);
      expect(html).toContain(`data-picker="contact" data-value="${ID.contact}"`);
    });
  }

  it("says collection, not envelope", () => {
    for (const locale of ["en", "ms"] as const) {
      const html = page(locale, <NewEnvelope />);
      expect(html.toLowerCase()).not.toContain("envelope");
      expect(html.toLowerCase()).not.toContain("sampul");
    }
  });
});

const doc = (n: number, over: Partial<EnvelopeData["documents"][number]> = {}): EnvelopeData["documents"][number] => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  position: n,
  title: `Document ${n}`,
  reference: `SGN-2026-00000${n}`,
  status: "draft",
  mode: "sign",
  pageCount: n,
  roles: [],
  rolesNeeded: [],
  categoryId: null,
  completedAt: null,
  hasFinalFile: false,
  ...over,
});

describe("the documents of a draft collection", () => {
  const three = [doc(1), doc(2), doc(3)];
  const props = { envelopeId: "e1", problemCount: (id: string) => (id === three[1].id ? 2 : 0), beforeChange: async () => true, onChanged: async () => {} };

  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`can add, remove and reorder, and shows the room that is left (${locale})`, () => {
      const html = page(locale, <EnvelopeDocuments {...props} documents={three} canEdit />);
      expect(html).toContain(w.add);
      expect(html).toContain(w.count3);
      // the order, and a way to take each one out
      for (const d of three) expect(html).toContain(d.title);
      expect(html.match(/class="lucide lucide-trash/g)).toHaveLength(3);
      expect(html.match(/class="lucide lucide-arrow-up/g)).toHaveLength(3);
      expect(html.match(/draggable="true"/g)).toHaveLength(3);
    });
  }

  it("takes nothing out below two documents, and nothing is added at six", () => {
    const two = page("en", <EnvelopeDocuments {...props} documents={[doc(1), doc(2)]} canEdit />);
    expect(two).toContain("A collection keeps at least 2");
    expect(two.match(/aria-label="Remove Document \d"[^>]*disabled|disabled[^>]*aria-label="Remove Document \d"/g)).toHaveLength(2);
    const six = page("en", <EnvelopeDocuments {...props} documents={[1, 2, 3, 4, 5, 6].map((n) => doc(n))} canEdit />);
    expect(six).toContain("A collection holds up to 6 documents, so no more can be added.");
    expect(openingTagOfButtonWith(six, "Add a document")).toMatch(DISABLED);
    expect(openingTagOfButtonWith(page("en", <EnvelopeDocuments {...props} documents={three} canEdit />), "Add a document")).not.toMatch(DISABLED);
  });

  it("shows no controls to someone who cannot send", () => {
    const html = page("en", <EnvelopeDocuments {...props} documents={three} canEdit={false} />);
    expect(html).not.toContain("Add a document");
    expect(html).not.toContain("Remove Document 1");
    expect(html).not.toContain('draggable="true"');
    expect(html).toContain("Document 2");
  });
});
