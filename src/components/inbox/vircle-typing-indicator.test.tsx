import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: () => {} }),
}));

import { VircleTypingIndicator } from "./vircle-typing-indicator";

describe("VircleTypingIndicator", () => {
  it("shows nothing until a typing signal arrives", () => {
    const html = renderToStaticMarkup(
      <VircleTypingIndicator conversationId="cv-1" lastCustomerMessageId="m-1" />,
    );
    expect(html).toBe("");
  });
});

describe("the typing line is translated", () => {
  it.each(["en", "ko", "ms", "zh"])("%s has Inbox.messageThread.vircleTyping", (locale) => {
    const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));
    expect(typeof messages.Inbox.messageThread.vircleTyping).toBe("string");
    expect(messages.Inbox.messageThread.vircleTyping.length).toBeGreaterThan(0);
  });
});
