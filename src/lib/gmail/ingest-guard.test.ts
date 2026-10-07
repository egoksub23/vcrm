import { describe, expect, it } from "vitest";

import { buildRawMessage } from "./mime";
import { decideIngest, isHaloSignMessage } from "./ingest-guard";
import type { GmailPayloadPart } from "./mime";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

/** What Gmail's API returns for a message whose raw form is `raw` (only the headers matter here). */
function payloadOf(raw: string): GmailPayloadPart {
  const text = Buffer.from(raw, "base64url").toString("utf-8");
  const head = text.split("\r\n\r\n")[0];
  const headers = head.split("\r\n").flatMap((line) => {
    const i = line.indexOf(":");
    return i > 0 ? [{ name: line.slice(0, i), value: line.slice(i + 1).trim() }] : [];
  });
  return { mimeType: "multipart/alternative", headers, parts: [{ mimeType: "text/plain", body: { data: b64("hi") } }] };
}

describe("a message Secure Sign sent", () => {
  it("is recognised by its header, whatever way it was built", () => {
    const raw = buildRawMessage({ toAddress: "a@b.com", subject: "s", text: "t", html: "<p>t</p>", fromAddress: "support@vircle.com", headers: { "X-Halo-Sign": "1" } });
    expect(isHaloSignMessage(payloadOf(raw))).toBe(true);
  });

  it("is recognised in the original a delivery-failure notice quotes", () => {
    const bounce: GmailPayloadPart = {
      mimeType: "multipart/report",
      headers: [{ name: "From", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Your message wasn't delivered to ali@example.com") } },
        { mimeType: "message/delivery-status", body: { data: b64("Final-Recipient: rfc822; ali@example.com\r\nAction: failed") } },
        { mimeType: "text/rfc822-headers", body: { data: b64("From: Vircle <support@vircle.com>\r\nTo: ali@example.com\r\nX-Halo-Sign: 1\r\nSubject: Please sign") } },
      ],
    };
    expect(isHaloSignMessage(bounce)).toBe(true);
  });

  it("is not guessed from the subject or a quoted link: an ordinary message and an ordinary bounce are not it", () => {
    expect(isHaloSignMessage(payloadOf(buildRawMessage({ toAddress: "a@b.com", subject: "Please sign", text: "https://halo.test/s/abc" })))).toBe(false);
    const bounce: GmailPayloadPart = { mimeType: "multipart/report", headers: [], parts: [{ mimeType: "text/rfc822-headers", body: { data: b64("From: Agent <support@vircle.com>\r\nSubject: Your order") } }] };
    expect(isHaloSignMessage(bounce)).toBe(false);
    expect(isHaloSignMessage(undefined)).toBe(false);
  });
});

describe("what may become a conversation", () => {
  const mailbox = "Support@Vircle.com";
  const base = { fromAddress: "customer@example.com", labelIds: ["INBOX", "UNREAD"], haloSign: false };

  it("lets a customer's message in", () => {
    expect(decideIngest(base, mailbox)).toEqual({ ingest: true });
  });

  it("keeps out a Secure Sign message addressed to the mailbox itself (INBOX and SENT), by any one of its three marks", () => {
    expect(decideIngest({ ...base, fromAddress: "support@vircle.com", labelIds: ["INBOX", "SENT"], haloSign: true }, mailbox)).toEqual({ ingest: false, reason: "doc_sign" });
    // the header alone is enough, even from an address that is not the mailbox's own (a send-as alias)
    expect(decideIngest({ ...base, fromAddress: "alias@vircle.com", haloSign: true }, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
    // the SENT label alone is enough (Gmail's own statement that the mailbox sent it)
    expect(decideIngest({ ...base, fromAddress: "alias@vircle.com", labelIds: ["INBOX", "SENT"] }, mailbox)).toMatchObject({ ingest: false, reason: "sent_label" });
    // the sender alone is enough, in any capitalisation
    expect(decideIngest({ ...base, fromAddress: "SUPPORT@vircle.com" }, mailbox)).toMatchObject({ ingest: false, reason: "sent_by_mailbox" });
  });

  it("keeps out a message with no sender", () => {
    expect(decideIngest({ ...base, fromAddress: null }, mailbox)).toMatchObject({ ingest: false, reason: "no_sender" });
  });
});
