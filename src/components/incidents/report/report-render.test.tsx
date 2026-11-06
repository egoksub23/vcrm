import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { ReportApp, ReportNotice } from "./report-app";
import { CCA_FORM } from "@/lib/incidents/intake/form-schema";

// Render smoke tests for the coach's phone page with the real English strings (next-intl throws on a missing key or argument). Effects do not run
// under renderToStaticMarkup, so this is the first paint: the page before the draft is restored.

const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"));
const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

const view = {
  state: "open" as const,
  schema: CCA_FORM,
  mode: "live" as const,
  activity: { id: "A-1", name: "Football U15", venue: "Field 2", date: "2026-11-11" },
  coachName: "Rahim Ismail",
  roster: [{ student_id: "S-1", name: "Adam bin Yusof", class: "9 Amanah" }],
  returnUrl: "https://coach.example.edu.my/activities/A-1",
  expiresAt: "2026-11-11T12:00:00Z",
};

describe("coach report page", () => {
  it("renders its first paint (restoring the draft happens after the page is in the browser)", () => {
    expect(() => render(<ReportApp token="t.k" view={view} origins={[]} />)).not.toThrow();
  });

  it("renders the notices for a link that cannot be filled in", () => {
    expect(render(<ReportNotice kind="invalid" origins={[]} />)).toContain("This link is not valid");
    expect(render(<ReportNotice kind="expired" origins={[]} />)).toContain("This link has expired");
    const done = render(<ReportNotice kind="submitted" reference="INC-2026-31" returnUrl="https://coach.example.edu.my/x" origins={[]} />);
    expect(done).toContain("INC-2026-31");
    expect(done).toContain("Back to the coach portal");
  });
});
