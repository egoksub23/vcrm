import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The editor inside the sending workflow: "Add a signature block for <Name>" for each person who must sign (the palette's quick actions), the
// banner that sends the sender to the People step when nobody is added yet, and the roles panel saying the people are step 2's. The palette is
// rendered with the real words in four languages; the editor itself with the keys as the words (as the other editor render tests do), the PDF
// stubbed as already loaded because effects do not run in a static render.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/sign/pdf-pages", () => ({
  usePdf: () => ({ status: "ready", doc: {}, pages: [{ width: 595, height: 842 }] }),
  useElementWidth: () => [{ current: null }, 0],
  PdfPages: ({ pages, width, overlay }: { pages: { width: number; height: number }[]; width: number; overlay?: (i: number, s: { width: number; height: number }) => React.ReactNode }) => (
    <div>
      {pages.map((p, i) => (
        <div key={i} data-page={i}>
          {overlay?.(i, { width, height: (width * p.height) / p.width })}
        </div>
      ))}
    </div>
  ),
}));

const keysAsWords = vi.hoisted(() => ({ on: false }));
vi.mock("next-intl", async (importOriginal) => {
  const real = await importOriginal<typeof import("next-intl")>();
  return {
    ...real,
    useTranslations: (ns?: string) => (keysAsWords.on ? (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key) : real.useTranslations(ns)),
    useLocale: () => "en",
  };
});

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";
import { FieldEditor } from "./field-editor";
import { Palette } from "./palette";
import { RolesPanel } from "./roles-panel";

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

const noop = () => {};
const ali: SignRole = { key: "pp_aaaa1111", label: "Ali bin Ahmad", kind: "signer", color: 0, source: "people" };
const siti: SignRole = { key: "pp_bbbb2222", label: "Siti Aminah", kind: "signer", color: 1, source: "people" };
const filler: SignRole = { key: "role_f", label: "Clerk", kind: "filler", color: 2 };
const sig = (role: string, key: string): PlacedField => ({ key, type: "signature", role, page: 0, x: 0.1, y: 0.8, w: 0.26, h: 0.05, required: true });

const WORDS: Record<(typeof LOCALES)[number], { add: (name: string) => string; none: string }> = {
  en: { add: (n) => `Add a signature block for ${n}`, none: "none yet" },
  ms: { add: (n) => `Tambah blok tandatangan untuk ${n}`, none: "belum ada" },
  zh: { add: (n) => `为 ${n} 添加签名块`, none: "暂无" },
  ko: { add: (n) => `${n}의 서명 블록 추가`, none: "아직 없음" },
};

describe("the palette's quick actions for the people", () => {
  keysAsWords.on = false;
  for (const locale of LOCALES) {
    it(`has a button for each person, "Add a signature block for <Name>", with how many blocks they have (${locale})`, () => {
      const w = WORDS[locale];
      const html = page(locale, <Palette tool={null} onTool={noop} roles={[ali, siti]} activeRole={ali.key} onActiveRole={noop} disabled={false} full={false} quick={{ roles: [ali, siti], counts: { [ali.key]: 2 }, onAdd: noop }} />);
      expect(html).toContain(w.add("Ali bin Ahmad"));
      expect(html).toContain(w.add("Siti Aminah"));
      expect(html).toContain("data-quick-signatures");
      expect(html).toContain(`data-quick-role="${ali.key}" data-blocks="2"`);
      expect(html).toContain(`data-quick-role="${siti.key}" data-blocks="0"`);
      // a person with none yet says so; the one who has two says how many
      expect(html).toContain(w.none);
      // coloured as the person's blocks are, and named with the person's own colour, not by colour alone
      expect(html).toContain("--rc-solid");
    });

    it(`is not there without people to add for, and cannot be used when the editor is not ready or full (${locale})`, () => {
      const base = { tool: null, onTool: noop, roles: [ali], activeRole: ali.key, onActiveRole: noop };
      expect(page(locale, <Palette {...base} disabled={false} full={false} />)).not.toContain("data-quick-signatures");
      expect(page(locale, <Palette {...base} disabled={false} full={false} quick={{ roles: [], counts: {}, onAdd: noop }} />)).not.toContain("data-quick-signatures");
      const off = page(locale, <Palette {...base} disabled full={false} quick={{ roles: [ali], counts: {}, onAdd: noop }} />);
      const at = off.indexOf("data-quick-role");
      expect(off.slice(off.lastIndexOf("<button", at), off.indexOf(">", at))).toMatch(/\sdisabled(=|>|\s)/);
    });
  }
});

describe("the editor in the sending workflow", () => {
  const editor = (props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) => {
    keysAsWords.on = true;
    return renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig(ali.key, "f1"), sig(ali.key, "f2")]} roles={[ali, siti, filler]} onChange={noop} mode="draft" rolesLocked onGoToPeople={noop} {...props} />);
  };

  it("offers a quick signature for each person who must sign, and none for a filler", () => {
    const html = editor();
    expect(html).toContain("data-quick-signatures");
    expect(html).toContain(`data-quick-role="${ali.key}" data-blocks="2"`);
    expect(html).toContain(`data-quick-role="${siti.key}" data-blocks="0"`);
    expect(html).not.toContain('data-quick-role="role_f"');
    expect(html).toContain("palette.addSignatureFor");
  });

  it("offers none when the layout is locked (a template's, or no permission), or when it is a template being edited", () => {
    expect(editor({ readOnly: true })).not.toContain("data-quick-signatures");
    expect(editor({ mode: "template" })).not.toContain("data-quick-signatures");
    expect(editor({ roles: [], rolesLocked: true })).not.toContain("data-quick-signatures");
  });

  it("with nobody added yet, says to add the people first and offers the way to the People step instead of a link to a collection", () => {
    const html = editor({ roles: [], fields: [], collectionHref: "/sign/envelopes/e1" });
    expect(html).toContain("data-no-people");
    expect(html).toContain("draft.noPeopleFlow");
    expect(html).toMatch(/<button[^>]*>draft\.goToPeople<\/button>/);
    expect(html).not.toContain("draft.openCollection");
    // outside the workflow it is as it was
    const old = editor({ roles: [], fields: [], collectionHref: "/sign/envelopes/e1", onGoToPeople: undefined });
    expect(old).toContain("draft.noPeopleYet");
    expect(old).toContain("draft.openCollection");
  });

  it("the roles panel says the people are step 2's in the workflow, and the collection's people outside it", () => {
    keysAsWords.on = true;
    const panel = (flow: boolean) => renderToStaticMarkup(<RolesPanel roles={[ali, siti]} fields={[sig(ali.key, "f1")]} readOnly={false} rolesLocked flow={flow} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(panel(true)).toContain("roles.fromPeopleHintFlow");
    expect(panel(true).match(/roles\.fromPeopleFlow/g)).toHaveLength(2);
    expect(panel(true)).not.toContain("roles.fromPeopleHint<");
    expect(panel(false)).toContain("roles.fromPeopleHint");
    expect(panel(false)).not.toContain("Flow");
  });
});

describe("the new words of the editor", () => {
  it("exist in every language, and say People and signature block in the product's words", () => {
    keysAsWords.on = false;
    for (const locale of LOCALES) {
      const editorWords = wording(locale).editor as Tree;
      const draft = editorWords.draft as Tree;
      const palette = editorWords.palette as Tree;
      const roles = editorWords.roles as Tree;
      for (const v of [draft.noPeopleFlow, draft.goToPeople, palette.quickLabel, palette.addSignatureFor, palette.noBlockYet, palette.blockCount, roles.fromPeopleFlow, roles.fromPeopleHintFlow]) {
        expect(typeof v).toBe("string");
        expect((v as string).length).toBeGreaterThan(0);
        expect(v as string).not.toMatch(/envelope|sampul/i);
      }
      expect(palette.addSignatureFor as string).toContain("{name}");
    }
  });
});
