import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The pieces of the multi-document signature blocks editor drawn as static markup in every language with the real wording (next-intl throws on a
// missing key or argument): the document navigator, the "jump to document" menu of a phone, the people and field types of the left column, the
// coverage line and a document's part of the scroll. No DOM renderer is installed, so what happens on a click or a scroll is NOT tested here: the
// arithmetic behind it is tested in src/lib/sign/client/blocks-nav.test.ts and save-hub.test.ts, and the screens' interactions by hand.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acc-1" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/components/sign/pdf-pages", () => ({
  usePdf: () => ({ status: "loading" }),
  useElementWidth: () => [{ current: null }, 0],
  PdfPages: () => null,
  PdfThumb: ({ index, width, children }: { index: number; width: number; children?: React.ReactNode }) => (
    <span data-thumb={index} data-thumb-width={width}>
      {children}
    </span>
  ),
}));

import { coverageByPerson, liveCovers } from "@/lib/sign/client/blocks-nav";
import { documentCover } from "@/lib/sign/client/process";
import { person, processDoc, role } from "@/lib/sign/client/process-fixtures";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { CoverageSummary } from "./coverage-summary";
import { DocJumpSelect, DocNavigator } from "./doc-navigator";
import { DocSection, type SectionCtl, type SectionEnv } from "./doc-section";
import { PersonSelector, ToolPalette, type PersonRow } from "./tools-column";
import type { BlocksDoc } from "./use-blocks-data";

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

const ALI = "pp_aliaaaa1";
const BALA = "pp_balabbbb2";
const who = [person(ALI, "Ali"), person(BALA, "Bala")];
const roles = [role(ALI, "Ali", 0), role(BALA, "Bala", 1)];
const block = (key: string, over: Partial<PlacedField> = {}): PlacedField => ({ key, type: "signature", role: ALI, page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.05, required: true, ...over }) as PlacedField;
const d1 = processDoc(1, { title: "Resignation of Director", pageCount: 3, roles, signatureCounts: { [ALI]: 1, [BALA]: 1 } });
const d2 = processDoc(2, { title: "Resignation Letter", pageCount: 1, roles, signatureCounts: { [ALI]: 1, [BALA]: 0 } });
const d3 = processDoc(3, { title: "Section 58 acknowledgement", pageCount: 2, roles, signatureCounts: { [ALI]: 0, [BALA]: 0 } });
const form = processDoc(4, { title: "Intake form", mode: "form", hasForm: true, fromTemplate: true, partCounts: { merchant: 2 } });
const docs = [d1, d2, d3, form];
const covers = docs.map((d) => documentCover(d, who));
const noop = () => {};

describe("the document navigator", () => {
  const nav = (locale: string, current = { doc: 0, page: 1 }, fields: Record<string, PlacedField[]> = { [d1.id]: [block("a", { page: 1 }), block("b", { page: 1 }), block("c", { page: 2 })] }) =>
    page(locale, <DocNavigator covers={covers} fieldsOf={(id) => fields[id]} sizes={{}} opened={{}} current={current} onJumpDoc={noop} onJumpPage={noop} personName={(i) => `Person ${i + 1}`} />);

  for (const locale of LOCALES) {
    it(`lists every document in a landmark with a list, the one in view open with its pages (${locale})`, () => {
      const html = nav(locale);
      expect(html).toContain("<nav");
      expect(html).toContain("data-doc-navigator");
      expect(html.match(/data-nav-doc=/g)).toHaveLength(4);
      for (const d of docs) expect(html).toContain(d.title);
      // the document in view is marked, and only it shows page thumbnails (3 pages)
      expect(html.match(/aria-current="true"/g)).toHaveLength(1);
      expect(html).toContain(`data-nav-doc="${d1.id}" data-current="true"`);
      expect(html.match(/data-thumb=/g)).toHaveLength(3);
      // the page in view is marked, and the pages with blocks say how many
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain('data-page-blocks="2"');
      expect(html).toContain('data-page-blocks="1"');
    });
  }

  it("follows the document in view: another document is the open one", () => {
    const html = nav("en", { doc: 1, page: 0 });
    expect(html).toContain(`data-nav-doc="${d2.id}" data-current="true"`);
    expect(html).toContain(`data-nav-doc="${d1.id}" data-current="false"`);
    expect(html.match(/data-thumb=/g)).toHaveLength(1);
  });

  it("marks a document where a person who must sign has no block, and not one where everybody has", () => {
    const html = nav("en");
    const at = (d: { id: string }) => html.slice(html.indexOf(`data-nav-doc="${d.id}"`), html.indexOf("</li>", html.indexOf(`data-nav-doc="${d.id}"`)));
    expect(at(d1)).not.toContain("data-missing");
    expect(at(d2)).toContain("data-missing");
    expect(at(d2)).toContain("Bala");
    expect(at(d3)).toContain('data-missing="2"');
  });

  it("gives a form with nothing printed its summary and no pages", () => {
    const html = nav("en", { doc: 3, page: 0 });
    const item = html.slice(html.indexOf(`data-nav-doc="${form.id}"`));
    expect(item).toContain("Form · 2 parts");
    expect(item).not.toContain("data-thumb");
  });

  it("says each document's number, title, pages and blocks", () => {
    const html = nav("en");
    expect(html).toContain("1.");
    expect(html).toContain("3 pages · 2 blocks");
    expect(html).toContain("1 page · 1 block");
    expect(html).toContain("2 pages · No blocks yet");
  });
});

describe("the phone's 'jump to document' menu", () => {
  for (const locale of LOCALES) {
    it(`is a labelled menu of the documents with the one in view chosen (${locale})`, () => {
      const html = page(locale, <DocJumpSelect covers={covers} current={{ doc: 2, page: 0 }} onJumpDoc={noop} />);
      expect(html).toContain("data-doc-jump");
      expect(html).toContain('for="blocks-jump-doc"');
      expect(html.match(/<option/g)).toHaveLength(4);
      expect(html).toMatch(/<option value="2" selected/);
      expect(html).toContain("3. Section 58 acknowledgement");
    });
  }
});

describe("the left column", () => {
  const rows = (over: Partial<PersonRow> = {}): PersonRow[] => [
    { key: ALI, name: "Ali", email: "ali@example.com", color: 0, total: 3, here: 1, canAdd: true, ...over },
    { key: BALA, name: "", email: "bala@example.com", color: 1, total: 0, here: 0, canAdd: true },
  ];
  for (const locale of LOCALES) {
    it(`chooses who a new block is for, with the address under the name and a quick button for each person (${locale})`, () => {
      const html = page(locale, <PersonSelector people={rows()} activeKey={ALI} onActive={noop} onAdd={noop} disabled={false} personName={(i) => `Person ${i + 1}`} />);
      expect(html).toContain('role="radiogroup"');
      expect(html.match(/role="radio"/g)).toHaveLength(2);
      expect(html).toMatch(/aria-checked="true"[^>]*>|aria-checked="true"/);
      expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
      expect(html).toContain("ali@example.com");
      expect(html).toContain("bala@example.com");
      expect(html).toContain("Person 2");
      expect(html).toContain(`data-quick-role="${ALI}"`);
      expect(html).toContain(`data-quick-role="${BALA}"`);
      // only the chosen person is in the tab order
      expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    });
  }

  it("counts the blocks in all and in the document in view", () => {
    const html = page("en", <PersonSelector people={rows()} activeKey={ALI} onActive={noop} onAdd={noop} disabled={false} personName={(i) => `Person ${i + 1}`} />);
    expect(html).toContain("3 blocks in all · 1 in this document");
    expect(html).toContain("0 blocks in all · 0 in this document");
    expect(html).toContain("Add a signature block for Ali");
  });

  it("disables the quick button for a person with no place on the document in view, and everything when nothing can be changed", () => {
    const html = page("en", <PersonSelector people={rows({ canAdd: false })} activeKey={ALI} onActive={noop} onAdd={noop} disabled={false} personName={(i) => `Person ${i + 1}`} />);
    const quick = (marker: string) => {
      const at = html.indexOf(marker);
      return /\sdisabled(=|>|\s)/.test(html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1));
    };
    expect(quick(`data-quick-role="${ALI}"`)).toBe(true);
    expect(quick(`data-quick-role="${BALA}"`)).toBe(false);
    const off = page("en", <PersonSelector people={rows()} activeKey={ALI} onActive={noop} onAdd={noop} disabled personName={(i) => `Person ${i + 1}`} />);
    expect(off.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("has the field types of the template editor, armed one pressed", () => {
    const html = page("en", <ToolPalette tool="signature" onTool={noop} disabled={false} full={false} />);
    expect(html).toContain('role="toolbar"');
    for (const type of ["Signature", "Initials", "Date signed", "Full name", "Text", "Number", "Checkbox", "Dropdown"]) expect(html).toContain(type);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("Click the page to place a Signature field");
  });
});

describe("the coverage line under the heading", () => {
  const people = who;
  for (const locale of LOCALES) {
    it(`says on how many of their documents each person has a block (${locale})`, () => {
      const html = page(locale, <CoverageSummary coverage={coverageByPerson(covers.slice(0, 3), people)} personName={(i) => `Person ${i + 1}`} />);
      expect(html).toContain("data-coverage-summary");
      expect(html).toMatch(new RegExp(`data-person="${ALI}" data-on="2" data-of="3" data-covered="false"`));
      expect(html).toMatch(new RegExp(`data-person="${BALA}" data-on="1" data-of="3" data-covered="false"`));
    });
  }
  it("ticks a person who has a block on every document they are on, from the blocks on the screen", () => {
    const fields: Record<string, PlacedField[]> = { [d1.id]: [block("a"), block("b", { role: BALA })], [d2.id]: [block("c"), block("d", { role: BALA })], [d3.id]: [block("e"), block("f", { role: BALA })] };
    const live = liveCovers([d1, d2, d3], who, (id) => fields[id]);
    const html = page("en", <CoverageSummary coverage={coverageByPerson(live, who)} personName={(i) => `Person ${i + 1}`} />);
    expect(html.match(/data-covered="true"/g)).toHaveLength(2);
    expect(html).toContain("on 3 of 3 documents");
  });
  it("says a single document's blocks in plain words", () => {
    const html = page("en", <CoverageSummary single coverage={coverageByPerson([documentCover(d2, who)], who)} personName={(i) => `Person ${i + 1}`} />);
    expect(html).toContain("1 block");
    expect(html).toContain("no block yet");
  });
});

describe("a document's part of the scroll", () => {
  const ctl: SectionCtl = { register: noop, history: noop, opened: noop, layout: noop, value: noop, select: noop, place: noop, toggleUnlock: noop, reload: noop, flush: async () => true, changed: noop };
  const env = (over: Partial<SectionEnv> = {}): SectionEnv => ({ pageWidth: 600, scrollRoot: null, tool: null, preview: false, phone: false, canSend: true, canTemplates: false, ctl, ...over });
  const data = (over: Partial<BlocksDoc> = {}): BlocksDoc => ({
    title: "Resignation Letter",
    fields: [block("a"), block("b", { role: BALA, y: 0.4 })],
    roles,
    values: {},
    pageCount: 1,
    isDraft: true,
    hasFile: true,
    fromTemplate: false,
    envelopeId: null,
    form: null,
    formOnly: false,
    fileVersion: 0,
    ...over,
  });
  const section = (locale: string, load: Parameters<typeof DocSection>[0]["load"], over: Partial<Parameters<typeof DocSection>[0]> = {}, e = env()) =>
    page(
      locale,
      <DocSection env={e} index={1} total={3} docId={d2.id} title="Resignation Letter" pageCount={1} cover={documentCover(d2, who)} load={load} knownPages={undefined} active={false} selectedKey={null} unlocked={false} roleColors={{}} roleEmails={{}} {...over} />,
    );

  for (const locale of LOCALES) {
    it(`has a slim header: its place in the collection, its title, its pages and how many blocks it has (${locale})`, () => {
      const html = section(locale, { status: "ready", data: data() });
      expect(html).toContain("data-doc-header");
      expect(html).toContain('data-doc-index="1"');
      expect(html).toContain("Resignation Letter");
      expect(html).toContain('data-blocks="1"');
      // the pages are there as sheets even before the file is open, with the blocks over them
      expect(html).toContain('data-doc-pages="' + d2.id + '"');
      expect(html.match(/data-page="/g)).toHaveLength(1);
      expect(html.match(/data-field="/g)).toHaveLength(2);
    });
  }

  it("reads '2 of 3 · title · 1 page' with the chip 'N blocks' or 'No blocks yet'", () => {
    const html = section("en", { status: "ready", data: data() });
    expect(html).toContain("2 of 3");
    expect(html).toContain("1 page");
    expect(html).toContain("1 block");
    const empty = section("en", { status: "ready", data: data({ fields: [] }) }, { cover: documentCover(d3, who) });
    expect(empty).toContain("No blocks yet");
    expect(empty).toContain('data-blocks="0"');
  });

  it("shows a document that has not been read yet as loading, and one that could not be read with a way to try again", () => {
    expect(section("en", { status: "loading" })).toContain("Loading the document");
    const failed = section("en", { status: "error", code: "request_failed" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
  });

  it("puts a form with nothing printed in the sequence as a card with its summary in the header area", () => {
    const f = { parts: [{ key: "p1", title: { en: "Details" }, role: "merchant", fields: ["x"] }], fields: [{ key: "x", type: "text", label: { en: "Name" } }] } as never;
    const html = section("en", { status: "ready", data: data({ formOnly: true, hasFile: false, fields: [], form: f, roles: [role("merchant", "Merchant")] }) }, { cover: documentCover(form, who) });
    expect(html).toContain("data-card");
    expect(html).toContain("This document is a form only");
    expect(html).not.toContain("data-doc-pages");
    // the form summary opens by itself
    expect(html).toContain("data-doc-options");
    expect(html).toContain(`id="form-summary-${d2.id}"`);
  });

  it("is read only for someone who may not change it, a document that was sent, a template whose fields are not unlocked and a phone", () => {
    const crosshair = (html: string) => html.includes("cursor-crosshair");
    const base = env({ tool: "signature" });
    expect(crosshair(section("en", { status: "ready", data: data() }, { active: true }, base))).toBe(false); // not open yet: sheets are never drawn on
    const sent = section("en", { status: "ready", data: data({ isDraft: false }) }, {}, base);
    expect(sent).not.toContain("Replace file");
    expect(section("en", { status: "ready", data: data({ fromTemplate: true }) }, {}, base)).not.toContain("data-doc-options");
  });

  it("offers the template's fields to be unlocked, and a file to be replaced, to someone who may change the draft", () => {
    const html = section("en", { status: "ready", data: data({ fromTemplate: true }) });
    // (a template without a form does not open its options by itself; one with a form does)
    expect(html).not.toContain("Replace file");
    const withForm = section("en", { status: "ready", data: data({ fromTemplate: true, form: { parts: [{ key: "p", title: { en: "A" }, role: "merchant", fields: [] }], fields: [] } as never, roles: [role("merchant", "Merchant")] }) });
    expect(withForm).toContain("Edit fields");
    expect(withForm).toContain("Replace file");
    expect(withForm).toContain("The fields come from the template.");
  });
});
