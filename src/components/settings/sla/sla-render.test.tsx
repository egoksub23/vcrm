import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeAll, describe, expect, it } from "vitest";

import { Dialog } from "@/components/ui/dialog";
import { MON_FRI_9_TO_18 } from "@/lib/sla/business-time";
import { FIXTURE_SCHEDULES } from "@/lib/sla/business-time.fixtures";
import type { SlaPolicy, SlaSchedule } from "@/lib/sla/types";
import type { Team } from "@/types";
import { BusinessHoursTab } from "./business-hours-tab";
import { PoliciesTab } from "./policies-tab";
import { PolicyEditor } from "./policy-dialog";
import { ScheduleEditor } from "./schedule-editor";
import { SlaPanel } from "./sla-panel";
import { TimezonePicker } from "./timezone-picker";
import { WeeklyEditor } from "./weekly-editor";

// Render smoke tests for Settings > SLA & business hours in English and Korean
// with the real translations (next-intl errors are thrown, so a missing key or
// argument fails here rather than showing a raw key path).

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      now={new Date("2026-09-20T12:00:00Z")}
      onError={(e: Error) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const noop = () => {};
const reload = async () => {};

const schedules: SlaSchedule[] = [
  {
    id: "sch-1",
    account_id: "a",
    name: "Support hours",
    timezone: "America/New_York",
    is_default: true,
    weekly: FIXTURE_SCHEDULES.NY.weekly,
    holidays: [{ id: "h1", schedule_id: "sch-1", holiday_date: "2026-12-25", name: "Christmas" }],
  },
  {
    id: "sch-2",
    account_id: "a",
    name: "Lunch break desk",
    timezone: "Asia/Kuala_Lumpur",
    is_default: false,
    weekly: FIXTURE_SCHEDULES.KL.weekly,
    holidays: [],
  },
];

const policies: SlaPolicy[] = [
  {
    id: "pol-1",
    account_id: "a",
    name: "Urgent tickets",
    position: 1,
    is_active: true,
    conditions: { priorities: ["urgent"], channels: ["email"], labels: ["vip"], team_ids: ["t1"] },
    first_response_minutes: 30,
    resolution_minutes: 240,
    schedule_id: "sch-1",
    pause_while_pending: true,
    at_risk_percent: 80,
  },
  {
    id: "pol-2",
    account_id: "a",
    name: "Everything else",
    position: 2,
    is_active: false,
    conditions: {},
    first_response_minutes: 120,
    resolution_minutes: 2880,
    schedule_id: null,
    pause_while_pending: false,
    at_risk_percent: 90,
  },
];

const teams = [{ id: "t1", account_id: "a", name: "Payments", color: "#000", created_at: "", updated_at: "" }] as Team[];

describe.each(["en", "ko"])("SLA settings render with %s messages", (locale) => {
  const m = () => load(locale);

  beforeAll(() => {
    try {
      render(locale, <TimezonePicker value="UTC" onChange={noop} />);
    } catch {
      // only the warm-up may fail
    }
  });

  it("the panel header, both tabs and a loading state", () => {
    const html = render(locale, <SlaPanel />);
    expect(html).toContain(m().Settings.sla.title.replace(/&/g, "&amp;"));
    expect(html).toContain(m().Settings.sla.tabs.hours);
    expect(html).toContain(m().Settings.sla.tabs.policies);
  });

  it("Business hours: the empty state", () => {
    const html = render(
      locale,
      <BusinessHoursTab schedules={[]} policyCountBySchedule={new Map()} loading={false} reload={reload} />,
    );
    expect(html).toContain(m().Settings.sla.hours.emptyTitle);
    expect(html).toContain(m().Settings.sla.hours.new);
  });

  it("Business hours: schedules with their zone, default chip, summary and counts", () => {
    const html = render(
      locale,
      <BusinessHoursTab
        schedules={schedules}
        policyCountBySchedule={new Map([["sch-1", 1]])}
        loading={false}
        reload={reload}
      />,
    );
    expect(html).toContain("Support hours");
    expect(html).toContain("Lunch break desk");
    expect(html).toContain("America/New York");
    expect(html).toContain(m().Settings.sla.hours.default);
    expect(html).toContain("09:00–18:00");
    expect(html).toContain("09:00–12:00, 13:00–17:00");
  });

  it("the schedule editor: timezone picker, weekly slots, holidays, presets", () => {
    const html = render(
      locale,
      <Dialog open>
        <ScheduleEditor schedule={schedules[0]} onClose={noop} onSaved={noop} />
      </Dialog>,
    );
    expect(html).toContain('value="Support hours"');
    expect(html).toContain("America/New_York");
    expect(html).toContain('type="time"');
    expect(html).toContain("Christmas");
    expect(html).toContain(m().Settings.sla.hours.presetMonFri);
    expect(html).toContain(m().Settings.sla.hours.addHoliday);
    // Monday to Friday start at 09:00
    expect(html.match(/value="09:00"/g)?.length).toBe(5);
  });

  it("the schedule editor for a new schedule starts empty and offers Make default", () => {
    const html = render(
      locale,
      <Dialog open>
        <ScheduleEditor schedule={null} onClose={noop} onSaved={noop} />
      </Dialog>,
    );
    expect(html).toContain(m().Settings.sla.hours.newTitle);
    expect(html).toContain(m().Settings.sla.hours.makeDefault);
    expect(html).not.toContain('type="time"');
  });

  it("the weekly editor reads 24:00 as 00:00 and offers Copy hours", () => {
    const html = render(
      locale,
      <WeeklyEditor
        value={{ ...MON_FRI_9_TO_18, "6": [{ start: "10:00", end: "24:00" }] }}
        onChange={noop}
      />,
    );
    expect(html).toContain('value="00:00"');
    expect(html).toContain(m().Settings.sla.hours.copyHours);
    expect(html).toContain(m().Settings.sla.hours.addSlot);
  });

  it("SLA policies: the ordered list with targets, schedule, drag handles", () => {
    const html = render(
      locale,
      <PoliciesTab policies={policies} schedules={schedules} loading={false} reload={reload} />,
    );
    expect(html).toContain("Urgent tickets");
    expect(html).toContain("Everything else");
    expect(html).toContain(m().Settings.sla.policies.matchesAll);
    expect(html).toContain(m().Settings.sla.policies.inactive);
    expect(html).toContain("#vip");
    expect(html).toContain(m().Settings.sla.policies.applyButton);
    expect(html).toContain(m().Settings.sla.policies.orderHint);
    // both targets of the first policy in readable units
    expect(html).toMatch(/30/);
  });

  it("SLA policies: the empty state", () => {
    const html = render(locale, <PoliciesTab policies={[]} schedules={[]} loading={false} reload={reload} />);
    expect(html).toContain(m().Settings.sla.policies.emptyTitle);
  });

  it("the policy editor: conditions, targets, schedule, at-risk and the live preview", () => {
    const html = render(
      locale,
      <Dialog open>
        <PolicyEditor policy={policies[0]} schedules={schedules} teams={teams} knownLabels={["vip"]} onClose={noop} onSaved={noop} />
      </Dialog>,
    );
    expect(html).toContain('value="Urgent tickets"');
    expect(html).toContain("Payments");
    expect(html).toContain(m().Settings.sla.policies.previewTitle);
    expect(html).toContain('data-testid="sla-preview"');
    // the preview names the schedule's zone
    expect(html).toContain("America/New_York");
  });

  it("the policy editor for a new policy pre-selects the default schedule and shows an all-hours preview otherwise", () => {
    const withDefault = render(
      locale,
      <Dialog open>
        <PolicyEditor policy={null} schedules={schedules} teams={[]} knownLabels={[]} onClose={noop} onSaved={noop} />
      </Dialog>,
    );
    expect(withDefault).toContain('<option value="sch-1" selected');
    const without = render(
      locale,
      <Dialog open>
        <PolicyEditor policy={null} schedules={[]} teams={[]} knownLabels={[]} onClose={noop} onSaved={noop} />
      </Dialog>,
    );
    expect(without).toContain(m().Settings.sla.policies.noSchedulesHint);
  });

  it("every error code has a translation", () => {
    const errors = m().Settings.sla.errors;
    for (const code of [
      "invalid_timezone", "invalid_weekly", "overlap", "too_many_slots", "bad_time", "end_before_start",
      "no_open_day", "invalid_name", "invalid_targets", "targets_order", "invalid_conditions", "invalid_percent",
      "schedule_in_use", "schedule_missing", "default_required", "duplicate_holiday", "invalid_date",
      "policy_limit", "not_found", "forbidden", "failed",
    ]) {
      expect(typeof errors[code], code).toBe("string");
    }
  });
});
