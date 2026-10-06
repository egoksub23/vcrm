import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { DataField, FieldOption, L10n } from "@/lib/sign/forms/types";
import { msicItems } from "@/lib/sign/lists/msic";
import { COUNTRIES, STATES_MY } from "@/lib/sign/lists/system-lists";

import { ChoiceControl, MultichoiceControl } from "./choice-control";
import type { ControlProps } from "./control-props";
import { FormUiProvider } from "./form-ui";
import { ListControl } from "./list-control";
import { PICKER_LIMIT, SearchPicker, type SearchPickerProps } from "./search-picker";

// Render checks for the picker a signer uses on a long list: what it says to a screen reader, what it shows closed and open,
// and which control each field gets. Effects and events do not run under renderToStaticMarkup; the keyboard is tested as a pure
// function (client/list-edit.test.ts) and the matching in lists/logic.test.ts. The words are supplied here, so the test does
// not depend on the message files.

const MESSAGES = {
  Sign: {
    signerForm: {
      field: { choose: "Choose..." },
      search: {
        label: "Search {label}",
        placeholder: "Type to search",
        clear: "Clear {label}",
        remove: "Remove {item}",
        selected: "Chosen ({count})",
        count: "{count} of {max}",
        limit: "You can add up to {max}.",
        results: "{count, plural, one {# match} other {# matches}}",
        noMatches: "No matches",
        noMatchesFor: "No matches for {query}",
        more: "Showing the first {shown}. Type more to narrow the list.",
      },
      list: { entryLabel: "{label}, entry {number}", itemLength: "Up to {max} characters", limit: "Up to {max} entries", removeEntry: "Remove entry {number}", add: "Add another" },
      format: { digits: "Digits only" },
    },
  },
};

const html = (node: React.ReactNode, locale: SignerLocale = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC" onError={(e) => { throw e; }}>
      <FormUiProvider value={{ locale }}>{node}</FormUiProvider>
    </NextIntlClientProvider>,
  );

const options = (items: { value: string; label: L10n }[]): FieldOption[] => items;
const STATES = options(STATES_MY);
const MSIC = options(msicItems());
const noop = () => {};

const picker = (over: Partial<SearchPickerProps> = {}) => <SearchPicker id="f1" options={STATES} mode="single" selected={[]} onChange={noop} label="State" {...over} />;

describe("SearchPicker, closed", () => {
  it("is a combobox with an accessible name, collapsed, and says what to do", () => {
    const out = html(picker());
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-label="Search State"');
    expect(out).toContain('aria-autocomplete="list"');
    expect(out).toContain('placeholder="Type to search"');
    expect(out).toContain('id="f1"');
    expect(out).not.toContain('role="listbox"');
    expect(out).not.toContain('role="option"');
  });

  it("shows the chosen name in the box, with a button to clear it", () => {
    const out = html(picker({ selected: ["selangor"] }));
    expect(out).toContain('value="Selangor"');
    expect(out).toContain('aria-label="Clear State"');
  });

  it("shows the name in the page's language, English where there is none", () => {
    expect(html(picker({ options: options(COUNTRIES), selected: ["SG"] }), "ms")).toContain('value="Singapura"');
    expect(html(picker({ options: options(COUNTRIES), selected: ["SG"] }), "zh")).toContain('value="新加坡"');
    expect(html(picker({ options: options(COUNTRIES), selected: ["FR"] }), "zh")).toContain('value="France"');
  });

  it("marks itself invalid and points at the help and error text", () => {
    const out = html(picker({ invalid: true, describedBy: "h e" }));
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="h e"');
  });
});

describe("SearchPicker, open", () => {
  it("lists every match in a listbox the box controls, the first one highlighted, and tells a screen reader how many", () => {
    const out = html(picker({ initial: { open: true, query: "sel" } }));
    expect(out).toContain('aria-expanded="true"');
    expect(out).toMatch(/aria-controls="([^"]+)"/);
    const id = /aria-controls="([^"]+)"/.exec(out)![1];
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain('role="listbox"');
    expect(out.match(/role="option"/g)).toHaveLength(1);
    expect(out).toContain("Selangor");
    expect(out).toContain('aria-activedescendant="');
    expect(out).toContain("1 match");
    expect(out).toContain('data-active="true"');
  });

  it("finds by a word in another language than the page's", () => {
    const out = html(picker({ options: options(COUNTRIES), initial: { open: true, query: "singapura" } }));
    expect(out).toContain("Singapore");
    expect(out.match(/role="option"/g)).toHaveLength(1);
  });

  it("says so when nothing matches", () => {
    const out = html(picker({ initial: { open: true, query: "zzzz" } }));
    expect(out).toContain("No matches for zzzz");
    expect(out).not.toContain('role="option"');
    expect(out).not.toContain("aria-activedescendant");
  });

  it("shows at most 50 matches of a long list, and says how to narrow it", () => {
    const out = html(picker({ options: MSIC, mode: "multi", showCode: true, initial: { open: true } }));
    expect(out.match(/role="option"/g)).toHaveLength(PICKER_LIMIT);
    expect(out).toContain("Showing the first 50. Type more to narrow the list.");
    expect(out).toContain("50 matches");
  });

  it("marks the chosen item selected in a single pick", () => {
    const out = html(picker({ selected: ["kedah"], initial: { open: true } }));
    expect(out).toMatch(/aria-selected="true"[^>]*>[^<]*<span[^>]*>Kedah/);
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it("every row is a tap target of at least 44 px", () => {
    expect(html(picker({ initial: { open: true } }))).toContain("min-h-11");
  });
});

describe("SearchPicker, several", () => {
  it("lists what was added with a remove button for each, code first, and counts them", () => {
    const out = html(picker({ options: MSIC, mode: "multi", showCode: true, max: 3, selected: ["62010", "47111"], label: "MSIC codes" }));
    expect(out).toContain("62010  Computer programming activities");
    expect(out).toContain("47111  Provision stores");
    expect(out).toContain('aria-label="Remove 62010  Computer programming activities"');
    expect(out).toContain('aria-label="Chosen (2)"');
    expect(out).toContain("2 of 3");
    // what was added is not offered again
    const open = html(picker({ options: MSIC, mode: "multi", showCode: true, max: 3, selected: ["62010"], initial: { open: true, query: "62010" } }));
    expect(open).toContain("No matches for 62010");
  });

  it("closes the box when the limit is reached", () => {
    const out = html(picker({ options: MSIC, mode: "multi", max: 1, selected: ["62010"] }));
    expect(out).toContain('readOnly=""');
    expect(out).toContain('aria-readonly="true"');
    expect(out).not.toContain('disabled=""');
    expect(out).toContain('placeholder="You can add up to 1."');
  });

  it("shows the code beside the name in the matches when asked", () => {
    const out = html(picker({ options: MSIC, mode: "multi", showCode: true, initial: { open: true, query: "62010" } }));
    expect(out).toContain('font-mono');
    expect(out).toMatch(/>62010<\/span><span[^>]*>Computer programming activities/);
  });

  it("names an answer that is no longer an option by its value rather than showing nothing", () => {
    expect(html(picker({ mode: "multi", selected: ["gone"] }))).toContain(">gone<");
  });
});

// ---- which control a field gets ---------------------------------------------------------------------------------------------

const field = (over: Partial<DataField> & Pick<DataField, "type">): DataField => ({ key: "f", part: "p", label: { en: "State" }, required: false, ...over });
const control = (f: DataField, input: ControlProps["input"] = {}): ControlProps => ({ field: f, id: "f1", input, invalid: false, onInput: noop, onBlur: noop });
const opts = (n: number): FieldOption[] => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: { en: `Option ${i}` } }));

describe("the control a choice gets", () => {
  it("up to 5 options are rows to tap, up to 12 the phone's menu, more a search", () => {
    const five = html(<ChoiceControl {...control(field({ type: "choice", options: opts(5) }))} />);
    expect(five.match(/type="radio"/g)).toHaveLength(5);
    expect(five).not.toContain("<select");
    const twelve = html(<ChoiceControl {...control(field({ type: "choice", options: opts(12) }))} />);
    expect(twelve).toContain("<select");
    expect(twelve).not.toContain('role="combobox"');
    const thirteen = html(<ChoiceControl {...control(field({ type: "choice", options: opts(13) }))} />);
    expect(thirteen).toContain('role="combobox"');
    expect(thirteen).not.toContain("<select");
    expect(thirteen).toContain('id="f1"');
  });

  it("a choice from a long list shows the chosen name", () => {
    const out = html(<ChoiceControl {...control(field({ type: "choice", options: COUNTRIES, optionList: "countries" }), { text: "MY" })} />);
    expect(out).toContain('value="Malaysia"');
  });

  it("a multiple choice of more than 12 options is a search that adds one at a time; fewer are ticks", () => {
    const many = html(<MultichoiceControl {...control(field({ type: "multichoice", options: opts(20) }), { choices: ["v3"] })} />);
    expect(many).toContain('role="combobox"');
    expect(many).toContain("Option 3");
    const few = html(<MultichoiceControl {...control(field({ type: "multichoice", options: opts(4) }))} />);
    expect(few.match(/type="checkbox"/g)).toHaveLength(4);
    expect(few).not.toContain('role="combobox"');
  });
});

describe("the control a list of entries gets", () => {
  it("is a search over the list when the field has options (MSIC codes), with the codes already added, up to the limit", () => {
    const f = field({ type: "list", label: { en: "MSIC codes" }, options: MSIC, optionList: "msic", maxItems: 4, itemFormat: "digits", itemLength: 5 });
    const out = html(<ListControl {...control(f, { list: ["62010"] })} />);
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-label="Search MSIC codes"');
    expect(out).toContain("62010  Computer programming activities");
    expect(out).toContain("1 of 4");
    expect(out).not.toContain("Add another");
  });

  it("is still free text, a row per entry, when it has none", () => {
    const f = field({ type: "list", label: { en: "Codes" }, maxItems: 4, itemFormat: "digits", itemLength: 5 });
    const out = html(<ListControl {...control(f, { list: ["12345"] })} />);
    expect(out).not.toContain('role="combobox"');
    expect(out).toContain('value="12345"');
    expect(out).toContain("Add another");
  });
});
