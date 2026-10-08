import { describe, expect, it } from "vitest";

import { buildRawMessage } from "@/lib/gmail/mime";
import { isHaloSignMessage as gmailIsHalo, decideIngest } from "@/lib/gmail/ingest-guard";
import type { GmailPayloadPart } from "@/lib/gmail/mime";
import { decideMs365Ingest, isHaloSignMessage as ms365IsHalo } from "@/lib/ms365/ingest-guard";

import { HALO_MARKER_HEADERS, HALO_SIGN_HEADER, HALO_SYSTEM_HEADER, HALO_SYSTEM_HEADERS, isMarkerHeaderName, textCarriesMarker } from "./halo-mail-marker";

// Everything Halo sends as the workspace through a connected mailbox carries X-Halo-System, and the Inbox ingestion refuses it (as it always refused
// X-Halo-Sign): by the header, and inside the delivery-failure notice that quotes it.

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

describe("the marks", () => {
  it("are X-Halo-System for everything Halo sends and X-Halo-Sign for Secure Sign, in any capitalisation", () => {
    expect(HALO_SYSTEM_HEADER).toBe("X-Halo-System");
    expect(HALO_SIGN_HEADER).toBe("X-Halo-Sign");
    expect(HALO_MARKER_HEADERS).toEqual(["X-Halo-System", "X-Halo-Sign"]);
    expect(HALO_SYSTEM_HEADERS).toEqual({ "X-Halo-System": "1" });
    expect(isMarkerHeaderName("x-halo-system")).toBe(true);
    expect(isMarkerHeaderName("X-HALO-SIGN")).toBe(true);
    expect(isMarkerHeaderName("X-Halo-Other")).toBe(false);
    expect(isMarkerHeaderName("Message-ID")).toBe(false);
  });

  it("are found as a header line inside a quoted original, either one, and not in an ordinary mention", () => {
    expect(textCarriesMarker("Original headers:\r\nX-Halo-System: 1\r\nSubject: Invitation")).toBe(true);
    expect(textCarriesMarker("X-Halo-Sign: 1")).toBe(true);
    expect(textCarriesMarker("x-halo-system:1")).toBe(true);
    expect(textCarriesMarker("I saw a header called X-Halo-System in my mail. What is it?")).toBe(false);
    expect(textCarriesMarker("X-Halo-System: 0")).toBe(false);
    expect(textCarriesMarker(null)).toBe(false);
    expect(textCarriesMarker("")).toBe(false);
  });
});

describe("Microsoft 365 ingestion", () => {
  const customer = { fromAddress: "customer@example.com", senderAddress: "customer@example.com", headers: [{ name: "Message-ID", value: "<x@y>" }], bodyText: "Where is my order?", bodyHtml: null };
  const mailbox = "support@vircle.com";

  it("refuses a message carrying X-Halo-System, whoever it says it is from", () => {
    const m = { ...customer, headers: [{ name: "x-halo-system", value: "1" }] };
    expect(ms365IsHalo(m)).toBe(true);
    expect(decideMs365Ingest(m, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
  });

  it("refuses the delivery-failure notice that quotes X-Halo-System, in the text or the HTML body", () => {
    const ndr = { ...customer, fromAddress: "postmaster@vircle.onmicrosoft.com", senderAddress: null, headers: [], bodyText: "Delivery has failed.\r\nX-Halo-System: 1\r\nSubject: You are invited", bodyHtml: null };
    expect(decideMs365Ingest(ndr, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
    expect(decideMs365Ingest({ ...ndr, bodyText: null, bodyHtml: "<p>X-Halo-System: 1</p>" }, mailbox)).toMatchObject({ ingest: false });
  });

  it("still refuses X-Halo-Sign alone (mail sent before X-Halo-System existed) and still lets a customer in", () => {
    expect(decideMs365Ingest({ ...customer, headers: [{ name: "X-Halo-Sign", value: "1" }] }, mailbox)).toMatchObject({ ingest: false, reason: "doc_sign" });
    expect(decideMs365Ingest(customer, mailbox)).toEqual({ ingest: true });
  });
});

describe("Gmail ingestion", () => {
  const withHeader = (name: string): GmailPayloadPart => ({ mimeType: "multipart/alternative", headers: [{ name, value: "1" }], parts: [{ mimeType: "text/plain", body: { data: b64("hi") } }] });

  it("recognises X-Halo-System on a message built the way the Gmail sender builds one", () => {
    const raw = buildRawMessage({ toAddress: "a@b.com", subject: "s", text: "t", html: "<p>t</p>", fromAddress: "support@vircle.com", headers: { ...HALO_SYSTEM_HEADERS } });
    const text = Buffer.from(raw, "base64url").toString("utf-8");
    expect(text).toMatch(/^X-Halo-System: 1$/m);
    const headers = text
      .split("\r\n\r\n")[0]
      .split("\r\n")
      .flatMap((line) => {
        const i = line.indexOf(":");
        return i > 0 ? [{ name: line.slice(0, i), value: line.slice(i + 1).trim() }] : [];
      });
    expect(gmailIsHalo({ mimeType: "multipart/alternative", headers, parts: [] })).toBe(true);
  });

  it("recognises either mark, in any capitalisation, and the original a bounce quotes", () => {
    expect(gmailIsHalo(withHeader("x-halo-system"))).toBe(true);
    expect(gmailIsHalo(withHeader("X-Halo-Sign"))).toBe(true);
    const bounce: GmailPayloadPart = {
      mimeType: "multipart/report",
      headers: [],
      parts: [{ mimeType: "text/rfc822-headers", body: { data: b64("From: Vircle <support@vircle.com>\r\nX-Halo-System: 1\r\nSubject: Welcome") } }],
    };
    expect(gmailIsHalo(bounce)).toBe(true);
    expect(gmailIsHalo(withHeader("X-Something-Else"))).toBe(false);
  });

  it("keeps a marked message out of the Inbox whoever sent it", () => {
    expect(decideIngest({ fromAddress: "alias@vircle.com", labelIds: ["INBOX"], haloSign: gmailIsHalo(withHeader("X-Halo-System")) }, "support@vircle.com")).toMatchObject({ ingest: false, reason: "doc_sign" });
  });
});
