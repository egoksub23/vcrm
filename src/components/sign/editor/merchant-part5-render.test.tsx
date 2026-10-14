import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MERCHANT_FORM, MERCHANT_ROLES } from "@/lib/sign/addons/merchant/form";
import { DEFAULT_COMMERCIAL_TERMS, DEFAULT_KEY_TERMS } from "@/lib/sign/addons/merchant/default-terms";
import { MERCHANT_PLACEMENTS } from "@/lib/sign/addons/merchant/layout";
import { MAX_STATIC_TEXT } from "@/lib/sign/rules";

// The Merchant Application in the placement editor: Part 5 (page 3) is two boxes of fixed text, not thirteen, and the properties panel
// of such a box takes the long text the key terms need (up to 6,000 characters in a tall text area). Server-rendered, like the form test.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => "en",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/sign/pdf-pages", () => ({
  usePdf: () => ({ status: "ready", doc: {}, pages: Array.from({ length: 4 }, () => ({ width: 595, height: 842 })) }),
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

import { FieldEditor } from "./field-editor";
import { PropertiesPanel } from "./properties-panel";

const noop = () => {};
const typeLabels = { signature: "Signature", initials: "Initials", name: "Name", date_signed: "Date signed", date: "Date", text: "Text", number: "Number", static_text: "Fixed", checkbox: "Checkbox", dropdown: "Dropdown", upload: "Upload" };

describe("the Merchant Application in the placement editor", () => {
  const html = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={MERCHANT_PLACEMENTS} roles={MERCHANT_ROLES} onChange={noop} mode="template" form={MERCHANT_FORM} />);
  const onPage = (n: number) => {
    const page = html.split(`data-page="${n}"`)[1]?.split("data-page=")[0] ?? "";
    return [...page.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
  };

  it("draws every placement of the template, and Part 5 as exactly two text boxes and the acceptance tick", () => {
    const all = [...html.matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(all).size).toBe(MERCHANT_PLACEMENTS.length);
    expect(MERCHANT_PLACEMENTS).toHaveLength(60);
    expect(onPage(2)).toEqual(["p_commercial_terms", "p_key_terms", "p_terms_accepted"]);
    // none of the thirteen boxes of the earlier versions
    expect(all.filter((k) => /^p_(term_|fee_|channel_note)/.test(k))).toEqual([]);
  });
});

describe("the properties panel of a Part 5 box", () => {
  const props = { fields: MERCHANT_PLACEMENTS, roles: MERCHANT_ROLES, readOnly: false, typeLabels, mergeKeys: [], pageCount: 4, senderLabel: "Sender", form: MERCHANT_FORM, onChange: noop, onDuplicate: noop, onCopyToPages: noop, onDelete: noop };
  const panel = (key: string) => renderToStaticMarkup(<PropertiesPanel {...props} field={MERCHANT_PLACEMENTS.find((p) => p.key === key)!} />);
  const textarea = (h: string) => /<textarea[^>]*>/.exec(h)?.[0] ?? "";

  it("offers a tall text area for the key terms, up to 6,000 characters, holding the default points", () => {
    const h = panel("p_key_terms");
    const ta = textarea(h);
    expect(ta).toContain(`maxLength="${MAX_STATIC_TEXT}"`);
    expect(MAX_STATIC_TEXT).toBe(6000);
    expect(ta).toContain('rows="14"');
    expect(h).toContain("props.staticText");
    // the default points are the text it starts with (HTML-escaped inside the text area)
    expect(h).toContain("1. Partner / Rakan kongsi: [insert the agreed wording / masukkan perkataan yang dipersetujui]");
    expect(h).toContain(DEFAULT_KEY_TERMS.split("\n").at(-1)!.replace(/&/g, "&amp;"));
    // it is the sender's text: nothing about answering, being required or filling from a data field
    expect(h).toContain("props.roleSender");
    expect(h).not.toContain("props.required");
  });

  it("offers the same for the platform fee box, and a short one-line box keeps its small text area", () => {
    const h = panel("p_commercial_terms");
    expect(textarea(h)).toContain(`maxLength="${MAX_STATIC_TEXT}"`);
    expect(h).toContain("FPX: [insert the agreed rate / masukkan kadar yang dipersetujui]");
    expect(DEFAULT_COMMERCIAL_TERMS.split("\n")).toHaveLength(4);
    // a one-line fixed text elsewhere (not multi-line) stays three rows
    const one = renderToStaticMarkup(<PropertiesPanel {...props} field={{ key: "x", type: "static_text", role: "sender", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.03, required: false, text: "One line" }} />);
    expect(textarea(one)).toContain('rows="3"');
  });
});
