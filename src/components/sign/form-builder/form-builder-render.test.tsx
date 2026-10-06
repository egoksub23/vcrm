import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { L, placement, placements, roles, sampleForm, seeds } from "@/lib/sign/client/form-fixtures";
import { addField, addPart, emptyForm } from "@/lib/sign/client/form-edit";
import { FORM_ISSUE_CODES } from "@/lib/sign/client/form-issues";
import { DATA_FIELD_TYPES, type FormDefinition } from "@/lib/sign/forms/types";
import type { SignTemplateVersionRow } from "@/lib/sign/types";

// Server-rendered smoke tests of the form builder: it renders for a real-sized form without throwing, shows the parts,
// the fields of the chosen part and the properties, and is read-only without the capability. Effects do not run in a
// server render, so what is loaded by effects (contact fields, whether the template was used) stays at its start value.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => "en",
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
const capability = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/use-can", () => ({ useCapability: () => capability.value }));
vi.mock("@/components/sign/signer/form/form-flow", () => ({ FormFlow: () => <div data-form-flow /> }));

import { BuilderScreen } from "./form-builder";
import { FieldProperties, type FieldPropertiesProps } from "./field-properties";
import { FormIssuesPanel } from "./form-issues-panel";
import { RuleEditor } from "./rule-editor";

/** A form like the merchant application: 7 parts, about 60 fields of every type. */
function bigForm(): FormDefinition {
  let form = emptyForm();
  const types = [...DATA_FIELD_TYPES];
  for (let p = 0; p < 7; p++) {
    const part = addPart(form, { title: `Part ${p + 1}`, role: p === 4 ? "finance" : "merchant" })!;
    form = part.form;
    for (let i = 0; i < 9; i++) {
      const r = addField(form, { part: part.key, type: types[(p * 9 + i) % types.length], seeds, taken: new Set(), label: `Question ${p + 1}.${i + 1}` })!;
      form = r.form;
    }
  }
  return form;
}

const template = { id: "11111111-1111-4111-8111-111111111111", name: "Merchant Application", status: "draft" as const, category_id: null };
const versionOf = (form: FormDefinition | null): SignTemplateVersionRow =>
  ({ id: "v1", account_id: "a", template_id: template.id, version_no: 3, source_path: "", source_sha256: "", original_path: null, original_type: null, page_count: 2, fields: placements, roles, form, defaults: {}, created_at: "2026-10-01T00:00:00Z" }) as SignTemplateVersionRow;
const data = (form: FormDefinition | null) => ({ template, version: versionOf(form), versions: [{ id: "v1", version_no: 3, created_at: "2026-10-01T00:00:00Z" }] });

describe("BuilderScreen render", () => {
  it("renders 7 parts and about 60 fields comfortably", () => {
    const form = bigForm();
    expect(form.fields.length).toBe(63);
    const started = Date.now();
    const html = renderToStaticMarkup(<BuilderScreen data={data(form)} />);
    expect(Date.now() - started).toBeLessThan(2500);
    for (let p = 1; p <= 7; p++) expect(html).toContain(`Part ${p}`);
    // the first part's nine fields are listed, the other parts' fields are not (the middle shows one part)
    expect(html).toContain("Question 1.1");
    expect(html).toContain("Question 1.9");
    expect(html).not.toContain("Question 2.1");
    expect(html).toContain("screen.preview");
    expect(html).toContain("tabs.form");
    expect(html).toContain("/sign/templates/11111111-1111-4111-8111-111111111111/form");
    expect(html).toContain("screen.allSaved");
  });

  it("explains page overlay mode when the template has no parts, and offers to add one", () => {
    const html = renderToStaticMarkup(<BuilderScreen data={data(null)} />);
    expect(html).toContain("screen.overlayHint");
    expect(html).toContain("parts.add");
    expect(html).not.toContain("fields.add");
  });

  it("shows the problems of a form that is not sound and the printed count of a field", () => {
    const form = sampleForm();
    form.fields[0] = { ...form.fields[0], label: { en: "" } };
    const html = renderToStaticMarkup(<BuilderScreen data={data(form)} />);
    expect(html).toContain("screen.problems");
    // the field printed in two places says so
    expect(html).toContain("fields.places");
  });

  it("is read-only without the template capability: nothing to add, delete or save", () => {
    capability.value = false;
    try {
      const html = renderToStaticMarkup(<BuilderScreen data={data(sampleForm())} />);
      expect(html).toContain("screen.readOnly");
      expect(html).not.toContain("parts.add");
      expect(html).not.toContain("fields.add");
      expect(html).not.toContain("screen.save");
    } finally {
      capability.value = true;
    }
  });
});

const baseProps = (over: Partial<FieldPropertiesProps> = {}): FieldPropertiesProps => {
  const form = sampleForm();
  return {
    field: form.fields[0],
    form,
    placements,
    lang: "en",
    readOnly: false,
    keyLocked: false,
    followsLabel: false,
    lockedOptionValues: new Set(),
    customFields: ["Tax ID"],
    onPatch: () => {},
    onSetKey: () => true,
    onChangeType: () => {},
    onMoveToPart: () => {},
    onDuplicate: () => {},
    onDelete: () => {},
    onOpenEditor: () => {},
    ...over,
  };
};

describe("FieldProperties render", () => {
  it("renders the properties of a data field of every type", () => {
    for (const type of DATA_FIELD_TYPES) {
      const form = sampleForm();
      const r = addField(form, { part: "company", type, seeds, taken: new Set() })!;
      const field = r.form.fields.find((f) => f.key === r.key)!;
      const html = renderToStaticMarkup(<FieldProperties {...baseProps({ field, form: r.form })} />);
      expect(html, type).toContain(`key-${field.key}`);
      expect(html, type).toContain("texts.label");
    }
  });

  it("shows the settings of the type: options for a choice, accepted files for a file, the format for text", () => {
    const form = sampleForm();
    const get = (key: string) => renderToStaticMarkup(<FieldProperties {...baseProps({ field: form.fields.find((f) => f.key === key)!, form })} />);
    const choice = get("biz_type");
    expect(choice).toContain("options.title");
    expect(choice).toContain("Sdn. Bhd.");
    expect(get("form9")).toContain("type.accept");
    expect(get("account_no")).toContain("type.format");
    expect(get("msic")).toContain("type.itemFormat");
    expect(get("tax_pct")).toContain("type.decimals");
  });

  it("reads the visibility rule back in plain words, from lists", () => {
    const form = sampleForm();
    const html = renderToStaticMarkup(<FieldProperties {...baseProps({ field: form.fields.find((f) => f.key === "tax_pct")!, form })} />);
    expect(html).toContain("rule.inWords");
    expect(html).toContain("rule.showWhen");
    // the rule is shown as a field list, an operator list and a value list, never as a text box of code
    expect(html).toContain("rule.fieldLabel");
    expect(html).toContain("rule.operatorLabel");
    expect(html).toContain("rule.ops.eq");
  });

  it("locks the key and the option values once the template has been used", () => {
    const form = sampleForm();
    const field = form.fields.find((f) => f.key === "biz_type")!;
    const html = renderToStaticMarkup(<FieldProperties {...baseProps({ field, form, keyLocked: true, lockedOptionValues: new Set(["sdn_bhd", "sole"]) })} />);
    expect(html).toContain("key.locked");
    expect(html).toContain("options.valueLocked");
  });

  it("says where the field is printed, and offers the contact fields of the workspace", () => {
    const form = sampleForm();
    const html = renderToStaticMarkup(<FieldProperties {...baseProps({ field: form.fields[0], form })} />);
    expect(html).toContain("printed.summary");
    expect(html).toContain("&quot;count&quot;:2");
    expect(html).toContain("Tax ID");
    expect(html).toContain("printed.open");
  });

  it("shows nothing editable when read-only", () => {
    const form = sampleForm();
    const html = renderToStaticMarkup(<FieldProperties {...baseProps({ field: form.fields[0], form, readOnly: true })} />);
    expect(html).not.toContain("props.delete");
    expect(html).not.toContain("props.duplicate");
  });
});

describe("RuleEditor render", () => {
  it("renders a nested rule with its groups and conditions", () => {
    const form = sampleForm();
    const rule = { op: "and" as const, rules: [{ op: "eq" as const, field: "tax_type", value: "sst" }, { op: "or" as const, rules: [{ op: "notEmpty" as const, field: "legal_name" }, { op: "ne" as const, field: "biz_type", value: "sole" }] }] };
    const html = renderToStaticMarkup(<RuleEditor title="Show if" sentence="showWhen" rule={rule} form={form} lang="en" coalesceKey="x" onChange={() => {}} />);
    expect(html).toContain("rule.joinAnd");
    expect(html).toContain("rule.addGroup");
    expect(html).toContain("rule.leaf.eq");
    expect(html).toContain("rule.leaf.notEmpty");
    expect(html).toContain("rule.leaf.ne");
    // an empty rule offers only to add a condition
    const none = renderToStaticMarkup(<RuleEditor title="Show if" sentence="showWhen" rule={undefined} form={form} lang="en" coalesceKey="x" onChange={() => {}} />);
    expect(none).toContain("rule.add");
    expect(none).not.toContain("rule.inWords");
  });
});

describe("FormIssuesPanel render", () => {
  const ctx = { form: sampleForm(), roles, placements, locale: "en" as const };

  it("words each problem and warning and says when there are none", () => {
    expect(renderToStaticMarkup(<FormIssuesPanel issues={[]} warnings={[]} ctx={ctx} onSelect={() => {}} />)).toContain("issues.none");
    const html = renderToStaticMarkup(
      <FormIssuesPanel
        issues={[{ code: "bad_data_label", field: "tax_pct" }, { code: "placement_type_mismatch", field: "p_pct", detail: "tax_pct" }, { code: "something_new" }]}
        warnings={[{ code: "part_empty", part: "bank" }, { code: "static_text_does_not_fit", placement: "p_name" }]}
        ctx={ctx}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("issues.bad_data_label");
    expect(html).toContain("issues.placement_type_mismatch");
    expect(html).toContain("issues.unknown");
    expect(html).toContain("warnings.part_empty");
    expect(html).toContain("warnings.static_text_does_not_fit");
    expect(html).toContain("Tax percentage");
  });

  it("has a message for every code the form can raise", () => {
    expect(FORM_ISSUE_CODES.length).toBeGreaterThan(30);
    const html = renderToStaticMarkup(<FormIssuesPanel issues={FORM_ISSUE_CODES.map((code) => ({ code }))} warnings={[]} ctx={ctx} onSelect={() => {}} />);
    for (const code of FORM_ISSUE_CODES) expect(html).toContain(`issues.${code}`);
    expect(placement({ key: "x" }).key).toBe("x");
    expect(L("a").en).toBe("a");
  });
});
