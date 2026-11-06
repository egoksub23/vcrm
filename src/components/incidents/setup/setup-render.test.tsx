import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for the incident platform screens, with sample data and the real English strings. next-intl throws on a missing key or a missing
// argument, so a typo in a message or a forgotten placeholder fails here. (Effects never run under renderToStaticMarkup; the screens are split into a
// loader and a view so the view can be rendered with data.)

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: "acc-1", user: { id: "u1" }, capabilities: new Set(["incidents.configure"]), capabilitiesLoading: false }),
  useCapability: () => true,
}));
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-incident-standard", () => ({
  useIncidentStandard: () => ({ types: [], severities: [], standardId: null, standardName: "", standardSlug: "school", frameworks: [], rules: [], loading: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/incidents/setup/roles",
}));

import { RolesView, type DirectoryResponse } from "./roles-screen";
import { RulesView, RulesScreen, makeNamer, type RulesResponse } from "./rules-screen";
import { SetupGuide } from "./setup-guide";
import { OverviewScreen } from "../overview-screen";
import { TasksScreen } from "../tasks-screen";
import { AckButton } from "@/app/incident-ack/[token]/ack-button";
import { RECIPES, type IncidentRule } from "@/lib/incidents/platform/rules";
import type { RoleView } from "@/lib/incidents/platform/setup-data";

const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"));
const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

const contact = (id: string, name: string) => ({ id, account_id: "a1", user_id: null, name, kind: "staff" as const, emails: [`${id}@school.test`], phones: ["+60120000001"], preferred_channels: ["email" as const], is_active: true });
const role = (over: Partial<RoleView>): RoleView => ({
  id: "r1",
  account_id: "a1",
  key: "head_of_sport",
  name: { en: "Head of Sport" },
  description: "Runs CCA and sports activities.",
  kind: "fixed",
  dynamic_source: null,
  notify_mode: "all",
  sort_order: 1,
  is_system: true,
  members: [],
  warnings: [],
  used_by: 0,
  ...over,
});

const directory: DirectoryResponse = {
  contacts: [contact("rahim", "Mr Rahim"), contact("tan", "Ms Tan")],
  roles: [
    role({ members: [{ id: "m1", account_id: "a1", role_id: "r1", contact_id: "rahim", position: 1, away_from: null, away_to: null, is_backup: false, contact: contact("rahim", "Mr Rahim") }], used_by: 2 }),
    role({ id: "r2", key: "school_nurse", name: { en: "School nurse" }, warnings: ["no_members"] }),
    role({ id: "r3", key: "reporter", name: { en: "Reporter" }, kind: "per_incident", dynamic_source: "reporter" }),
    role({ id: "r4", key: "bursar", name: { en: "Bursar" }, is_system: false }),
  ],
};

describe("Roles & contacts", () => {
  it("renders roles with their people, the warning for an empty role, and the per-incident roles", () => {
    const html = render(<RolesView data={directory} onChanged={async () => {}} />);
    expect(html).toContain("Head of Sport");
    expect(html).toContain("Mr Rahim");
    expect(html).toContain("Told by 2 rules");
    expect(html).toContain("Worked out for each incident");
    expect(html).toContain("Add to role");
  });
  it("renders an empty directory without crashing", () => {
    expect(() => render(<RolesView data={{ roles: [], contacts: [] }} onChanged={async () => {}} />)).not.toThrow();
  });
});

const template: RulesResponse["template"] = {
  id: "t1",
  name: "School Incident Management",
  categories: [{ id: "c1", standard_id: "t1", code: "CCA", name: "CCA / sports injury", description: null, default_severity: "medium", min_severity: null, notifiable: false, default_flags: ["injury", "child_involved"], position: 0 }],
  severities: [
    { id: "s1", standard_id: "t1", slug: "critical", label: "Critical", color: null, escalate_hrs: null, regulatory_hrs: null, resolve_days: null, position: 0 },
    { id: "s2", standard_id: "t1", slug: "high", label: "Serious", color: null, escalate_hrs: null, regulatory_hrs: null, resolve_days: null, position: 1 },
  ],
};

describe("Rules", () => {
  const rules: IncidentRule[] = RECIPES.filter((r) => r.inStarterSet).slice(0, 3).map((r, i) => ({
    id: `rule-${i}`,
    account_id: "a1",
    recipe_key: r.key,
    position: i,
    enabled: i !== 2,
    ...r.build({ serious: "high" }),
  }));
  const data: RulesResponse = {
    rules,
    recipes: RECIPES.map((r) => ({ key: r.key, name: r.name, description: r.description, inStarterSet: r.inStarterSet, needs: r.needs ?? null, added: rules.some((x) => x.recipe_key === r.key) })),
    template,
    roles: [
      { key: "head_of_sport", name: { en: "Head of Sport" }, kind: "fixed", warnings: [] },
      { key: "school_nurse", name: { en: "School nurse" }, kind: "fixed", warnings: ["no_members"] },
      { key: "principal", name: { en: "Principal" }, kind: "fixed", warnings: [] },
    ],
  };

  it("shows each rule as a sentence, the starter-set offer, recipes still to add, and Try it", () => {
    const namer = makeNamer(data, (f) => f);
    const html = render(<RulesView data={data} namer={namer} reload={async () => {}} />);
    expect(html).toContain("An incident is raised");
    expect(html).toContain("Serious or worse");
    expect(html).toContain("Tell Head of Sport by email and ask them to acknowledge");
    expect(html).toContain("Nobody acknowledged");
    expect(html).toContain("Switch on the starter set");
    expect(html).toContain("Try it");
    expect(html).toContain("School nurse has nobody to tell today");
  });

  it("renders Try it without a template, and the loading state of the loader", () => {
    const namer = makeNamer({ ...data, template: null }, (f) => f);
    expect(() => render(<RulesView data={{ ...data, template: null }} namer={namer} reload={async () => {}} />)).not.toThrow();
    expect(render(<RulesScreen />)).toContain("Loading rules");
  });
});

describe("other screens (loading state) and the acknowledge button", () => {
  it("render their first paint", () => {
    expect(render(<SetupGuide />)).toContain("Loading the setup guide");
    expect(render(<OverviewScreen />)).toContain("Loading the overview");
    expect(render(<TasksScreen />)).toContain("Loading your tasks");
  });
  it("shows the acknowledge button, or the thank-you when it was already done", () => {
    expect(render(<AckButton token="t" initiallyDone={false} />)).toContain("I have seen this");
    expect(render(<AckButton token="t" initiallyDone />)).toContain("Your acknowledgement is recorded");
  });
});
