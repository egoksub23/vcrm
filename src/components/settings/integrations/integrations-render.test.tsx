import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../../messages/en.json";
import ko from "../../../../messages/ko.json";
import { DEFAULT_JIRA_SETTINGS, type JiraConnectionRow, type JiraSettings } from "@/lib/jira/types";

import type { JiraDiagnostics, JiraPeopleData } from "./jira-api";
import { JiraConnectionCard } from "./jira-connection-card";
import { JiraDiagnosticsTab } from "./jira-diagnostics-tab";
import { JiraDirectionTab } from "./jira-direction-tab";
import { JiraMappingTab } from "./jira-mapping-tab";
import { JiraPeopleTab } from "./jira-people-tab";
import { JiraProjectsTab } from "./jira-projects-tab";
import { JiraSitePicker } from "./jira-site-picker";

// Server-render smoke tests with the real en / ko messages (they THROW on any
// missing key or broken ICU), so every sentence the Jira settings screens build
// is pinned to real text, not the styling. The Settings.jira messages are
// inserted into messages/*.json from the fragment file.

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

function connection(over: Partial<JiraConnectionRow> = {}): JiraConnectionRow {
  return {
    id: "c1",
    account_id: "a1",
    cloud_id: "11111111-2222-3333-4444-555555555555",
    site_url: "https://acme.atlassian.net",
    site_name: "Acme Jira",
    connected_by: "u1",
    jira_account_id: "jira-1",
    jira_display_name: "Vircle Integration",
    status: "active",
    status_reason: null,
    token_expires_at: "2026-09-20T13:00:00.000Z",
    webhook_ids: [1],
    webhook_expires_at: "2026-10-10T00:00:00.000Z",
    webhook_checked_at: "2026-09-20T11:00:00.000Z",
    last_catchup_at: "2026-09-20T11:55:00.000Z",
    last_report_at: null,
    settings: DEFAULT_JIRA_SETTINGS,
    rate_limit: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...over,
  };
}

const counts = { links: 3, paused: 1, broken: 0 };

describe("Settings.jira messages", () => {
  it("exist in both languages with the same keys", () => {
    const keys = (o: unknown, prefix = ""): string[] =>
      typeof o === "object" && o !== null
        ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
        : [prefix];
    const jira = (m: unknown) => (m as { Settings: { jira: unknown } }).Settings.jira;
    const enKeys = keys(jira(en)).sort();
    const koKeys = keys(jira(ko)).sort();
    expect(enKeys.length).toBeGreaterThan(200);
    expect(koKeys).toEqual(enKeys);
  });
});

describe("JiraConnectionCard", () => {
  it("explains the operator setup when the server has no Jira app", () => {
    const html = render(
      <JiraConnectionCard
        configured={false}
        callbackUrl="https://crm.example.com/api/integrations/jira/callback"
        connection={null}
        counts={{ links: 0, paused: 0, broken: 0 }}
        onConnect={noop}
        onDisconnect={async () => true}
      />,
    );
    expect(html).toContain("Jira is not set up on this server");
    expect(html).toContain("JIRA_CLIENT_ID");
    expect(html).toContain("docs/jira-setup.md");
    expect(html).not.toContain("Connect Jira</button>");
  });

  it("offers Connect Jira with the admin setup help when not connected", () => {
    const html = render(
      <JiraConnectionCard
        configured
        callbackUrl="https://crm.example.com/api/integrations/jira/callback"
        connection={null}
        counts={{ links: 0, paused: 0, broken: 0 }}
        onConnect={noop}
        onDisconnect={async () => true}
      />,
    );
    expect(html).toContain("Connect Jira");
    expect(html).toContain("Setup help for a Jira admin");
    expect(html).toContain("Vircle Integration");
    expect(html).toContain("Apps and Connected apps");
    expect(html).toContain("https://crm.example.com/api/integrations/jira/callback");
    expect(html).toContain("never deletes anything in Jira");
  });

  it("shows the connected site and, when the sign-in broke, the reconnect banner", () => {
    const html = render(
      <JiraConnectionCard
        configured
        callbackUrl="https://crm.example.com/api/integrations/jira/callback"
        connection={connection({ status: "reauth_required", status_reason: "refresh_token_revoked" })}
        counts={counts}
        onConnect={noop}
        onDisconnect={async () => true}
      />,
    );
    expect(html).toContain("Acme Jira");
    expect(html).toContain("https://acme.atlassian.net");
    expect(html).toContain("Needs reconnect");
    expect(html).toContain("refresh_token_revoked");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Vircle Integration");
    expect(html).toContain("3 linked issues · 1 paused · 0 broken");
  });

  it("shows a healthy connection as Connected", () => {
    const html = render(
      <JiraConnectionCard
        configured
        callbackUrl=""
        connection={connection()}
        counts={{ links: 1, paused: 0, broken: 0 }}
        onConnect={noop}
        onDisconnect={async () => true}
      />,
    );
    expect(html).toContain("Connected");
    expect(html).not.toContain("Needs reconnect");
    expect(html).toContain("1 linked issue ·");
  });

  it("renders every state in Korean", () => {
    for (const c of [null, connection({ status: "reauth_required", status_reason: "x" })]) {
      const html = render(
        <JiraConnectionCard configured callbackUrl="https://x/cb" connection={c} counts={counts} onConnect={noop} onDisconnect={async () => true} />,
        "ko",
      );
      expect(html).toContain("Jira");
      expect(html).not.toContain("Settings.jira");
    }
    const unconfigured = render(
      <JiraConnectionCard configured={false} callbackUrl="" connection={null} counts={counts} onConnect={noop} onDisconnect={async () => true} />,
      "ko",
    );
    expect(unconfigured).toContain("이 서버에는 Jira가 설정되어 있지 않습니다");
  });
});

describe("JiraSitePicker", () => {
  const sites = [
    { id: "s1", name: "Acme", url: "https://acme.atlassian.net" },
    { id: "s2", name: "Acme Labs", url: "https://labs.atlassian.net" },
  ];

  it("lists the sites to choose from", () => {
    for (const locale of both) {
      const html = render(<JiraSitePicker sites={sites} error={null} busy={false} onPick={noop} onCancel={noop} />, locale);
      expect(html).toContain("Acme Labs");
      expect(html).toContain("https://labs.atlassian.net");
      expect(html).not.toContain("Settings.jira");
    }
  });

  it("renders the loading, empty and error states", () => {
    expect(render(<JiraSitePicker sites={null} error={null} busy={false} onPick={noop} onCancel={noop} />)).toContain("Loading your Jira sites");
    expect(render(<JiraSitePicker sites={[]} error={null} busy={false} onPick={noop} onCancel={noop} />)).toContain("No Jira sites were found");
    expect(render(<JiraSitePicker sites={null} error="This sign-in expired." busy={false} onPick={noop} onCancel={noop} />)).toContain("This sign-in expired.");
  });
});

describe("JiraProjectsTab", () => {
  const projects = [
    { id: "1", key: "ENG", name: "Engineering" },
    { id: "2", key: "SUP", name: "Support" },
  ];

  it("shows the allowed projects, the search list and the defaults", () => {
    for (const locale of both) {
      const html = render(
        <JiraProjectsTab
          value={{ allowed: ["ENG"], default_project: "ENG", default_issue_type: "Bug" }}
          projects={projects}
          projectsError={null}
          issueTypes={[{ id: "10", name: "Bug" }, { id: "11", name: "Task" }]}
          issueTypesError={null}
          onChange={noop}
          onRetryProjects={noop}
          onRetryIssueTypes={noop}
        />,
        locale,
      );
      expect(html).toContain("ENG");
      expect(html).toContain("Support");
      expect(html).toContain("Task");
      expect(html).not.toContain("Settings.jira");
    }
  });

  it("says every project is allowed when nothing is selected, and shows load problems", () => {
    const html = render(
      <JiraProjectsTab
        value={DEFAULT_JIRA_SETTINGS.projects}
        projects={null}
        projectsError="Jira is not reachable right now."
        issueTypes={null}
        issueTypesError={null}
        onChange={noop}
        onRetryProjects={noop}
        onRetryIssueTypes={noop}
      />,
    );
    expect(html).toContain("Every project the connecting user can see");
    expect(html).toContain("Jira is not reachable right now.");
    expect(html).toContain("Choose a default project");
  });
});

describe("JiraMappingTab", () => {
  const mapping: JiraSettings["mapping"] = {
    priority: { urgent: "Highest" },
    status_from_jira: { "in review": "pending" },
    status_to_jira: { pending: "Waiting" },
    category_label: true,
  };

  it("shows priorities, status defaults and overrides, and the Done choice", () => {
    for (const locale of both) {
      const html = render(
        <JiraMappingTab
          mapping={mapping}
          doneBehaviour="note"
          priorities={[{ id: "1", name: "Highest" }, { id: "2", name: "Low" }]}
          prioritiesError={null}
          projects={[{ id: "1", key: "ENG", name: "Engineering" }]}
          statusProject="ENG"
          statuses={[{ id: "5", name: "In Review", category: "indeterminate" }]}
          statusesError={null}
          onPriorityChange={noop}
          onCategoryLabelChange={noop}
          onDoneBehaviourChange={noop}
          onStatusProjectChange={noop}
          onSaveStatuses={noop}
          onRetryPriorities={noop}
          onRetryStatuses={noop}
        />,
        locale,
      );
      expect(html).toContain("Highest");
      expect(html).toContain("in review");
      expect(html).toContain("Waiting");
      expect(html).toContain("In Review");
      expect(html).not.toContain("Settings.jira");
    }
    const enHtml = render(
      <JiraMappingTab
        mapping={mapping}
        doneBehaviour="resolve"
        priorities={null}
        prioritiesError="Jira is not reachable right now."
        projects={null}
        statusProject=""
        statuses={null}
        statusesError={null}
        onPriorityChange={noop}
        onCategoryLabelChange={noop}
        onDoneBehaviourChange={noop}
        onStatusProjectChange={noop}
        onSaveStatuses={noop}
        onRetryPriorities={noop}
        onRetryStatuses={noop}
      />,
    );
    expect(enHtml).toContain("Pending and Closed have no Jira twin");
    expect(enHtml).toContain("Jira default");
    expect(enHtml).toContain("Set the ticket to Resolved");
  });
});

describe("JiraDirectionTab", () => {
  function tab(locale: "en" | "ko", canManageRoles: boolean) {
    return render(
      <JiraDirectionTab
        direction={DEFAULT_JIRA_SETTINGS.direction}
        privacy={DEFAULT_JIRA_SETTINGS.privacy}
        personalDataReport
        canManageRoles={canManageRoles}
        onDirectionChange={noop}
        onPrivacyChange={noop}
        onPersonalDataReportChange={noop}
      />,
      locale,
    );
  }

  it("lists the direction switches, privacy, the report and access", () => {
    const html = tab("en", true);
    expect(html).toContain("Comments to Jira");
    expect(html).toContain("Status to Jira");
    expect(html).toContain("Include customer name and email in issues");
    expect(html).toContain("data region");
    expect(html).toContain("Preview before sending");
    expect(html).toContain("Weekly personal data report");
    expect(html).toContain("Default: off");
    expect(html).toContain("Viewers can never be given these permissions.");
    expect(html).toContain('href="/settings?tab=roles"');
  });

  it("does not link to Roles & permissions without roles.manage", () => {
    const html = tab("en", false);
    expect(html).not.toContain('href="/settings?tab=roles"');
    expect(html).toContain("ask someone who can manage roles");
  });

  it("renders in Korean", () => {
    const html = tab("ko", true);
    expect(html).toContain("Jira로 댓글 보내기");
    expect(html).not.toContain("Settings.jira");
  });
});

describe("JiraPeopleTab", () => {
  const data = (canManageAll: boolean): JiraPeopleData => ({
    canManageAll,
    members: [
      { userId: "u1", name: "Maya Lee", email: "maya@acme.test", match: { jiraAccountId: "j1", displayName: "Maya L.", method: "email" } },
      { userId: "u2", name: "Sam Park", email: null, match: null },
    ],
  });

  function tab(d: JiraPeopleData | null, locale: "en" | "ko" = "en", error: string | null = null) {
    return render(
      <JiraPeopleTab
        data={d}
        error={error}
        currentUserId="u2"
        autoMatching={false}
        busyUserId={null}
        onAutoMatch={noop}
        onPick={noop}
        onClear={noop}
        onSearch={async () => []}
        onRetry={noop}
      />,
      locale,
    );
  }

  it("shows the members with their Jira match and the auto-match button", () => {
    const html = tab(data(true));
    expect(html).toContain("Maya Lee");
    expect(html).toContain("Maya L.");
    expect(html).toContain("matched by email");
    expect(html).toContain("Not matched");
    expect(html).toContain("1 of 2 members matched");
    expect(html).toContain("Auto-match by email");
    expect(html).toContain("Clear");
  });

  it("hides auto-match for someone who can only set their own row", () => {
    const html = tab(data(false));
    expect(html).not.toContain("Auto-match by email");
    expect(html).toContain("(you)");
  });

  it("renders loading, error and Korean", () => {
    expect(tab(null)).toContain("Loading");
    expect(tab(null, "en", "Jira is not connected yet.")).toContain("Jira is not connected yet.");
    const ko = tab(data(true), "ko");
    expect(ko).toContain("이메일로 자동 매칭");
    expect(ko).not.toContain("Settings.jira");
  });
});

describe("JiraDiagnosticsTab", () => {
  const diagnostics: JiraDiagnostics = {
    connection: { status: "active", statusReason: null, siteName: "Acme Jira" },
    tokenExpiresAt: "2026-09-20T13:00:00.000Z",
    lastCatchupAt: "2026-09-20T11:55:00.000Z",
    lastReportAt: null,
    rateLimit: { reason: "jira-burst-based", remaining: 12, limit: 100, reset: null, at: "2026-09-20T11:00:00.000Z" },
    webhook: {
      registered: true,
      count: 2,
      expiresAt: "2026-10-10T00:00:00.000Z",
      checkedAt: "2026-09-20T11:00:00.000Z",
      lastDeliveryAt: null,
    },
    queue: { pending: 2, running: 1, dead: 1 },
    links: { ok: 5, paused: 1, broken: 1 },
    failures: [
      { linkId: "l1", key: "ENG-1", state: "broken", error: "not_found" },
      { linkId: "l2", key: "ENG-2", state: "paused", error: null },
    ],
    events: [{ id: "e1", level: "warn", kind: "webhook.late", message: "No webhook for 3 hours", link_id: null, created_at: "2026-09-20T11:00:00.000Z" }],
    deadJobs: [{ id: "d1", kind: "push_status", attempts: 5, last_error: "transition_unavailable", finished_at: "2026-09-20T10:00:00.000Z" }],
  };

  function tab(data: JiraDiagnostics | null, locale: "en" | "ko" = "en", error: string | null = null) {
    return render(
      <JiraDiagnosticsTab
        data={data}
        error={error}
        refreshing={false}
        action={null}
        onRefresh={vi.fn()}
        onRegisterWebhooks={vi.fn()}
        onCatchup={vi.fn()}
      />,
      locale,
    );
  }

  it("renders health, webhooks, queue, links, failures, events and dead jobs", () => {
    for (const locale of both) {
      const html = tab(diagnostics, locale);
      expect(html).toContain("ENG-1");
      expect(html).toContain("push_status");
      expect(html).toContain("webhook.late");
      expect(html).toContain("jira-burst-based");
      expect(html).not.toContain("Settings.jira");
    }
    const html = tab(diagnostics);
    expect(html).toContain("2 webhooks registered");
    expect(html).toContain("Re-register webhooks");
    expect(html).toContain("Run catch-up now");
    expect(html).toContain("within about five minutes");
    expect(html).toContain("The issue no longer exists in Jira.");
    expect(html).toContain("5 attempts");
  });

  it("always shows the what-to-check-first cheat sheet", () => {
    for (const locale of both) {
      const html = tab(null, locale);
      expect(html).toContain("<table");
      expect(html).not.toContain("Settings.jira");
    }
    expect(tab(null)).toContain("organisation blocks user-installed apps");
  });

  it("handles a reauth connection, no webhooks, a load error and no connection", () => {
    const broken: JiraDiagnostics = {
      ...diagnostics,
      connection: { status: "reauth_required", statusReason: "invalid_grant", siteName: null },
      webhook: { registered: false, count: 0, expiresAt: null, checkedAt: null, lastDeliveryAt: null },
      rateLimit: null,
      failures: [],
      events: [],
      deadJobs: [],
    };
    const html = tab(broken);
    expect(html).toContain("invalid_grant");
    expect(html).toContain("No webhook registered");
    expect(html).toContain("No failed jobs.");
    expect(tab(null, "en", "Jira is not reachable right now.")).toContain("Jira is not reachable right now.");
    expect(tab({ connection: null })).toContain("Jira is not connected.");
  });
});
