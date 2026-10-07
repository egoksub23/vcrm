import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// A document of a collection that was not made from a template: its roles are the collection's people. The roles panel shows them locked, no
// role is added by hand or by placing a field, and with nobody yet a banner says to add the people on the collection's page first.
// The editor's own words are the real ones in four languages for the panel; the editor itself is rendered with the keys as the words (as the other
// editor render tests do). Effects do not run in a static render, so the PDF is stubbed as already loaded.

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
import { RolesPanel } from "./roles-panel";
import { useEditorModel, type EditorModel } from "./use-editor-model";

const noop = () => {};
const people: SignRole[] = [
  { key: "pp_aaaa1111", label: "Ali bin Ahmad", kind: "signer", color: 0, source: "people" },
  { key: "pp_bbbb2222", label: "Siti Aminah", kind: "signer", color: 1, source: "people" },
];
const legacy: SignRole = { key: "role_1", label: "Witness", kind: "signer", color: 2 };
const sig = (role: string, key = "f_sig"): PlacedField => ({ key, type: "signature", role, page: 0, x: 0.1, y: 0.8, w: 0.26, h: 0.05, required: true });

const panel = (props: Partial<React.ComponentProps<typeof RolesPanel>> = {}) =>
  renderToStaticMarkup(<RolesPanel roles={people} fields={[sig("pp_aaaa1111"), sig("pp_aaaa1111", "f_sig2")]} readOnly={false} rolesLocked onAdd={noop} onPatch={noop} onDelete={noop} {...props} />);

const editor = (props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) =>
  renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[]} roles={people} onChange={noop} mode="draft" {...props} />);

describe("the roles panel of a document whose roles are the collection's people", () => {
  keysAsWords.on = true;

  it("shows each person's role read-only with its colour and field count, and the words 'from the collection's people'", () => {
    const html = panel();
    expect(html.match(/data-role-locked/g)).toHaveLength(2);
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain("Siti Aminah");
    expect(html.match(/roles\.fromPeople(?!Hint)/g)).toHaveLength(2);
    expect(html).toContain('roles.fieldCount:{&quot;count&quot;:2}');
    expect(html).toContain("light-dark(#7c3aed");
    expect(html).toContain("light-dark(#0d9488");
    expect(html).toContain("roles.fromPeopleHint");
  });

  it("offers no rename, no kind or colour change, no delete and no Add role", () => {
    const html = panel();
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain("roles.delete");
    expect(html).not.toContain("roles.add");
    expect(html).not.toContain("roles.label");
  });

  it("leaves an older role without the people's mark as editable and deletable as today, but still offers no Add role", () => {
    const html = panel({ roles: [...people, legacy], fields: [] });
    expect(html.match(/data-role-locked/g)).toHaveLength(2);
    expect(html).toContain('id="role-label-role_1"');
    expect(html).not.toContain('id="role-label-pp_aaaa1111"');
    expect(html).toContain("roles.delete");
    expect(html).not.toContain("roles.add");
  });

  it("is the panel it always was when the roles are not locked, even for roles that came from people", () => {
    const html = panel({ rolesLocked: false });
    expect(html).not.toContain("data-role-locked");
    expect(html).toContain('id="role-label-pp_aaaa1111"');
    expect(html).toContain("roles.add");
    expect(html).toContain("roles.intro");
    expect(html).not.toContain("roles.fromPeople");
    const omitted = renderToStaticMarkup(<RolesPanel roles={[legacy]} fields={[]} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(omitted).toContain("roles.add");
    expect(omitted).toContain('id="role-label-role_1"');
  });
});

describe("the editor of such a document", () => {
  keysAsWords.on = true;

  it("says nobody has to sign yet when there are no roles, with a way back to the collection", () => {
    const html = editor({ roles: [], rolesLocked: true, collectionHref: "/sign/envelopes/e1" });
    expect(html).toContain("data-no-people");
    expect(html).toContain("draft.noPeopleYet");
    expect(html).toMatch(/<a[^>]*href="\/sign\/envelopes\/e1"[^>]*>draft\.openCollection<\/a>/);
    // the banner sits under the toolbar and above the palette
    expect(html.indexOf("toolbar.undo")).toBeLessThan(html.indexOf("data-no-people"));
    expect(html.indexOf("data-no-people")).toBeLessThan(html.indexOf("palette.label"));
  });

  it("says nothing when the people have made roles, nor for a document on its own, nor for a template", () => {
    expect(editor({ rolesLocked: true, collectionHref: "/sign/envelopes/e1" })).not.toContain("data-no-people");
    expect(editor({ roles: [], rolesLocked: false })).not.toContain("data-no-people");
    expect(editor({ roles: [], mode: "template" })).not.toContain("data-no-people");
  });

  it("shows the locked roles in the side panel's roles tab and the same palette, with the people to assign to", () => {
    const html = editor({ fields: [sig("pp_aaaa1111")], rolesLocked: true });
    // the palette lists the roles to place for
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain("Siti Aminah");
    expect(html).toContain("palette.label");
  });

  it("is unchanged for a document on its own: its panel tabs and palette are there", () => {
    const html = editor({ roles: [legacy], fields: [sig("role_1")] });
    for (const tab of ["field", "fields", "roles", "issues"]) expect(html).toContain(`panel.${tab}`);
    expect(html).toContain("palette.label");
    expect(html).not.toContain("data-no-people");
  });
});

describe("placing a field in such a document", () => {
  keysAsWords.on = true;
  const seeds = { roleLabel: (_k: string, n: number) => `Role ${n}`, dropdownOptions: ["A", "B"], staticText: "Text" };

  /** Run the editor's model once and hand it back, with what it told its parent. */
  function model(opts: { roles: SignRole[]; rolesLocked: boolean }) {
    const changes: { fields: PlacedField[]; roles: SignRole[] }[] = [];
    const held: { model?: EditorModel } = {};
    function Probe({ out }: { out: { model?: EditorModel } }) {
      const m = useEditorModel({ fields: [], roles: opts.roles, onChange: (n) => changes.push(n), seeds, rolesLocked: opts.rolesLocked });
      Object.assign(out, { model: m });
      return null;
    }
    renderToStaticMarkup(<Probe out={held} />);
    return { model: held.model as EditorModel, changes };
  }
  const where = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 };

  it("does not make a role of its own when none may own the type: it places nothing", () => {
    const { model: m, changes } = model({ roles: [], rolesLocked: true });
    expect(m.place({ type: "signature", page: 0, rect: where, preferredRole: null })).toBeNull();
    expect(changes).toEqual([]);
    expect(m.addRole("signer")).toBeNull();
    expect(changes).toEqual([]);
  });

  it("places on a person's role when there is one, and still places fixed text for the sender", () => {
    const { model: m, changes } = model({ roles: people, rolesLocked: true });
    const key = m.place({ type: "signature", page: 0, rect: where, preferredRole: "pp_bbbb2222" });
    expect(key).toBeTruthy();
    expect(changes[0].fields[0].role).toBe("pp_bbbb2222");
    expect(changes[0].roles).toEqual(people);
    const none = model({ roles: [], rolesLocked: true });
    expect(none.model.place({ type: "static_text", page: 0, rect: where, preferredRole: null })).toBeTruthy();
    expect(none.changes[0].roles).toEqual([]);
  });

  it("does not rename, recolour or delete a role the people made, but does an older one", () => {
    const mixed = [...people, legacy];
    const { model: m, changes } = model({ roles: mixed, rolesLocked: true });
    m.patchRole("pp_aaaa1111", { label: "Someone else" });
    m.patchRole("pp_aaaa1111", { color: 4 });
    m.deleteRole("pp_aaaa1111", null);
    expect(changes).toEqual([]);
    m.patchRole("role_1", { label: "Observer" });
    expect(changes[0].roles.find((r) => r.key === "role_1")?.label).toBe("Observer");
    expect(changes[0].roles.filter((r) => r.source === "people")).toEqual(people);
    m.deleteRole("role_1", null);
    expect(changes[changes.length - 1].roles.map((r) => r.key)).toEqual(["pp_aaaa1111", "pp_bbbb2222"]);
  });

  it("is unchanged when the roles are not locked: a first role is made for the first signature, and roles can be added and edited", () => {
    const { model: m, changes } = model({ roles: [], rolesLocked: false });
    const key = m.place({ type: "signature", page: 0, rect: where, preferredRole: null });
    expect(key).toBeTruthy();
    expect(changes[0].roles).toHaveLength(1);
    expect(changes[0].fields[0].role).toBe(changes[0].roles[0].key);
    const more = model({ roles: people, rolesLocked: false });
    expect(more.model.addRole("signer")).toBeTruthy();
    more.model.patchRole("pp_aaaa1111", { label: "Renamed" });
    expect(more.changes[1].roles[0].label).toBe("Renamed");
  });
});

// ---- the words, in every language -------------------------------------------------------------

type Tree = Record<string, unknown>;
function editorWords(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const editorTree = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: { editor?: Tree } }).Sign?.editor;
  return editorTree ?? null;
}
const LOCALES = ["en", "ms", "zh", "ko"] as const;

describe("the locked roles' words, in every language", () => {
  const read = (locale: string, path: string): string => {
    let node: unknown = editorWords(locale);
    for (const part of path.split(".")) node = (node as Tree | undefined)?.[part];
    return typeof node === "string" ? node : "";
  };

  it("exist for the roles panel and the banner, translated, and name the collection in the product's word", () => {
    for (const path of ["roles.fromPeople", "roles.fromPeopleHint", "draft.noPeopleYet", "draft.openCollection"]) {
      const en = read("en", path);
      expect(en).not.toBe("");
      for (const locale of LOCALES) {
        const text = read(locale, path);
        expect(text, `${locale} ${path}`).not.toBe("");
        if (locale !== "en") expect(text, `${locale} ${path}`).not.toBe(en);
      }
    }
    expect(read("en", "draft.noPeopleYet")).toBe("Nobody has to sign yet. Add the people on the collection page first, then place their signature blocks here.");
    expect(read("en", "roles.fromPeople")).toBe("from the collection's people");
    expect(read("ms", "roles.fromPeople")).toContain("koleksi dokumen");
    expect(read("zh", "roles.fromPeople")).toContain("文件集");
    expect(read("ko", "roles.fromPeople")).toContain("문서 모음");
    for (const locale of LOCALES) for (const path of ["roles.fromPeople", "roles.fromPeopleHint", "draft.noPeopleYet", "draft.openCollection"]) expect(read(locale, path)).not.toMatch(/envelope/i);
  });

  for (const locale of LOCALES) {
    it(`the roles panel renders with the real words (${locale})`, () => {
      keysAsWords.on = false;
      try {
        const words = editorWords(locale);
        expect(words).not.toBeNull();
        const html = renderToStaticMarkup(
          <NextIntlClientProvider
            locale={locale}
            timeZone="UTC"
            messages={{ Sign: { editor: words, formBuilder: {} } }}
            onError={(e) => {
              throw e;
            }}
          >
            <RolesPanel roles={people} fields={[sig("pp_aaaa1111")]} readOnly={false} rolesLocked onAdd={noop} onPatch={noop} onDelete={noop} />
          </NextIntlClientProvider>,
        );
        const text = html.replaceAll("&#x27;", "'");
        expect(text).toContain("Ali bin Ahmad");
        expect(text).toContain(read(locale, "roles.fromPeople"));
        expect(text).toContain(read(locale, "roles.fromPeopleHint"));
      } finally {
        keysAsWords.on = true;
      }
    });
  }
});
