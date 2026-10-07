import { describe, expect, it } from "vitest";

import { decideMs365Ingest, isHaloSignMessage } from "./ingest-guard";

const customer = { fromAddress: "customer@example.com", senderAddress: "customer@example.com", headers: [{ name: "Message-ID", value: "<x@y>" }], bodyText: "Hello, where is my order?", bodyHtml: null };
const mailbox = "Support@Vircle.com";

describe("what may become a conversation (Microsoft 365)", () => {
  it("lets a customer's message in", () => {
    expect(decideMs365Ingest(customer, mailbox)).toEqual({ ingest: true });
  });

  it("keeps out a Doc Sign message by its header, in any capitalisation, even when it did not come from the mailbox's own address", () => {
    expect(decideMs365Ingest({ ...customer, fromAddress: "alias@vircle.com", senderAddress: "alias@vircle.com", headers: [{ name: "x-halo-sign", value: "1" }] }, mailbox)).toEqual({ ingest: false, reason: "doc_sign" });
  });

  it("keeps out the delivery-failure notice of a Doc Sign message, where Exchange quotes the original's headers in the body", () => {
    const ndr = { ...customer, fromAddress: "postmaster@vircle.onmicrosoft.com", senderAddress: null, headers: [], bodyText: "Delivery has failed to these recipients\r\nOriginal message headers:\r\nFrom: support@vircle.com\r\nX-Halo-Sign: 1\r\nSubject: Please sign", bodyHtml: null };
    expect(isHaloSignMessage(ndr)).toBe(true);
    expect(decideMs365Ingest(ndr, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
    // the same when only the HTML body has it
    expect(decideMs365Ingest({ ...ndr, bodyText: null, bodyHtml: "<p>X-Halo-Sign: 1</p>" }, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
  });

  it("keeps out mail from the mailbox itself, by `from` or by `sender`", () => {
    expect(decideMs365Ingest({ ...customer, fromAddress: "support@vircle.com" }, mailbox)).toMatchObject({ ingest: false, reason: "sent_by_mailbox" });
    expect(decideMs365Ingest({ ...customer, senderAddress: "SUPPORT@vircle.com" }, mailbox)).toMatchObject({ ingest: false, reason: "sent_by_mailbox" });
  });

  it("keeps out a message with no sender, and does not mistake an ordinary mention of the word for the mark", () => {
    expect(decideMs365Ingest({ ...customer, fromAddress: null }, mailbox)).toMatchObject({ ingest: false, reason: "no_sender" });
    expect(isHaloSignMessage({ ...customer, bodyText: "I got a message with the header X-Halo-Sign. What is it?" })).toBe(false);
  });
});
