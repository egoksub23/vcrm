import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Two people can share a name, so the editor shows each person's address next to the name: under the name in the "Filled in by" choice, on the
// quick "Add a signature block" buttons and on the block itself. Without addresses nothing changes (the plain select stays).

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
vi.mock("next-intl", async (importOriginal) => {
  const real = await importOriginal<typeof import("next-intl")>();
  return {
    ...real,
    useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
    useLocale: () => "en",
  };
});

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";
import { FieldEditor } from "./field-editor";
import { PropertiesPanel } from "./properties-panel";
import { RoleEmailsProvider } from "./role-emails";

const noop = () => {};
const twins: SignRole[] = [
  { key: "pp_aaaa1111", label: "Gokula Krishnan", kind: "signer", color: 0, source: "people" },
  { key: "pp_bbbb2222", label: "Gokula Krishnan", kind: "signer", color: 1, source: "people" },
];
const emails = { pp_aaaa1111: "first@example.com", pp_bbbb2222: "second@example.com" };
const sig: PlacedField = { key: "f_sig", type: "signature", role: "pp_aaaa1111", page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.1, required: true };

const panel = (provided: Record<string, string> | null) => {
  const body = (
    <PropertiesPanel field={sig} fields={[sig]} roles={twins} readOnly={false} typeLabels={{ signature: "Signature" } as never} mergeKeys={[]} pageCount={1} senderLabel="Sender" onChange={noop} onDuplicate={noop} onCopyToPages={noop} onDelete={noop} />
  );
  return renderToStaticMarkup(provided ? <RoleEmailsProvider value={provided}>{body}</RoleEmailsProvider> : body);
};

describe("the editor tells two people with one name apart", () => {
  it("lists each person in 'Filled in by' with the address under the name, the chosen one marked", () => {
    const html = panel(emails);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("first@example.com");
    expect(html).toContain("second@example.com");
    expect((html.match(/data-role-option/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-role-option="pp_aaaa1111"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-role-option="pp_aaaa1111"|data-role-option="pp_aaaa1111"[^>]*aria-checked="true"/);
  });

  it("keeps the plain select when no address is known", () => {
    const html = panel(null);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("<select");
  });

  it("shows the address on the quick buttons and on the block", () => {
    const html = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig]} roles={twins} roleEmails={emails} onChange={noop} mode="draft" rolesLocked />);
    expect(html).toContain("first@example.com");
    expect(html).toContain("second@example.com");
    expect(html).toContain("data-chip-email");
  });

  it("shows nothing extra without addresses", () => {
    const html = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig]} roles={twins} onChange={noop} mode="draft" rolesLocked />);
    expect(html).not.toContain("data-chip-email");
    expect(html).not.toContain("example.com");
  });
});

describe("one person, one colour", () => {
  it("draws a role in the colour the screen gives it, not the one saved with the document", () => {
    const plain = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig]} roles={twins} onChange={noop} mode="draft" rolesLocked />);
    const recoloured = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig]} roles={twins} roleColors={{ pp_aaaa1111: 4 }} onChange={noop} mode="draft" rolesLocked />);
    expect(recoloured).not.toBe(plain);
    // the same colours on both when the screen agrees with the roles
    const agreed = renderToStaticMarkup(<FieldEditor pdfUrl="/x.pdf" fields={[sig]} roles={twins} roleColors={{ pp_aaaa1111: 0, pp_bbbb2222: 1 }} onChange={noop} mode="draft" rolesLocked />);
    expect(agreed).toBe(plain);
  });
});
