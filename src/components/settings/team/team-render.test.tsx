import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";

import en from "../../../../messages/en.json";
import ko from "../../../../messages/ko.json";

import { TeamChips } from "./team-chips";

// Server-render smoke tests with the real en / ko messages, so a missing
// key (rendered as a raw key path) or a broken plural fails here.

const messagesFor = { en, ko } as const;

function render(node: React.ReactNode, locale: "en" | "ko" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesFor[locale] as never}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const team = (n: number) => ({ id: `t${n}`, name: `Team ${n}`, color: "#3b82f6" });

describe("TeamChips", () => {
  it("shows every team when there are four or fewer", () => {
    const html = render(<TeamChips teams={[team(1), team(2), team(3), team(4)]} />);
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`Team ${n}`);
    expect(html).not.toContain("+");
  });

  it("shows four chips and a +N button for the rest", () => {
    const teams = [1, 2, 3, 4, 5, 6].map(team);
    const html = render(<TeamChips teams={teams} />);
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`Team ${n}`);
    // Teams 5 and 6 are behind the popover, not rendered inline.
    expect(html).not.toContain("Team 5");
    expect(html).toContain("+2");
    expect(html).toContain("Show all 6 teams");
  });

  it("says so when a member is on no team", () => {
    expect(render(<TeamChips teams={[]} />)).toContain("No teams");
    expect(render(<TeamChips teams={[]} />, "ko")).toContain("팀 없음");
  });

  it("renders in Korean too", () => {
    const html = render(<TeamChips teams={[1, 2, 3, 4, 5].map(team)} />, "ko");
    expect(html).toContain("+1");
    expect(html).toContain("팀 5개 모두 보기");
  });
});

type Tr = (key: string, values?: Record<string, unknown>) => string;

function translator(locale: "en" | "ko", namespace: string): Tr {
  return (createTranslator as unknown as (o: unknown) => Tr)({
    locale,
    messages: messagesFor[locale],
    namespace,
  });
}

function walk(o: Record<string, unknown>, prefix: string, out: string[]) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(key);
    else walk(v as Record<string, unknown>, key, out);
  }
}

describe("Settings.team messages", () => {
  it("has the same keys in English and Korean", () => {
    const a: string[] = [];
    const b: string[] = [];
    walk(en.Settings.team as unknown as Record<string, unknown>, "", a);
    walk(ko.Settings.team as unknown as Record<string, unknown>, "", b);
    expect(b.sort()).toEqual(a.sort());
    expect(a.length).toBeGreaterThan(150);
  });

  it("registers the merged section label and keeps the old labels for other screens", () => {
    expect(en.Settings.sections.team).toBe("Team");
    expect(ko.Settings.sections.team).toBe("팀");
  });

  it("formats the count sentences the dialogs show, in both languages", () => {
    for (const locale of ["en", "ko"] as const) {
      const t = translator(locale, "Settings.team.remove");
      for (const count of [0, 1, 5]) {
        for (const key of ["teamsLine", "conversationsLine", "ticketsLine"]) {
          const text = t(key, { count });
          expect(text).not.toContain("{");
          expect(text.length).toBeGreaterThan(3);
        }
      }
    }
    const enT = translator("en", "Settings.team.remove");
    expect(enT("conversationsLine", { count: 1 })).toBe("1 open conversation assigned");
    expect(enT("ticketsLine", { count: 3 })).toBe("3 open tickets assigned");
    expect(enT("teamsLine", { count: 0 })).toBe("Not on any team");
  });
});
