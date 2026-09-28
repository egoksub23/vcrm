import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Render smoke tests: every incident surface renders in English and Korean
// with its real translations (next-intl throws on a missing key/argument
// instead of showing a raw key path), and none of them crash on mount.
// Mirrors src/components/tickets/tickets-render.test.tsx and the
// supabase-client-stub pattern in access-gating-render.test.tsx (effects
// never run under renderToStaticMarkup, so the Proxy stub is never awaited).

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, {
    get: () => stub,
    apply: () => stub,
  });
  return { createClient: () => stub };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    accountId: "acc-1",
    user: { id: "u1" },
    accountRole: "admin",
    capabilities: new Set(["incidents.manage", "incidents.raise"]),
    capabilitiesLoading: false,
  }),
}));

vi.mock("@/hooks/use-can", () => ({
  useCapability: (cap: string) => cap === "incidents.manage" || cap === "incidents.raise",
}));

vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({
    members: [
      { id: "p1", user_id: "u1", full_name: "Ada Lovelace", email: "a@x.test", avatar_url: null, role: "agent" },
      { id: "p2", user_id: "u2", full_name: "Bo Chen", email: "b@x.test", avatar_url: null, role: "admin" },
    ],
    nameOf: (id: string | null | undefined, fallback = "Unassigned") =>
      ({ u1: "Ada Lovelace", u2: "Bo Chen" })[id ?? ""] ?? fallback,
    profileOf: (id: string | null | undefined) =>
      id === "u1"
        ? { id: "p1", user_id: "u1", full_name: "Ada Lovelace", email: "a@x.test", avatar_url: null, role: "agent" }
        : undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, back() {}, refresh() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "inc-1" }),
  usePathname: () => "/incidents",
}));

import type { Incident } from "@/lib/incidents/types";
import { IncidentListView } from "./incident-list-view";
import { IncidentBoard } from "./incident-board";
import { RaiseIncidentDialog } from "./raise-incident-dialog";
import { SeverityBadge, StatusLozenge, TypeChip, EscalationChip } from "./incident-visuals";
import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_TYPES } from "@/lib/incidents/constants";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      onError={(e: Error) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "inc-1",
  account_id: "acc-1",
  incident_number: 42,
  title: "Unusual outbound transfers after a device change",
  description: "Customer support flagged repeated device changes.",
  incident_type: "AT",
  incident_type_secondary: [],
  severity: "P2",
  severity_downgrade_reason: null,
  status: "reported",
  detected_at: "2026-09-28T00:00:00Z",
  detection_source: "customer",
  reporter_id: "u1",
  incident_lead_id: "u2",
  notifiable: null,
  notifiable_rationale: null,
  pdpa_relevant: null,
  aml_relevant: null,
  affected_systems: null,
  affected_identifiers: {},
  financial_impact_myr: null,
  customers_affected_count: null,
  merchants_affected_count: null,
  data_records_affected_count: null,
  downtime_minutes: null,
  contained_at: null,
  recovered_at: null,
  resumed_at: null,
  closed_at: null,
  root_cause: null,
  closed_by: null,
  pir_due_at: null,
  escalation_level: 1,
  escalation_level_entered_at: "2026-09-28T00:00:00Z",
  custom_fields: {},
  created_at: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
  ...over,
});

const rows = [
  incident({ id: "inc-1", incident_number: 1, severity: "P1", status: "reported" }),
  incident({ id: "inc-2", incident_number: 2, severity: "P3", status: "triaged", escalation_level: 2 }),
  incident({ id: "inc-3", incident_number: 3, severity: "P4", status: "closed", incident_lead_id: null }),
];

describe.each(["en", "ko"])("incident surfaces render (%s)", (locale) => {
  // The first component to call useTranslations in a process renders without
  // the provider's context (next-intl loads it lazily); a throwaway render
  // absorbs that so the real tests below see the same thing every time.
  // Mirrors tickets-render.test.tsx's identical warm-up.
  beforeAll(() => {
    try {
      render(locale, <StatusLozenge status="reported" />);
    } catch {
      // only the warm-up may fail
    }
  });

  it("IncidentListView", () => {
    expect(() => render(locale, <IncidentListView rows={rows} onOpen={() => {}} />)).not.toThrow();
  });

  it("IncidentBoard", () => {
    expect(() =>
      render(locale, <IncidentBoard rows={rows} canManage onOpen={() => {}} onMove={() => {}} />),
    ).not.toThrow();
  });

  it("RaiseIncidentDialog (open)", () => {
    expect(() =>
      render(locale, <RaiseIncidentDialog open onOpenChange={() => {}} />),
    ).not.toThrow();
  });

  it("every severity badge, status lozenge, type chip and escalation chip", () => {
    for (const s of INCIDENT_SEVERITIES) {
      expect(() => render(locale, <SeverityBadge severity={s} />)).not.toThrow();
    }
    for (const s of INCIDENT_STATUSES) {
      expect(() => render(locale, <StatusLozenge status={s} />)).not.toThrow();
    }
    for (const ty of INCIDENT_TYPES) {
      expect(() => render(locale, <TypeChip code={ty.code} />)).not.toThrow();
    }
    expect(() => render(locale, <EscalationChip level={2} />)).not.toThrow();
  });
});
