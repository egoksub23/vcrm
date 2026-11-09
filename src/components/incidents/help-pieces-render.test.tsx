import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { FindingsPanel } from "./findings-panel";
import { InfoTip } from "./info-tip";

const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"));
const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={messages}
      onError={(e: Error) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );

describe("the small help pieces on the incident page", () => {
  it("InfoTip is a labelled button that says its sentence", () => {
    const html = render(<InfoTip text="How serious the incident is." />);
    expect(html).toContain('aria-label="How serious the incident is."');
    expect(html).toContain("<button");
  });

  it("the root cause box: editable for managers, plain text for everyone else, and absent when there is nothing to show", () => {
    const edit = render(<FindingsPanel value="Wet field" canEdit onSave={async () => true} />);
    expect(edit).toContain("Root cause");
    expect(edit).toContain("<textarea");
    expect(edit).toContain("Wet field");
    const view = render(<FindingsPanel value="Wet field" canEdit={false} onSave={async () => true} />);
    expect(view).not.toContain("<textarea");
    expect(view).toContain("Wet field");
    expect(render(<FindingsPanel value={null} canEdit={false} onSave={async () => true} />)).toBe("");
  });
});
