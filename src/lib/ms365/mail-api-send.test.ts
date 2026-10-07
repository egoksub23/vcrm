/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are read loosely in a test */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphApiError } from "./errors";
import { getMessage, sendNewMail } from "./mail-api";

// The Graph call Doc Sign mail goes through: what sendMail is asked, and how a throttled answer is read.

afterEach(() => vi.unstubAllGlobals());

function stubFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : {} });
      return respond(url, init);
    }),
  );
  return calls;
}

describe("sendNewMail", () => {
  it("asks for sendMail with the sender, reply-to, headers and every file, and without a copy in Sent Items when told so", async () => {
    const calls = stubFetch(() => new Response(null, { status: 202 }));
    await sendNewMail({
      accessToken: "tok",
      toAddress: "ali@example.com",
      subject: "Please sign",
      text: "hi",
      html: "<p>hi</p>",
      attachments: [
        { name: "a.pdf", contentType: "application/pdf", contentBytesBase64: "AAAA" },
        { name: "b.pdf", contentType: "application/pdf", contentBytesBase64: "BBBB" },
      ],
      fromAddress: "support@vircle.com",
      fromName: "Vircle",
      replyTo: "help@vircle.com",
      headers: { "X-Halo-Sign": "1" },
      saveToSentItems: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    const { message, saveToSentItems } = calls[0].body;
    expect(saveToSentItems).toBe(false);
    expect(message.subject).toBe("Please sign");
    expect(message.body).toEqual({ contentType: "HTML", content: "<p>hi</p>" });
    expect(message.toRecipients).toEqual([{ emailAddress: { address: "ali@example.com" } }]);
    expect(message.from).toEqual({ emailAddress: { address: "support@vircle.com", name: "Vircle" } });
    expect(message.replyTo).toEqual([{ emailAddress: { address: "help@vircle.com" } }]);
    expect(message.internetMessageHeaders).toEqual([{ name: "X-Halo-Sign", value: "1" }]);
    expect(message.attachments.map((a: any) => [a["@odata.type"], a.name, a.contentBytes])).toEqual([
      ["#microsoft.graph.fileAttachment", "a.pdf", "AAAA"],
      ["#microsoft.graph.fileAttachment", "b.pdf", "BBBB"],
    ]);
  });

  it("keeps what the inbox composer relies on: a copy in Sent Items, no from, no headers, one attachment", async () => {
    const calls = stubFetch(() => new Response(null, { status: 202 }));
    await sendNewMail({ accessToken: "tok", toAddress: "a@b.com", subject: "s", text: "plain", attachment: { name: "x.pdf", contentType: "application/pdf", contentBytesBase64: "AA" } });
    const { message, saveToSentItems } = calls[0].body;
    expect(saveToSentItems).toBe(true);
    expect(message.body).toEqual({ contentType: "Text", content: "plain" });
    expect(message).not.toHaveProperty("from");
    expect(message).not.toHaveProperty("replyTo");
    expect(message).not.toHaveProperty("internetMessageHeaders");
    expect(message.attachments).toHaveLength(1);
  });

  it("reads Retry-After and Graph's error code off a throttled answer", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: "TooManyRequests", message: "Too many requests" } }), { status: 429, headers: { "Retry-After": "11", "Content-Type": "application/json" } }));
    const err = (await sendNewMail({ accessToken: "t", toAddress: "a@b.com", subject: "s", text: "x" }).then(
      () => null,
      (e: unknown) => e,
    )) as GraphApiError;
    expect(err).toBeInstanceOf(GraphApiError);
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe("TooManyRequests");
    expect(err.retryAfterSeconds).toBe(11);
  });
});

describe("getMessage", () => {
  it("asks Graph for the sender and the internet message headers, and returns them", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "m1",
            subject: "Hello",
            from: { emailAddress: { address: "ali@example.com", name: "Ali" } },
            sender: { emailAddress: { address: "ali@example.com" } },
            body: { contentType: "text", content: "hi" },
            receivedDateTime: "2026-10-07T01:00:00Z",
            internetMessageHeaders: [{ name: "X-Halo-Sign", value: "1" }, { value: "no name" }],
          }),
          { status: 200 },
        ),
    );
    const m = await getMessage({ accessToken: "t", messageId: "m1" });
    expect(decodeURIComponent(calls[0].url)).toContain("internetMessageHeaders");
    expect(decodeURIComponent(calls[0].url)).toContain("sender");
    expect(m.senderAddress).toBe("ali@example.com");
    expect(m.headers).toEqual([{ name: "X-Halo-Sign", value: "1" }]);
  });
});
