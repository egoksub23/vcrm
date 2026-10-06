import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { resolveFormLists } from "@/lib/sign/forms/lists";
import type { DataField, FormDefinition, L10n } from "@/lib/sign/forms/types";
import { catalogueOf } from "@/lib/sign/lists/types";
import { STATES_MY } from "@/lib/sign/lists/system-lists";

import { ListSource } from "./list-source";
import { TypeSettings } from "./type-settings";

// Render checks for "where do the options come from" in the form builder. Effects do not run here, so the list of lists is
// "still loading" and only what the field itself says is shown. The words of this part are supplied (English); the rest of the
// builder's words are the real ones when they are in messages/en.json.

const LIST_MESSAGES = {
  source: "Where the options come from",
  sourceTyped: "Typed here",
  sourceList: "A shared list",
  sourceFree: "Anything the signer types",
  sourcePicked: "Picked from a shared list",
  which: "Shared list",
  choose: "Choose a list...",
  loading: "Loading lists...",
  loadFailed: "The lists could not be loaded.",
  unknown: "The list {key} does not exist.",
  archived: "This list is archived.",
  stale: "The list has changed since this form was saved.",
  preview: "{count, plural, one {# option} other {# options}} from the list",
  previewMore: "and {count} more",
  hint: "A copy goes into the form when you save.",
  hintPicked: "The signer searches this list and adds entries.",
};

function real(): Record<string, unknown> {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8")) as { Sign?: { formBuilder?: Record<string, unknown> } }).Sign?.formBuilder ?? {};
  } catch {
    return {};
  }
}

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ Sign: { formBuilder: { ...real(), list: LIST_MESSAGES } } }} timeZone="UTC" onError={(e) => { throw e; }}>
      {node}
    </NextIntlClientProvider>,
  );

const L = (en: string): L10n => ({ en });
const noop = () => {};
const base = (over: Partial<DataField> & Pick<DataField, "type">): DataField => ({ key: "state", part: "p", label: L("State"), required: false, ...over });
const resolved = (f: DataField): DataField => resolveFormLists({ version: 1, parts: [], fields: [f] } as FormDefinition, catalogueOf([{ key: "states_my", kind: "options", items: STATES_MY }, { key: "msic", kind: "msic", items: [{ value: "62010", label: L("Computer programming activities") }] }])).form.fields[0];

describe("ListSource", () => {
  it("offers typed options or a shared list, typed chosen when the field names no list", () => {
    const out = html(<ListSource field={base({ type: "choice", options: [{ value: "a", label: L("A") }] })} lang="en" onChange={noop} />);
    expect(out).toContain("Where the options come from");
    expect(out).toContain("Typed here");
    expect(out).toContain("A shared list");
    expect(out).toMatch(/<input[^>]*checked=""[^>]*value="typed"/);
    expect(out).not.toMatch(/<input[^>]*checked=""[^>]*value="list"/);
    expect(out).not.toContain("<select");
  });

  it("with a list named: the list chosen, a preview of what the field now has, and the note that a copy is made", () => {
    const out = html(<ListSource field={resolved(base({ type: "choice", optionList: "states_my" }))} lang="en" onChange={noop} />);
    expect(out).toMatch(/<input[^>]*checked=""[^>]*value="list"/);
    expect(out).toContain("<select");
    // until the lists are known the select still shows the list the field names
    expect(out).toContain('<option value="states_my" selected="">states_my</option>');
    expect(out).toContain("16 options from the list");
    expect(out).toContain(">Johor<");
    expect(out).toContain("and 10 more");
    expect(out).toContain("A copy goes into the form when you save.");
  });

  it("shows the preview in the language being edited", () => {
    const f = resolved(base({ type: "choice", optionList: "states_my" }));
    expect(html(<ListSource field={f} lang="zh" onChange={noop} />)).toContain("柔佛");
  });

  it("for a list of entries: free text or picked from a list, with the code shown in the preview", () => {
    const free = html(<ListSource field={base({ type: "list", key: "codes" })} lang="en" onChange={noop} />);
    expect(free).toContain("Anything the signer types");
    expect(free).toContain("Picked from a shared list");
    const picked = html(<ListSource field={resolved(base({ type: "list", key: "codes", optionList: "msic" }))} lang="en" onChange={noop} />);
    expect(picked).toContain("1 option from the list");
    expect(picked).toContain("62010");
    expect(picked).toContain("Computer programming activities");
    expect(picked).toContain("The signer searches this list and adds entries.");
  });

  it("can be read only", () => {
    expect(html(<ListSource field={base({ type: "choice", options: [{ value: "a", label: L("A") }] })} lang="en" disabled onChange={noop} />)).toContain("disabled");
  });
});

describe("the settings of a choice", () => {
  const settings = (f: DataField) => html(<TypeSettings field={f} lang="en" lockedOptionValues={new Set()} onChange={noop} />);

  it("a choice that names a list has no option editor to type into; one that does not has", () => {
    const named = settings(resolved(base({ type: "choice", optionList: "states_my" })));
    expect(named).toContain("Where the options come from");
    expect(named).not.toContain('id="opt-add"');
    const typed = settings(base({ type: "choice", options: [{ value: "a", label: L("A") }] }));
    expect(typed).toContain("Where the options come from");
    expect(typed).toContain('id="opt-add"');
  });

  it("a list of entries picked from a list has no format or length to set", () => {
    const named = settings(resolved(base({ type: "list", key: "codes", optionList: "msic" })));
    expect(named).toContain("Where the options come from");
    expect(named).not.toContain("ifmt-codes");
    const free = settings(base({ type: "list", key: "codes" }));
    expect(free).toContain("ifmt-codes");
  });
});
