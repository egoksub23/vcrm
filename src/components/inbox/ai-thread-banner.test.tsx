import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import ms from "../../../messages/ms.json";
import zh from "../../../messages/zh.json";

// The banner starts its AI-status fetch in an effect, which static rendering never runs, so these tests
// pin the branch that is chosen once auto-reply is known to be on (effects are replaced by an immediate set).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((initial: unknown) => (initial === null ? [true, () => undefined] : actual.useState(initial))) as typeof actual.useState,
  };
});
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a1" }) }));
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));

import { AiThreadBanner } from "./ai-thread-banner";

const messages = { en, ko, ms, zh } as const;
function render(props: Partial<React.ComponentProps<typeof AiThreadBanner>>, locale: keyof typeof messages = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale] as never}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      <AiThreadBanner conversationId="c1" disabled={false} currentUserId="me" {...props} />
    </NextIntlClientProvider>,
  );
}

describe("AiThreadBanner: a human owner always wins", () => {
  it("while the bot is free and nobody owns the chat, it says the AI is replying and offers Take over", () => {
    const html = render({ assignedAgentId: null });
    expect(html).toContain("AI assistant is replying automatically");
    expect(html).toContain("Take over");
    expect(html).not.toContain("Hand back to AI");
  });

  it("when the chat is assigned to the viewer, it says the AI is not replying and offers Hand back to AI", () => {
    const html = render({ assignedAgentId: "me" });
    expect(html).toContain("assigned to you, so the AI assistant is not replying");
    expect(html).toContain("Hand back to AI");
    expect(html).not.toContain("replying automatically");
  });

  it("when the chat is assigned to a teammate, it says so and still offers the way back", () => {
    const html = render({ assignedAgentId: "someone-else" });
    expect(html).toContain("assigned to a teammate");
    expect(html).toContain("Hand back to AI");
  });

  it("when the bot was paused (a handoff), it keeps the existing Resume AI banner", () => {
    const html = render({ disabled: true, assignedAgentId: null, handoffSummary: "Customer wants a refund" });
    expect(html).toContain("AI assistant is paused here");
    expect(html).toContain("Resume AI");
    expect(html).toContain("Customer wants a refund");
  });

  it("has every string in Korean, Malay and Chinese (no raw key paths)", () => {
    for (const locale of ["ko", "ms", "zh"] as const) {
      const html = render({ assignedAgentId: "me" }, locale);
      expect(html).not.toContain("aiBanner");
      expect(html).not.toContain("handBack");
    }
  });
});
