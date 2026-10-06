import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";

// Server-rendered smoke test: the editor, its panels and the page layer render for a small document without
// throwing, draw every field in its role's colour, and respect read-only. Effects do not run in a server
// render, so the PDF is stubbed as already loaded (two pages) and the translations return their keys.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => "en",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/sign/pdf-pages", () => ({
  usePdf: () => ({ status: "ready", doc: {}, pages: [{ width: 595, height: 842 }, { width: 595, height: 842 }] }),
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

import { FieldBox } from "./field-box";
import { FieldEditor } from "./field-editor";
import { PropertiesPanel } from "./properties-panel";
import { RolesPanel } from "./roles-panel";

const roles: SignRole[] = [
  { key: "role_1", label: "Merchant", kind: "signer", color: 0 },
  { key: "role_2", label: "Witness", kind: "filler", color: 1 },
];
const fields: PlacedField[] = [
  { key: "f_sig1", type: "signature", role: "role_1", page: 0, x: 0.1, y: 0.8, w: 0.26, h: 0.05, required: true },
  { key: "f_text", type: "text", role: "role_2", page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.03, required: true, label: "Address" },
  { key: "f_fixd", type: "static_text", role: "sender", page: 1, x: 0.1, y: 0.4, w: 0.3, h: 0.03, required: false, text: "Fixed" },
  { key: "f_bad", type: "dropdown", role: "role_1", page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.03, required: true, options: [] },
];

const render = (props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) =>
  renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={fields} roles={roles} onChange={() => {}} mode="draft" {...props} />);

describe("FieldEditor render", () => {
  it("draws every field on its page and the palette, panel tabs and issues count", () => {
    const html = render();
    for (const f of fields) expect(html).toContain(`data-field="${f.key}"`);
    expect(html).toContain('data-overlay="0"');
    expect(html).toContain('data-overlay="1"');
    for (const type of ["signature", "initials", "name", "date_signed", "date", "text", "number", "static_text", "checkbox", "dropdown", "upload"]) {
      expect(html).toContain(`types.${type}`);
    }
    for (const tab of ["field", "fields", "roles", "issues"]) expect(html).toContain(`panel.${tab}`);
    // the dropdown without options is a problem, shown on the tab and on the box
    expect(html).toMatch(/panel\.issues<span[^>]*>\d+<\/span>/);
  });

  it("colours a field by its role, and the sender's fields neutrally", () => {
    const html = render();
    expect(html).toContain("--rc-solid:#7c3aed");
    expect(html).toContain("--rc-solid:#0d9488");
    expect(html).toContain("--rc-solid:#64748b");
  });

  it("offers no placing or editing when read-only", () => {
    const html = render({ readOnly: true });
    expect(html).toContain('data-field="f_sig1"');
    expect(html).not.toContain("palette.label");
    expect(html).not.toContain("toolbar.undo");
  });

  it("renders a template with no fields at all", () => {
    const html = render({ fields: [], roles: [], mode: "template" });
    expect(html).toContain("palette.hint");
    expect(html).not.toContain("data-field=");
  });
});

describe("panels", () => {
  const noop = () => {};
  const typeLabels = { signature: "Signature", initials: "Initials", name: "Name", date_signed: "Date signed", date: "Date", text: "Text", number: "Number", static_text: "Fixed", checkbox: "Checkbox", dropdown: "Dropdown", upload: "Upload" };

  it("shows the properties of a dropdown, with its options", () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel field={{ ...fields[3], options: ["Yes", "No"] }} fields={fields} roles={roles} readOnly={false} typeLabels={typeLabels} mergeKeys={[]} pageCount={2} senderLabel="Sender" onChange={noop} onDuplicate={noop} onCopyToPages={noop} onDelete={noop} />,
    );
    expect(html).toContain("props.options");
    expect(html).toContain("Yes\nNo");
    expect(html).toContain("props.copyToPages");
  });

  it("locks a merge field to the sender and hides the required box", () => {
    const html = renderToStaticMarkup(
      <PropertiesPanel field={{ ...fields[1], merge: "company", role: "sender", required: false }} fields={fields} roles={roles} readOnly={false} typeLabels={typeLabels} mergeKeys={["company"]} pageCount={1} senderLabel="Sender" onChange={noop} onDuplicate={noop} onCopyToPages={noop} onDelete={noop} />,
    );
    expect(html).toContain("props.roleSender");
    expect(html).not.toContain("props.required");
    expect(html).toContain('value="company"');
  });

  it("says to select a field when none is selected, and hides actions when read-only", () => {
    const none = renderToStaticMarkup(<PropertiesPanel field={null} fields={fields} roles={roles} readOnly={false} typeLabels={typeLabels} mergeKeys={[]} pageCount={1} senderLabel="Sender" onChange={noop} onDuplicate={noop} onCopyToPages={noop} onDelete={noop} />);
    expect(none).toContain("props.none");
    const ro = renderToStaticMarkup(<PropertiesPanel field={fields[0]} fields={fields} roles={roles} readOnly typeLabels={typeLabels} mergeKeys={[]} pageCount={2} senderLabel="Sender" onChange={noop} onDuplicate={noop} onCopyToPages={noop} onDelete={noop} />);
    expect(ro).not.toContain("props.delete");
  });

  it("lists the roles with their colours and warns about a filler holding a signature", () => {
    const html = renderToStaticMarkup(<RolesPanel roles={[roles[0], { ...roles[1], kind: "filler" }]} fields={[{ ...fields[0], role: "role_2" }]} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(html).toContain("Merchant");
    expect(html).toContain("Witness");
    expect(html).toContain("roles.fillerBlocked");
    expect(html).toContain("roles.add");
  });
});

describe("FieldBox render", () => {
  const ctx = { mergeValues: { company: "Kedai Runcit" }, now: new Date(2026, 9, 5), locale: "en", signerName: "Ali bin Ahmad", textPlaceholder: "Text" };
  const base = {
    senderLabel: "Sender",
    typeLabel: "Text",
    selected: false,
    readOnly: false,
    toolArmed: false,
    preview: false,
    sampleCtx: ctx,
    hasIssue: false,
    pageWidth: 800,
    pageHeight: 1130,
    pxPerPt: 1.34,
    siblings: { current: [] as readonly PlacedField[] },
    callbacks: { select: () => {}, commitRect: () => {}, guides: () => {} },
  };
  const merge: PlacedField = { key: "f_m", type: "text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.04, required: false, merge: "company" };

  it("shows a merge field's value in the box, and a missing one as its name", () => {
    expect(renderToStaticMarkup(<FieldBox {...base} field={merge} role={null} />)).toContain("Kedai Runcit");
    expect(renderToStaticMarkup(<FieldBox {...base} sampleCtx={{ ...ctx, mergeValues: {} }} field={merge} role={null} />)).toContain("{{company}}");
  });

  it("writes sample values in preview: a typed name for a signature, today for the signing date", () => {
    const sig: PlacedField = { key: "f_s", type: "signature", role: "role_1", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.06, required: true };
    const date: PlacedField = { key: "f_d", type: "date_signed", role: "role_1", page: 0, x: 0.1, y: 0.3, w: 0.2, h: 0.03, required: false, dateFormat: "DD/MM/YYYY" };
    const html = renderToStaticMarkup(<FieldBox {...base} preview field={sig} role={roles[0]} />);
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain("cursive");
    expect(renderToStaticMarkup(<FieldBox {...base} preview field={date} role={roles[0]} />)).toContain("05/10/2026");
  });

  it("shows resize handles only on the selected field and never when read-only", () => {
    const f = fields[0];
    expect(renderToStaticMarkup(<FieldBox {...base} selected field={f} role={roles[0]} />).match(/data-handle=/g)).toHaveLength(8);
    expect(renderToStaticMarkup(<FieldBox {...base} field={f} role={roles[0]} />)).not.toContain("data-handle=");
    expect(renderToStaticMarkup(<FieldBox {...base} selected readOnly field={f} role={roles[0]} />)).not.toContain("data-handle=");
  });

  it("positions the box in fractions of the page", () => {
    const html = renderToStaticMarkup(<FieldBox {...base} field={fields[0]} role={roles[0]} />);
    expect(html).toContain("left:10%");
    expect(html).toContain("top:80%");
    expect(html).toContain("width:26%");
  });
});
