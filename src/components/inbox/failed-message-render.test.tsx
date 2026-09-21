import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import type { Message } from "@/types";
import { failedMessagePatch, sendFailureToastValues } from "./send-failure";

// A message that did not go out renders as a red "Not sent" bubble: the
// friendly reason, the provider details behind an info button, and Resend /
// Delete for someone who may send. Server-rendered with the real messages.

const state = vi.hoisted(() => ({ caps: new Set<string>(["messages.send"]) }));

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useCapability: (cap: string) => state.caps.has(cap),
  };
});

import { MessageBubble } from "./message-bubble";

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

const failed = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  conversation_id: "c1",
  sender_type: "agent",
  content_type: "text",
  content_text: "Hello there",
  channel_type: "whatsapp",
  status: "failed",
  created_at: "2026-09-21T10:00:00.000Z",
  error_code: 131030,
  error_title: "Recipient phone number not in allowed list",
  error_details: null,
  ...over,
});

const noop = () => {};

describe("MessageBubble — a failed outbound message", () => {
  it("shows Not sent, the friendly reason and what to do, with Resend and Delete", () => {
    const html = render(<MessageBubble message={failed()} onResend={noop} onDeleteFailed={noop} />);
    expect(html).toContain("Not sent");
    expect(html).toContain("This number is not on your WhatsApp test number&#x27;s allowed list.");
    expect(html).toContain("Add it in Meta, or use a production number.");
    expect(html).toContain('data-testid="failed-message-resend"');
    expect(html).toContain("Resend");
    expect(html).toContain('data-testid="failed-message-delete"');
    expect(html).toContain("Delete");
    // Red state on the bubble itself, and the message text is still there.
    expect(html).toContain("ring-red-500");
    expect(html).toContain("Hello there");
  });

  it("has an info button for the provider details", () => {
    const html = render(<MessageBubble message={failed()} onResend={noop} onDeleteFailed={noop} />);
    expect(html).toContain('aria-label="Why it failed"');
  });

  it("a closed WhatsApp window says to send a template", () => {
    const html = render(
      <MessageBubble
        message={failed({ error_code: 131047, error_title: "Re-engagement message" })}
        onResend={noop}
        onDeleteFailed={noop}
      />,
    );
    expect(html).toContain("The 24-hour window has closed.");
    expect(html).toContain("template");
  });

  it("an unknown code falls back to the provider's own title and the code", () => {
    const html = render(
      <MessageBubble
        message={failed({ error_code: 999123, error_title: "Something odd happened" })}
        onResend={noop}
      />,
    );
    expect(html).toContain("Something odd happened (999123)");
  });

  it("a failure with no recorded reason still says Not sent", () => {
    const html = render(
      <MessageBubble
        message={failed({ error_code: null, error_title: null, error_details: null })}
        onDeleteFailed={noop}
      />,
    );
    expect(html).toContain("Not sent");
    expect(html).toContain("no reason was reported");
    expect(html).not.toContain('aria-label="Why it failed"');
  });

  it("a bubble that was never saved offers Delete only (nothing to resend)", () => {
    const html = render(<MessageBubble message={failed({ id: "temp-1" })} onDeleteFailed={noop} />);
    expect(html).toContain('data-testid="failed-message-delete"');
    expect(html).not.toContain('data-testid="failed-message-resend"');
  });

  it("shows the spinner state while a resend is in flight and disables both buttons", () => {
    const html = render(
      <MessageBubble message={failed()} onResend={noop} onDeleteFailed={noop} resending />,
    );
    expect(html).toContain("Resending...");
    expect(html.match(/ disabled=""/g)?.length).toBe(2);
  });

  it("disables Resend and Delete for someone without messages.send", () => {
    state.caps = new Set();
    try {
      const html = render(<MessageBubble message={failed()} onResend={noop} onDeleteFailed={noop} />);
      expect(html.match(/ disabled=""/g)?.length).toBe(2);
      expect(html).toContain("Read-only");
    } finally {
      state.caps = new Set(["messages.send"]);
    }
  });

  it("renders a failed email in its card with the same notice", () => {
    const html = render(
      <MessageBubble
        message={failed({
          channel_type: "email",
          content_html: "<p>Hi</p>",
          error_code: 401,
          error_title: "Token expired",
        })}
        onResend={noop}
        onDeleteFailed={noop}
      />,
    );
    expect(html).toContain("border-red-500/50");
    expect(html).toContain("The connection has expired.");
    expect(html).toContain("Resend");
  });

  it("Messenger's closed window does not talk about templates", () => {
    const html = render(
      <MessageBubble
        message={failed({
          channel_type: "messenger",
          error_code: 10,
          error_title: "This message is sent outside of allowed window.",
        })}
        onResend={noop}
      />,
    );
    expect(html).toContain("The messaging window for this customer has closed.");
    expect(html).not.toContain("approved template");
  });

  it("does not show the panel for a message that went out, or one from the customer", () => {
    expect(render(<MessageBubble message={failed({ status: "sent" })} />)).not.toContain("Not sent");
    expect(
      render(<MessageBubble message={failed({ sender_type: "customer" })} onResend={noop} />),
    ).not.toContain("Not sent");
  });

  it("speaks Korean for a Korean user", () => {
    const html = render(
      <MessageBubble message={failed()} onResend={noop} onDeleteFailed={noop} />,
      "ko",
    );
    expect(html).toContain("전송 안 됨");
    expect(html).toContain("다시 보내기");
    expect(html).toContain("WhatsApp 테스트 번호의 허용 목록에 없는 번호입니다.");
  });
});

describe("send failure helpers", () => {
  it("adopts the saved message's id and reason on the optimistic bubble", () => {
    expect(
      failedMessagePatch({
        failed_message_id: "real-1",
        failure: { code: 131030, title: "Not allowed", details: "d" },
      }),
    ).toEqual({
      status: "failed",
      id: "real-1",
      error_code: 131030,
      error_title: "Not allowed",
      error_details: "d",
    });
  });

  it("just marks it failed when nothing was saved (validation error, network)", () => {
    expect(failedMessagePatch({ error: "bad request" })).toEqual({ status: "failed" });
    expect(failedMessagePatch(null)).toEqual({ status: "failed" });
  });

  it("only produces toast values when the server named a reason", () => {
    expect(sendFailureToastValues({ error: "x" })).toBeNull();
    expect(sendFailureToastValues({ failure: { code: 190, title: "T", details: null } })).toEqual({
      code: 190,
      title: "T",
      details: null,
    });
  });
});
