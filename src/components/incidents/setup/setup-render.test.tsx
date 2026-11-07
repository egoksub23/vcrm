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
import { TimingView, type TimingData, type TimingStep } from "./timing-screen";
import { RuleEditor } from "./rule-editor";
import { Canvas, FieldSettings, FormBuilder, Palette, Versions, type FormData } from "./form-builder";
import { CCA_FORM } from "@/lib/incidents/intake/form-schema";
import { ReportApp } from "@/components/incidents/report/report-app";
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

  it("renders the rule editor for a new rule and for an existing timed rule, with the sentence it would make", () => {
    const namer = makeNamer(data, (f) => f);
    const fresh = render(<RuleEditor data={data} namer={namer} onSaved={async () => {}} onCancel={() => {}} />);
    expect(fresh).toContain("New rule");
    expect(fresh).toContain("This rule says");
    const timed = rules.find((r) => r.trigger === "unacknowledged") ?? { ...rules[0], trigger: "unacknowledged" as const, wait_minutes: 30 };
    const edit = render(<RuleEditor data={data} rule={timed} namer={namer} onSaved={async () => {}} onCancel={() => {}} />);
    expect(edit).toContain("Edit rule");
    expect(edit).toContain("Nobody has acknowledged it within 30 minutes");
  });

  it("renders Try it without a template, and the loading state of the loader", () => {
    const namer = makeNamer({ ...data, template: null }, (f) => f);
    expect(() => render(<RulesView data={{ ...data, template: null }} namer={namer} reload={async () => {}} />)).not.toThrow();
    expect(render(<RulesScreen />)).toContain("Loading rules");
  });
});

describe("report form builder", () => {
  const categories = [{ code: "CCA", name: "CCA / sports injury" }, { code: "PRD", name: "Property damage" }];
  const noop = () => {};

  it("renders the palette, the canvas with every step and field, and the settings of a choice and a yes/no field", () => {
    expect(render(<Palette onAdd={noop} />)).toContain("Who was involved");
    const canvas = render(<Canvas schema={CCA_FORM} selected="kind" onSelect={noop} edit={noop} />);
    expect(canvas).toContain("What kind of incident was it?");
    expect(canvas).toContain("Add a step");
    const choice = render(<FieldSettings schema={CCA_FORM} field={CCA_FORM.steps[1].fields[0]} categories={categories} edit={noop} onDeleted={noop} />);
    expect(choice).toContain("Options");
    expect(choice).toContain("Files under");
    const yesno = render(<FieldSettings schema={CCA_FORM} field={CCA_FORM.steps[2].fields[2]} categories={categories} edit={noop} onDeleted={noop} />);
    expect(yesno).toContain("When the answer is yes");
    expect(yesno).toContain("Show only if");
  });

  it("renders the versions list with a comparison against the live form, and the loading state", () => {
    const edited = JSON.parse(JSON.stringify(CCA_FORM)) as typeof CCA_FORM;
    edited.steps[1].fields[1].label = { en: "Describe it" };
    const data: FormData = { builtIn: CCA_FORM, draft: null, published: null, categories, allVersions: [{ id: "v1", version: 1, status: "archived", schema: CCA_FORM, note: null, created_at: "2026-11-01T00:00:00Z", published_at: "2026-11-02T00:00:00Z" }] };
    const html = render(<Versions data={data} draft={edited} onRestore={noop} busy={false} />);
    expect(html).toContain("Changed: Describe it");
    expect(html).toContain("Version 1");
    expect(render(<FormBuilder />)).toContain("Loading the form");
  });

  it("renders the phone preview of a form without sending anything", () => {
    const view = { state: "open" as const, schema: CCA_FORM, mode: "test" as const, activity: { id: "P", name: "Sample", venue: null, date: null }, coachName: "Sample coach", roster: [{ student_id: "P-1", name: "Test Student A" }], returnUrl: null, expiresAt: "" };
    expect(() => render(<ReportApp token="preview" view={view} origins={[]} preview />)).not.toThrow();
  });
});

describe("other screens (loading state) and the acknowledge button", () => {
  it("render their first paint", () => {
    expect(render(<SetupGuide />)).toContain("Loading the setup guide");
    expect(render(<TasksScreen />)).toContain("Loading your tasks");
  });
  it("shows the acknowledge button, or the thank-you when it was already done", () => {
    expect(render(<AckButton token="t" initiallyDone={false} />)).toContain("I have seen this");
    expect(render(<AckButton token="t" initiallyDone />)).toContain("Your acknowledgement is recorded");
  });
});

describe("timing and deadlines", () => {
  const step = (over: Partial<TimingStep>): TimingStep => ({ id: "s1", title: "Assess the breach", trigger_flag: "personal_data", role_key: "dpo", shipped_hours: 72, mode: "default", hours: null, enabled: true, ...over });
  const data = (over: Partial<TimingData> = {}): TimingData => ({
    ack_wait_minutes: 30,
    default_ack_wait_minutes: 30,
    roles: [{ key: "dpo", name: "Data protection officer" }],
    packs: [
      { id: "p1", slug: "pdpa_my", name: "PDPA (Malaysia)", legal: true, steps: [step({}), step({ id: "s2", title: "Tell the Commissioner", mode: "hours", hours: 48 }), step({ id: "s3", title: "Tell the people affected", enabled: false })] },
      { id: "p2", slug: "school_policy", name: "School policy", legal: false, steps: [step({ id: "s4", title: "Phone the parents", trigger_flag: "injury", role_key: null, shipped_hours: 4 })] },
    ],
    ...over,
  });
  const noop = async () => {};

  it("shows the shipped wait, every step with its shipped deadline, and flags the legal pack", () => {
    const html = render(<TimingView data={data()} onSaveAck={noop} onSaveStep={noop} />);
    expect(html).toContain("How long to wait for an acknowledgement");
    expect(html).toContain("It starts at 30 minutes");
    expect(html).toContain("As shipped (within 3 days)");
    expect(html).toContain("As shipped (within 4 hours)");
    expect(html).toContain("These deadlines come from the PDPA");
    expect(html).toContain("Phone the parents");
    expect(html).toContain("The incident lead");
  });
  it("marks a changed step and a step that is off, and offers a way back to the shipped value only for the changed ones", () => {
    const html = render(<TimingView data={data()} onSaveAck={noop} onSaveStep={noop} />);
    expect(html).toContain("Changed");
    expect(html).toContain("This step is off, so it is not added to new incidents.");
    expect((html.match(/Back to as shipped/g) ?? []).length).toBe(2);
  });
  it("offers a way back to 30 minutes only when the school has changed the wait", () => {
    expect(render(<TimingView data={data()} onSaveAck={noop} onSaveStep={noop} />)).not.toContain("Back to 30 minutes");
    expect(render(<TimingView data={data({ ack_wait_minutes: 60 })} onSaveAck={noop} onSaveStep={noop} />)).toContain("Back to 30 minutes");
  });
  it("says so when no built-in pack is switched on", () => {
    expect(render(<TimingView data={data({ packs: [] })} onSaveAck={noop} onSaveStep={noop} />)).toContain("No built-in compliance packs are switched on");
  });
});
