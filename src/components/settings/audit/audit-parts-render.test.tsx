import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../../messages/en.json";
import ko from "../../../../messages/ko.json";
import type { AuditEntry } from "@/lib/audit/types";

import { AuditActionBadge, AuditActor, AuditEntity, AuditSummary, AuditTime } from "./audit-parts";

// Server-render smoke tests with the real en / ko messages: they pin that
// every sentence the audit screens build resolves to real text (a missing
// key would render as a raw key path), not the styling.

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

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "1",
  createdAt: "2026-09-20T10:00:00.000Z",
  actor: { id: "u1", kind: "user", name: "Maya Lee" },
  action: "updated",
  entityType: "tag",
  entityId: "t1",
  entityLabel: "VIP gold",
  summary: null,
  entityExists: true,
  ...over,
});

describe("AuditSummary", () => {
  it("says what was renamed and recoloured", () => {
    const html = render(
      <AuditSummary
        action="updated"
        summary={{
          changes: { name: { from: "VIP", to: "VIP gold" }, color: { from: "#f00", to: "#0f0" } },
        }}
      />,
    );
    expect(html).toContain("renamed “VIP” to “VIP gold”");
    expect(html).toContain("color: “#f00” → “#0f0”");
  });

  it("names changed fields with their translated labels", () => {
    const html = render(
      <AuditSummary action="updated" summary={{ changed: ["content", "api_key", "some_new_column"] }} />,
    );
    expect(html).toContain("changed content, API key, some new column");
  });

  it("describes role, permission and invitation events", () => {
    expect(render(<AuditSummary action="role_changed" summary={{ from: "agent", to: "admin" }} />)).toContain(
      "Agent → Admin",
    );
    expect(
      render(<AuditSummary action="capability_changed" summary={{ capability: "audit.view", to: true }} />),
    ).toContain("turned on “View the audit log”");
    expect(render(<AuditSummary action="invited" summary={{ role: "viewer" }} />)).toContain("as Viewer");
  });

  it("uses plurals for what a tag deletion took with it", () => {
    const html = render(
      <AuditSummary action="deleted" summary={{ contacts_untagged: 1, conversations_unlabelled: 4 }} />,
    );
    expect(html).toContain("1 contact");
    expect(html).toContain("4 chats");
  });

  it("renders in Korean too", () => {
    const html = render(
      <AuditSummary action="updated" summary={{ changes: { name: { from: "VIP", to: "VIP 골드" } } }} />,
      "ko",
    );
    expect(html).toContain("이름 변경");
    expect(html).not.toContain("summary.");
  });

  it("renders nothing without details", () => {
    expect(render(<AuditSummary action="created" summary={null} />)).toBe("");
  });
});

describe("AuditActor", () => {
  it("shows a person's name with initials", () => {
    const html = render(<AuditActor actor={entry().actor} />);
    expect(html).toContain("Maya Lee");
    expect(html).toContain("ML");
  });

  it("shows a chip for system, automation and API actors", () => {
    expect(render(<AuditActor actor={{ id: null, kind: "system", name: "" }} />)).toContain("System");
    const html = render(<AuditActor actor={{ id: null, kind: "api", name: "Zapier" }} />);
    expect(html).toContain("API");
    expect(html).toContain("Zapier");
  });

  it("marks a person who has left", () => {
    expect(render(<AuditActor actor={{ id: "gone", kind: "user", name: "" }} />)).toContain("Former member");
  });
});

describe("AuditEntity", () => {
  it("links an item that still exists", () => {
    const html = render(<AuditEntity entry={entry({ entityType: "article", entityId: "a1", entityLabel: "Refunds" })} />);
    expect(html).toContain('href="/knowledge/a1"');
    expect(html).toContain("Article");
    expect(html).toContain("Refunds");
  });

  it("does not link, and strikes through, an item that is gone", () => {
    const html = render(<AuditEntity entry={entry({ entityExists: false })} />);
    expect(html).not.toContain("href=");
    expect(html).toContain("line-through");
  });
});

describe("AuditActionBadge and AuditTime", () => {
  it("labels every action", () => {
    expect(render(<AuditActionBadge action="restored" />)).toContain("Restored");
    expect(render(<AuditActionBadge action="team_member_added" />)).toContain("Added to team");
  });

  it("shows a relative time with the exact time as its tooltip", () => {
    const html = render(<AuditTime iso="2026-09-20T10:00:00.000Z" />);
    expect(html).toContain("2 hours ago");
    expect(html).toContain('title="Sep 20, 2026');
  });
});
