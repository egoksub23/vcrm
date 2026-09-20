import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../../messages/en.json";
import ko from "../../../../messages/ko.json";
import { classifyJiraField } from "@/lib/jira/field-mapping";
import type { FieldMappingRow } from "@/lib/jira/field-mapping";
import { normalizeSettings } from "@/lib/jira/settings";
import { DEFAULT_JIRA_SETTINGS } from "@/lib/jira/types";

import type { JiraDiagnostics, JiraFieldsData } from "./jira-api";
import { JiraChecklistCard } from "./jira-checklist";
import { JiraDiagnosticsTab } from "./jira-diagnostics-tab";
import { JiraDirectionTab } from "./jira-direction-tab";
import { JiraFieldsTab } from "./jira-fields-tab";
import { JiraOverridesCard, overrideCount } from "./jira-overrides";

// Render smoke tests for the 0.45.0 settings screens (Fields tab, per-project
// overrides, first-run checklist and Test connection, the new Direction and
// Diagnostics parts) in English and Korean with the real messages. next-intl
// errors are thrown, so a missing key fails here.

const messagesFor = { en, ko } as const;

function render(node: React.ReactNode, locale: "en" | "ko" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesFor[locale] as never}
      timeZone="UTC"
      now={new Date("2026-09-20T12:00:00Z")}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const both = ["en", "ko"] as const;
const noop = () => undefined;
const CF = "com.atlassian.jira.plugin.system.customfieldtypes:";

const fieldsData = (over: Partial<JiraFieldsData> = {}): JiraFieldsData => ({
  project: "ENG",
  issueType: { id: "10004", name: "Bug" },
  issueTypes: [
    { id: "10004", name: "Bug" },
    { id: "10005", name: "Task" },
  ],
  fields: [
    classifyJiraField({ fieldId: "customfield_1", name: "Browser version", required: false, schema: { type: "string", custom: `${CF}textfield` } }),
    classifyJiraField({ fieldId: "customfield_3", name: "Story points", required: false, schema: { type: "number", custom: `${CF}float` } }),
    classifyJiraField({ fieldId: "fixVersions", name: "Fix versions", required: false, schema: { type: "array", items: "version", system: "fixVersions" } }),
    classifyJiraField({ fieldId: "customfield_9", name: "Reviewer", required: false, schema: { type: "user", custom: `${CF}userpicker` } }),
    classifyJiraField({ fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } }),
  ],
  cachedAt: "2026-09-20T09:00:00.000Z",
  cached: true,
  ticketFields: [
    { id: "fd-browser", label: "Browser", field_type: "text", options: [] },
    { id: "fd-pts", label: "Points", field_type: "number", options: [] },
    { id: "fd-vip", label: "VIP", field_type: "checkbox", options: [] },
  ],
  mappings: [
    {
      id: "m1",
      account_id: "a",
      connection_id: "c",
      project_key: "ENG",
      ticket_field_id: "fd-browser",
      jira_field_id: "customfield_1",
      jira_field_name: "Browser version",
      jira_kind: "text",
      direction: "both",
      when_missing: "skip",
      default_value: null,
      config: null,
    } satisfies FieldMappingRow,
    {
      id: "m2",
      account_id: "a",
      connection_id: "c",
      project_key: "*",
      ticket_field_id: "fd-pts",
      jira_field_id: "customfield_gone",
      jira_field_name: "Old points",
      jira_kind: "number",
      direction: "from_jira",
      when_missing: "default",
      default_value: "0",
      config: null,
    } satisfies FieldMappingRow,
  ],
  ...over,
});

describe.each(both)("Jira settings 0.45.0 (%s)", (locale) => {
  const m = () => messagesFor[locale].Settings.jira;

  it("the Fields tab lists mappings, the compatible add form and every Jira field with its status", () => {
    const html = render(
      <JiraFieldsTab
        projects={["ENG", "OPS"]}
        project="ENG"
        onProjectChange={noop}
        data={fieldsData()}
        error={null}
        refreshing={false}
        busy={false}
        onIssueTypeChange={noop}
        onRefresh={noop}
        onRetry={noop}
        onSave={noop}
        onRemove={noop}
        allowEveryProject
      />,
      locale,
    );
    expect(html).toContain(m().fields.scope.title);
    // mappings
    expect(html).toContain("Browser");
    expect(html).toContain("customfield_1");
    expect(html).toContain(m().fields.directions.both);
    expect(html).toContain(m().fields.missing.skip);
    expect(html).toContain(m().fields.everyProject);
    expect(html).toContain(m().fields.mappings.notOnScreen); // m2's Jira field is not on this screen any more
    // the add form offers only ticket fields not yet mapped for this project
    expect(html).toContain(m().fields.add.title);
    expect(html).toContain("VIP");
    // every Jira field is listed: supported ones can be mapped, the rest are "not supported" with a reason
    expect(html).toContain("Story points");
    expect(html).toContain(m().fields.jiraFields.supported);
    for (const name of ["Fix versions", "Reviewer", "Summary"]) expect(html).toContain(name);
    expect(html.split(`>${m().fields.jiraFields.notSupported}<`).length - 1).toBe(3); // the three chips, not the sentence that mentions them
    expect(html).toContain(m().fields.jiraFields.reasons.type);
    expect(html).toContain(m().fields.jiraFields.reasons.handled);
    // how it behaves, including the rich-text note
    expect(html).toContain(m().fields.notes.adf);
    expect(html).toContain(m().fields.notes.firstSync);
    // the cache note and refresh
    expect(html).toContain(m().fields.refresh);
  });

  it("the Fields tab shows a hint with no projects, a spinner while loading and the problem when loading failed", () => {
    const none = render(<JiraFieldsTab projects={[]} project="" onProjectChange={noop} data={null} error={null} refreshing={false} busy={false} onIssueTypeChange={noop} onRefresh={noop} onRetry={noop} onSave={noop} onRemove={noop} />, locale);
    expect(none).toContain(m().fields.noProjects);
    const bad = render(<JiraFieldsTab projects={["ENG"]} project="ENG" onProjectChange={noop} data={null} error="Jira said no" refreshing={false} busy={false} onIssueTypeChange={noop} onRefresh={noop} onRetry={noop} onSave={noop} onRemove={noop} />, locale);
    expect(bad).toContain("Jira said no");
    expect(bad).toContain(m().common.retry);
    const loading = render(<JiraFieldsTab projects={["ENG"]} project="ENG" onProjectChange={noop} data={null} error={null} refreshing={false} busy={false} onIssueTypeChange={noop} onRefresh={noop} onSave={noop} onRetry={noop} onRemove={noop} />, locale);
    expect(loading).toContain(m().common.loading);
  });

  it("every ticket field type and Jira kind the Fields tab can name has a translated label", () => {
    for (const k of ["text", "textarea", "number", "date", "dropdown", "checkbox"]) expect((m().fields.ticketTypes as Record<string, string>)[k], k).toBeTruthy();
    for (const k of ["text", "textarea", "number", "date", "select", "multicheckbox", "labels"]) expect((m().fields.kinds as Record<string, string>)[k], k).toBeTruthy();
    for (const k of ["skip", "clear", "default"]) expect((m().fields.add.whenMissingHint as Record<string, string>)[k], k).toBeTruthy();
    for (const k of ["unsupported_field", "incompatible_field", "too_many", "project_not_allowed"]) expect((m().depth.errors as Record<string, string>)[k], k).toBeTruthy();
    expect(m().tabs.fields).toBeTruthy();
  });

  it("per-project overrides: a row per allowed project with its override count, and the open row shows the four groups", () => {
    const overrides = normalizeSettings({ project_overrides: { ENG: { issue_type: "Bug", priority: { urgent: "Blocker" }, direction: { status_to_jira: true } } } }).project_overrides;
    expect(overrideCount(overrides.ENG)).toBe(3);
    expect(overrideCount(undefined)).toBe(0);
    const html = render(
      <JiraOverridesCard
        projects={["ENG", "OPS"]}
        overrides={overrides}
        workspace={{ ...DEFAULT_JIRA_SETTINGS }}
        priorities={[
          { id: "1", name: "Highest" },
          { id: "2", name: "Blocker" },
        ]}
        issueTypesFor={() => [
          { id: "1", name: "Bug" },
          { id: "2", name: "Task" },
        ]}
        onOpenProject={noop}
        onChange={noop}
        initiallyOpen={["ENG"]}
      />,
      locale,
    );
    expect(html).toContain("ENG");
    expect(html).toContain("OPS");
    expect(html).toContain(m().overrides.noneSet); // OPS
    expect(html).toMatch(/3 overrides|재정의 3개/);
    expect(html).toContain(m().overrides.issueType);
    expect(html).toContain(m().overrides.priority);
    expect(html).toContain(m().overrides.direction);
    expect(html).toContain(m().overrides.category.category_label);
    expect(html).toContain("Blocker");
    // the attachments switches can be overridden per project too
    expect(html).toContain(m().depth.flow.attachments.label);
    expect(html).toContain(m().depth.flow.attachments_auto.label);
    expect(html).toContain(m().overrides.note);
  });

  it("overrides with no allowed projects say to choose some first", () => {
    const html = render(<JiraOverridesCard projects={[]} overrides={{}} workspace={{ ...DEFAULT_JIRA_SETTINGS }} priorities={null} issueTypesFor={() => null} onOpenProject={noop} onChange={noop} />, locale);
    expect(html).toContain(m().overrides.noProjects);
  });

  it("the first-run checklist: five steps, done ones marked, the next one highlighted, and the Test connection button", () => {
    const steps = [
      { id: "credentials", done: true },
      { id: "connected", done: true },
      { id: "project", done: false },
      { id: "webhook", done: false },
      { id: "sync", done: false },
    ] as const;
    const html = render(<JiraChecklistCard steps={[...steps]} canTest testing={false} result={null} failureText={() => "x"} onTest={noop} />, locale);
    for (const s of ["credentials", "connected", "project", "webhook", "sync"]) expect(html).toContain((m().checklist.steps as Record<string, { label: string }>)[s].label);
    expect(html).toContain('aria-current="step"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain(m().checklist.test.button);
    expect(html).not.toContain(m().checklist.allDone);
    const all = render(<JiraChecklistCard steps={steps.map((s) => ({ ...s, done: true }))} canTest testing={false} result={null} failureText={() => "x"} onTest={noop} />, locale);
    expect(all).toContain(m().checklist.allDone);
    expect(all).not.toContain('aria-current="step"');
  });

  it("Test connection shows who Vircle is, the projects it can browse, or why it failed", () => {
    const ok = render(<JiraChecklistCard steps={null} canTest testing={false} failureText={() => "x"} onTest={noop} result={{ ok: true, user: { displayName: "Vircle Integration", accountId: "a" }, projects: [{ key: "ENG", name: "Engineering" }, { key: "OPS", name: "Operations" }], hasMore: false }} />, locale);
    expect(ok).toContain("Vircle Integration");
    expect(ok).toContain("ENG");
    expect(ok).toContain("Operations");
    const none = render(<JiraChecklistCard steps={null} canTest testing={false} failureText={() => "x"} onTest={noop} result={{ ok: true, user: { displayName: null, accountId: null }, projects: [], hasMore: false }} />, locale);
    expect(none).toContain(m().checklist.test.noProjects);
    const bad = render(<JiraChecklistCard steps={null} canTest testing={false} failureText={(c) => `problem:${c}`} onTest={noop} result={{ ok: false, code: "jira_permission", message: "" }} />, locale);
    expect(bad).toContain(m().checklist.test.failed);
    expect(bad).toContain("problem:jira_permission");
    const off = render(<JiraChecklistCard steps={null} canTest={false} testing={false} result={null} failureText={() => ""} onTest={noop} />, locale);
    expect(off).toContain("disabled");
  });

  it("Direction: attachments and 'send all new' switches, and the webhook trust card with the amber note and Require signed deliveries", () => {
    const props = {
      direction: { ...DEFAULT_JIRA_SETTINGS.direction, attachments: true },
      privacy: DEFAULT_JIRA_SETTINGS.privacy,
      personalDataReport: true,
      canManageRoles: false,
      onDirectionChange: noop,
      onPrivacyChange: noop,
      onPersonalDataReportChange: noop,
      onRequireSignedChange: noop,
    };
    const html = render(<JiraDirectionTab {...props} requireSigned={false} webhookStats={{ unsigned: 4, signed: 0 }} />, locale);
    expect(html).toContain(m().depth.flow.attachments.label);
    expect(html).toContain(m().depth.flow.attachments_auto.label);
    expect(html).toContain(m().depth.flow.attachmentsLimits);
    expect(html).toContain(m().depth.webhook.requireSigned.label);
    expect(html).toContain('role="status"'); // the amber note
    expect(html).toContain(m().depth.webhook.requireSigned.warning);
    const quiet = render(<JiraDirectionTab {...props} requireSigned webhookStats={null} />, locale);
    expect(quiet).not.toContain('role="status"');
    expect(quiet).not.toContain(m().depth.webhook.requireSigned.warning);
  });

  it("Diagnostics: the stalled banner, how webhooks arrive, and the personal-data report with Send now", () => {
    const data: JiraDiagnostics = {
      connection: { status: "active", statusReason: null, siteName: "Acme" },
      tokenExpiresAt: null,
      lastCatchupAt: "2026-09-20T10:00:00.000Z",
      webhook: { registered: true, count: 1, expiresAt: null, checkedAt: null, lastDeliveryAt: null },
      catchupStalled: true,
      catchupMinutes: 120,
      report: { at: "2026-09-19T00:00:00.000Z", ok: false, error: "Atlassian answered 500" },
      webhookTrust: { signed: 2, unsigned: 9, rejectedUnsigned: 1, lastUnsignedAt: "2026-09-20T11:00:00.000Z", since: "2026-09-18T00:00:00.000Z", requireSigned: false },
    };
    const props = { data, error: null, refreshing: false, action: null, onRefresh: noop, onRegisterWebhooks: noop, onCatchup: noop, onSendReport: noop };
    const html = render(<JiraDiagnosticsTab {...props} />, locale);
    expect(html).toContain(m().depth.stalled.title);
    expect(html).toContain('role="alert"');
    expect(html).toContain(m().depth.trust.title);
    expect(html).toContain(m().depth.trust.strictOff);
    expect(html).toContain(m().depth.report.title);
    expect(html).toContain(m().depth.report.failed);
    expect(html).toContain("Atlassian answered 500");
    expect(html).toContain(m().depth.report.sendNow);
    const ok = render(
      <JiraDiagnosticsTab {...props} data={{ ...data, catchupStalled: false, report: { at: "2026-09-19T00:00:00.000Z", ok: true, reported: 12, erased: 1, refreshed: 0 }, webhookTrust: { signed: 5, unsigned: 0, rejectedUnsigned: 0, lastUnsignedAt: null, since: null, requireSigned: true } }} />,
      locale,
    );
    expect(ok).not.toContain(m().depth.stalled.title);
    expect(ok).toContain(m().depth.report.ok);
    expect(ok).toContain(m().depth.trust.strictOn);
    const never = render(<JiraDiagnosticsTab {...props} data={{ ...data, report: null, webhookTrust: undefined, catchupStalled: false }} />, locale);
    expect(never).toContain(m().depth.report.never);
  });
});

describe("the new Settings.jira strings", () => {
  it("exist in both languages with the same keys and the same ICU arguments", () => {
    const keys = (o: unknown, prefix = ""): string[] =>
      typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix];
    for (const ns of ["checklist", "fields", "overrides", "depth"] as const) {
      expect(keys(ko.Settings.jira[ns]).sort(), ns).toEqual(keys(en.Settings.jira[ns]).sort());
    }
    const args = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((x) => x[1]))].sort().join(",");
    const walk = (a: unknown, b: unknown, path: string) => {
      if (typeof a === "string") {
        expect(args(b as string), path).toBe(args(a));
        return;
      }
      for (const k of Object.keys(a as object)) walk((a as never)[k], (b as never)[k], `${path}.${k}`);
    };
    for (const ns of ["checklist", "fields", "overrides", "depth"] as const) walk(en.Settings.jira[ns], ko.Settings.jira[ns], ns);
    expect(en.Settings.jira.tabs.fields).toBeTruthy();
    expect(ko.Settings.jira.tabs.fields).toBeTruthy();
  });
});
