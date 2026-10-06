import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { placement, placements, roles, sampleForm } from "@/lib/sign/client/form-fixtures";
import { bindPlacement } from "@/lib/sign/client/form-printing";
import type { PlacedField } from "@/lib/sign/pdf/types";

// Forms in the placement editor: a placement bound to a data field is drawn as a badge with that field's label, is offered
// "Fill with answer" instead of "required", shows a sample of the answer in preview; the side panel lists the data fields with
// Place; the roles panel shows the parts each role holds. Server-rendered, like the 1A editor test.

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

import { DataFieldsPanel } from "./data-fields-panel";
import { FieldBox } from "./field-box";
import { FieldEditor } from "./field-editor";
import { PropertiesPanel } from "./properties-panel";
import { RolesPanel } from "./roles-panel";

const form = sampleForm();
const typeLabels = { signature: "Signature", initials: "Initials", name: "Name", date_signed: "Date signed", date: "Date", text: "Text", number: "Number", static_text: "Fixed", checkbox: "Checkbox", dropdown: "Dropdown", upload: "Upload" };
const noop = () => {};

describe("FieldEditor with a form", () => {
  const render = (props: Partial<React.ComponentProps<typeof FieldEditor>> = {}) => renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={placements} roles={roles} onChange={noop} mode="template" form={form} {...props} />);

  it("draws a bound placement as a badge with the data field's label and marks it bound", () => {
    const html = render();
    expect(html).toContain('data-field="p_name"');
    expect(html).toContain("data-bound");
    expect(html).toContain("data-data-badge");
    expect(html).toContain("Legal name");
    expect(html).toContain("Tax percentage");
    // an ordinary placement is not a badge
    expect(html.split('data-field="f_sig"')[1].split("data-field=")[0]).not.toContain("data-data-badge");
  });

  it("adds the Data tab only when the template has a form", () => {
    expect(render()).toContain("editor.panelData");
    expect(render({ form: null })).not.toContain("editor.panelData");
    expect(render({ form: undefined })).not.toContain("editor.panelData");
  });

  it("opens with the focused placement selected", () => {
    const html = render({ focusKey: "p_pct" });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-field="p_pct"|data-field="p_pct"[^>]*aria-pressed="true"/);
    expect(render()).not.toMatch(/data-field="p_pct"[^>]*aria-pressed="true"/);
  });

  it("names a placement that prints a data field the form no longer has, as a problem", () => {
    const html = render({ fields: [...placements, placement({ key: "p_lost", data: "gone" })] });
    expect(html).toMatch(/panel\.issues<span[^>]*>\d+<\/span>/);
    expect(html).toContain("{{gone}}");
  });
});

describe("a bound placement in the properties panel", () => {
  const bound = bindPlacement(placement({ key: "p_x", type: "text" }), form.fields[0]);
  const props = { fields: placements, roles, readOnly: false, typeLabels, mergeKeys: [], pageCount: 2, senderLabel: "Sender", form, onChange: noop, onDuplicate: noop, onCopyToPages: noop, onDelete: noop };

  it("offers Fill with answer, names the data field and cannot be required or labelled", () => {
    const html = renderToStaticMarkup(<PropertiesPanel {...props} field={bound} />);
    expect(html).toContain("editor.fillWith");
    expect(html).toContain("editor.boundNote");
    expect(html).toContain('value="legal_name" selected');
    expect(html).not.toContain("props.required");
    expect(html).not.toContain("props.label");
    expect(html).not.toContain("props.merge");
    expect(html).toContain("props.roleSender");
  });

  it("lists only the data fields the placement can print, and a tick box also picks the option", () => {
    const text = renderToStaticMarkup(<PropertiesPanel {...props} field={placement({ key: "t", type: "text", role: "merchant" })} />);
    expect(text).toContain('value="legal_name"');
    expect(text).not.toContain('value="form9"');
    const tick = renderToStaticMarkup(<PropertiesPanel {...props} field={bindPlacement(placement({ key: "k", type: "checkbox" }), form.fields[2], "sst")} />);
    expect(tick).toContain("editor.fillOption");
    expect(tick).toContain('value="sst" selected');
    // a signature cannot print an answer: no Fill with answer at all
    const sig = renderToStaticMarkup(<PropertiesPanel {...props} field={placements[0]} />);
    expect(sig).not.toContain("editor.fillWith");
  });

  it("offers nothing form-related without a form", () => {
    const html = renderToStaticMarkup(<PropertiesPanel {...props} form={null} field={placement({ key: "t", type: "text", role: "merchant" })} />);
    expect(html).not.toContain("editor.fillWith");
  });
});

describe("a bound placement in the page layer", () => {
  const ctx = { now: new Date(2026, 9, 5), locale: "en", signerName: "Ali", textPlaceholder: "Sample text", form, sampleItem: (n: number) => `Entry ${n}` };
  const base = { senderLabel: "Sender", typeLabel: "Text", selected: false, readOnly: false, toolArmed: false, preview: false, sampleCtx: ctx, hasIssue: false, pageWidth: 800, pageHeight: 1130, pxPerPt: 1.34, siblings: { current: [] as readonly PlacedField[] }, callbacks: { select: noop, commitRect: noop, guides: noop } };
  const bound = bindPlacement(placement({ key: "p_x", type: "text", w: 0.3, h: 0.04 }), form.fields[0]);

  it("shows the label in the editor and a sample of the answer in preview", () => {
    expect(renderToStaticMarkup(<FieldBox {...base} field={bound} role={null} dataLabel="Legal name" />)).toContain("Legal name");
    const preview = renderToStaticMarkup(<FieldBox {...base} preview field={bound} role={null} dataLabel="Legal name" />);
    expect(preview).toContain("Sample text");
    expect(preview).not.toContain("data-data-badge");
  });

  it("shows a ticked box for a bound tick box in preview, and the entries of a list", () => {
    const tick = bindPlacement(placement({ key: "k", type: "checkbox", w: 0.03, h: 0.03 }), form.fields[2], "sst");
    expect(renderToStaticMarkup(<FieldBox {...base} preview field={tick} role={null} dataLabel="Tax type" />)).toContain("lucide-check");
    const list = bindPlacement(placement({ key: "l", type: "text", w: 0.4, h: 0.1 }), form.fields[4]);
    expect(renderToStaticMarkup(<FieldBox {...base} preview field={list} role={null} dataLabel="MSIC codes" />)).toContain("Entry 1");
  });
});

describe("the Data tab", () => {
  it("lists the data fields by part with how many places print each, and Place except for a file", () => {
    const html = renderToStaticMarkup(<DataFieldsPanel form={form} placements={placements} locale="en" readOnly={false} canPlace onPlace={noop} onShow={noop} />);
    expect(html).toContain("Company");
    expect(html).toContain("Legal name");
    expect(html).toContain("editor.prints");
    expect(html).toContain("&quot;count&quot;:2");
    expect(html).toContain("editor.printsNone");
    expect(html).toContain("editor.notPrintable");
    // one Place button per printable field: 6 of the 7 (the file is not printable)
    expect(html.match(/editor\.place</g)).toHaveLength(6);
    expect(html).toContain("editor.show");
  });

  it("offers no Place when read-only and says when the form has no fields", () => {
    expect(renderToStaticMarkup(<DataFieldsPanel form={form} placements={placements} locale="en" readOnly canPlace onPlace={noop} onShow={noop} />)).not.toContain("editor.place<");
    expect(renderToStaticMarkup(<DataFieldsPanel form={{ ...form, fields: [] }} placements={[]} locale="en" readOnly={false} canPlace onPlace={noop} onShow={noop} />)).toContain("editor.dataEmpty");
  });
});

describe("the roles panel with a form", () => {
  it("shows the parts each role holds and keeps a role that holds parts from being deleted", () => {
    const html = renderToStaticMarkup(<RolesPanel roles={roles} fields={placements} form={form} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(html).toContain("editor.holds");
    expect(html).toContain("Company, Tax");
    expect(html).toContain("editor.cannotDeleteRole");
    expect(html).toMatch(/disabled=""[^>]*aria-label="roles\.delete/);
  });

  it("warns about a signer who holds parts but has no signature box, never about a filler", () => {
    const noSig = placements.filter((p) => p.type !== "signature");
    const html = renderToStaticMarkup(<RolesPanel roles={roles} fields={noSig} form={form} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(html.match(/editor\.signerNoSignature/g)).toHaveLength(1);
    // with the signature back there is no warning
    expect(renderToStaticMarkup(<RolesPanel roles={roles} fields={placements} form={form} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />)).not.toContain("editor.signerNoSignature");
  });

  it("is unchanged without a form", () => {
    const html = renderToStaticMarkup(<RolesPanel roles={roles} fields={placements} readOnly={false} onAdd={noop} onPatch={noop} onDelete={noop} />);
    expect(html).not.toContain("editor.holds");
  });
});
