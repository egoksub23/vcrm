import { describe, expect, it } from "vitest";

import { buildRawMessage } from "./mime";

// The message Doc Sign sends through a connected Gmail mailbox: who it is from, its marks, its files, and nothing a stranger's name can add.

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");
const headOf = (raw: string) => decode(raw).split("\r\n\r\n")[0];

describe("buildRawMessage as the mailbox", () => {
  it("writes From, Reply-To and the extra headers, before the body", () => {
    const head = headOf(
      buildRawMessage({ toAddress: "ali@example.com", subject: "Please sign", text: "t", html: "<p>t</p>", fromAddress: "support@vircle.com", fromName: "Vircle Sdn. Bhd.", replyTo: "help@vircle.com", headers: { "X-Halo-Sign": "1", "Auto-Submitted": "auto-generated" } }),
    );
    expect(head).toContain('From: "Vircle Sdn. Bhd." <support@vircle.com>');
    expect(head).toContain("To: ali@example.com");
    expect(head).toContain("Reply-To: help@vircle.com");
    expect(head).toContain("X-Halo-Sign: 1");
    expect(head).toContain("Auto-Submitted: auto-generated");
  });

  it("encodes a name that is not ASCII (a Chinese or Korean workspace name) and keeps the address plain", () => {
    const head = headOf(buildRawMessage({ toAddress: "a@b.com", subject: "s", text: "t", fromAddress: "support@vircle.com", fromName: "维尔克" }));
    expect(head).toMatch(/From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <support@vircle\.com>/);
  });

  it("writes no From when there is no address (the composer's own sends are unchanged)", () => {
    expect(headOf(buildRawMessage({ toAddress: "a@b.com", subject: "s", text: "t" }))).not.toMatch(/^From:/m);
  });

  it("cannot be made to add a header: line breaks in a name, subject, address or header value are flattened", () => {
    const raw = buildRawMessage({
      toAddress: "a@b.com\r\nBcc: spy@evil.com",
      subject: "Hi\r\nBcc: spy@evil.com",
      text: "t",
      fromAddress: "support@vircle.com",
      fromName: 'Vircle"\r\nBcc: spy@evil.com',
      replyTo: "x@y.com\r\nBcc: spy@evil.com",
      headers: { "X-Halo-Sign": "1\r\nBcc: spy@evil.com", "Bad Name\r\nBcc": "x" },
    });
    const head = headOf(raw);
    expect(head.split("\r\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(head).not.toContain("Bad Name");
  });

  it("sends every file, in order, as wrapped base64, with a name that cannot break out of its quotes", () => {
    const big = Buffer.alloc(300, 7).toString("base64");
    const text = decode(
      buildRawMessage({
        toAddress: "a@b.com",
        subject: "s",
        text: "t",
        html: "<p>t</p>",
        attachment: { name: "first.pdf", contentType: "application/pdf", contentBytesBase64: big },
        attachments: [
          { name: 'second "signed".pdf', contentType: "application/pdf", contentBytesBase64: "BBBB" },
          { name: "合同.pdf", contentType: "application/pdf", contentBytesBase64: "CCCC" },
        ],
      }),
    );
    expect(text).toContain('Content-Disposition: attachment; filename="first.pdf"');
    expect(text).toContain('filename="second _signed_.pdf"');
    expect(text).toMatch(/filename="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="/);
    expect(text.indexOf("first.pdf")).toBeLessThan(text.indexOf("second"));
    for (const line of text.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const encodedLines = text.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    expect(encodedLines.length).toBeGreaterThan(1);
    for (const l of encodedLines) expect(l.length).toBeLessThanOrEqual(76);
  });

  it("sends non-ASCII text as base64 that reads back unchanged, and plain ASCII as it is", () => {
    const korean = "서명해 주세요. 감사합니다";
    const raw = decode(buildRawMessage({ toAddress: "a@b.com", subject: "s", text: korean, html: `<p>${korean}</p>` }));
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const parts = raw.split(/--alt_[^\r\n]+/).filter((p) => p.includes("base64"));
    const body = parts[0].split("\r\n\r\n")[1].replace(/\s+/g, "");
    expect(Buffer.from(body, "base64").toString("utf-8")).toBe(korean);

    const plain = decode(buildRawMessage({ toAddress: "a@b.com", subject: "s", text: "hello" }));
    expect(plain).not.toContain("Content-Transfer-Encoding");
    expect(plain.endsWith("\r\n\r\nhello")).toBe(true);
  });
});
