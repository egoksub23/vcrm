/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are read loosely in a test */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GraphApiError } from "./errors";
import { sendMailViaDraft, UPLOAD_CHUNK_BYTES } from "./mail-api";

// The draft + upload session route for a message whose files do not fit one sendMail call. Nothing here calls Microsoft: fetch is replaced.

afterEach(() => vi.unstubAllGlobals());

const MB = 1024 * 1024;
const GRAPH = "https://graph.microsoft.com/v1.0";
const UPLOAD_URL = "https://outlook.office.com/api/gbl/v1.0/upload/abc123";
const base64Of = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  json: Record<string, any>;
  bodyBytes: number;
}

/** Replaces fetch with a fake Graph: `reply(method, url)` answers a call, or lets the default answer stand. */
function fakeGraph(reply: (method: string, url: string, nth: number) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body;
      calls.push({
        method: String(init.method),
        url,
        headers: { ...(init.headers as Record<string, string>) },
        json: typeof body === "string" ? JSON.parse(body) : {},
        bodyBytes: typeof body === "string" ? 0 : body ? (body as Uint8Array).byteLength : 0,
      });
      const nth = calls.filter((c) => c.method === String(init.method) && c.url === url).length;
      const custom = reply(String(init.method), url, nth);
      if (custom) return custom;
      if (url === `${GRAPH}/me/messages`) return Response.json({ id: "AAMk-immutable" }, { status: 201 });
      if (url.endsWith("/createUploadSession")) return Response.json({ uploadUrl: UPLOAD_URL }, { status: 200 });
      if (url === UPLOAD_URL) return new Response(null, { status: 202 });
      return new Response(null, { status: 202 });
    }),
  );
  return calls;
}

const base = {
  accessToken: "tok",
  toAddress: "ali@example.com",
  subject: "Please sign",
  text: "hi",
  html: "<p>hi</p>",
  fromAddress: "support@vircle.com",
  fromName: "Vircle",
  replyTo: "help@vircle.com",
  headers: { "X-Halo-Sign": "1", "X-Halo-System": "1" },
  saveToSentItems: false,
};
const instantly = { sleep: async () => undefined, purgeWaitsMs: [0, 0, 0] };

describe("sendMailViaDraft", () => {
  it("uses chunks of a multiple of 320 KiB that Graph takes in one PUT", () => {
    expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0);
    expect(UPLOAD_CHUNK_BYTES).toBeLessThanOrEqual(4 * MB);
  });

  it("creates the draft, uploads a 3.5 MB file in one PUT, sends, then removes the copy for good", async () => {
    const calls = fakeGraph();
    const sent = await sendMailViaDraft({ ...base, attachments: [{ name: "Agreement signed.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(3.5 * MB) }], ...instantly });

    // the copy Exchange files in Sent Items is removed afterwards, in the background
    expect(await sent.purge).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.replace(GRAPH, "")}`)).toEqual([
      "POST /me/messages",
      "POST /me/messages/AAMk-immutable/attachments/createUploadSession",
      `PUT ${UPLOAD_URL}`,
      "POST /me/messages/AAMk-immutable/send",
      "POST /me/messages/AAMk-immutable/permanentDelete",
    ]);

    const [create, session, put, send] = calls;
    expect(create.headers.Authorization).toBe("Bearer tok");
    expect(create.headers.Prefer).toBe('IdType="ImmutableId"');
    expect(create.json.subject).toBe("Please sign");
    expect(create.json.body).toEqual({ contentType: "HTML", content: "<p>hi</p>" });
    expect(create.json.toRecipients).toEqual([{ emailAddress: { address: "ali@example.com" } }]);
    expect(create.json.from).toEqual({ emailAddress: { address: "support@vircle.com", name: "Vircle" } });
    expect(create.json.replyTo).toEqual([{ emailAddress: { address: "help@vircle.com" } }]);
    expect(create.json.internetMessageHeaders).toEqual([{ name: "X-Halo-Sign", value: "1" }, { name: "X-Halo-System", value: "1" }]);
    expect(create.json).not.toHaveProperty("attachments");

    expect(session.json).toEqual({ AttachmentItem: { attachmentType: "file", name: "Agreement signed.pdf", size: 3.5 * MB, contentType: "application/pdf" } });

    // the upload address is signed already: no Authorization header goes to it
    expect(Object.keys(put.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(put.headers["Content-Range"]).toBe(`bytes 0-${3.5 * MB - 1}/${3.5 * MB}`);
    expect(put.headers["Content-Length"]).toBe(String(3.5 * MB));
    expect(put.bodyBytes).toBe(3.5 * MB);

    expect(send.headers.Authorization).toBe("Bearer tok");

  });

  it("uploads a larger file in chunks with the right ranges, each under 4 MB, and several files one after another", async () => {
    const calls = fakeGraph();
    const total = 4 * MB;
    await sendMailViaDraft({
      ...base,
      attachments: [
        { name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(total) },
        { name: "b.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(1000) },
      ],
      ...instantly,
    });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((p) => p.headers["Content-Range"])).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${total}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${total - 1}/${total}`,
      "bytes 0-999/1000",
    ]);
    expect(puts.map((p) => p.bodyBytes)).toEqual([UPLOAD_CHUNK_BYTES, total - UPLOAD_CHUNK_BYTES, 1000]);
    for (const p of puts) {
      expect(p.bodyBytes).toBeLessThanOrEqual(4 * MB);
      expect(p.headers["Content-Length"]).toBe(String(p.bodyBytes));
    }
    // a file's own upload session is made before its bytes, and all the bytes are up before the send
    const order = calls.map((c) => (c.method === "PUT" ? "PUT" : c.url.split("/").pop()));
    expect(order.slice(0, 7)).toEqual(["messages", "createUploadSession", "PUT", "PUT", "createUploadSession", "PUT", "send"]);
  });

  it("tries again to remove the sent copy while Exchange has not yet moved it, and never throws when it cannot be removed", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const flaky = fakeGraph((_method, url, nth) => (url.endsWith("/permanentDelete") && nth < 3 ? Response.json({ error: { code: "ErrorItemNotFound", message: "not found" } }, { status: 404 }) : undefined));
    const sent = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], sleep, purgeWaitsMs: [10, 20, 30] });
    expect(await sent.purge).toBe(true);
    expect(flaky.filter((c) => c.url.endsWith("/permanentDelete"))).toHaveLength(3);
    expect(waits).toEqual([10, 20, 30]);

    const stuck = fakeGraph((_method, url) => (url.endsWith("/permanentDelete") ? Response.json({ error: { code: "ErrorItemNotFound", message: "not found" } }, { status: 404 }) : undefined));
    const stuckSent = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], ...instantly });
    expect(await stuckSent.purge).toBe(false);
    expect(stuck.filter((c) => c.url.endsWith("/permanentDelete"))).toHaveLength(3);

    const denied = fakeGraph((_method, url) => (url.endsWith("/permanentDelete") ? Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 }) : undefined));
    const deniedSent = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], ...instantly });
    expect(await deniedSent.purge).toBe(false);
    expect(denied.filter((c) => c.url.endsWith("/permanentDelete"))).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/permanentDelete")) throw new TypeError("fetch failed");
      if (url === `${GRAPH}/me/messages`) return Response.json({ id: "m1" }, { status: 201 });
      return new Response(null, { status: 202 });
    }));
    const offline = await sendMailViaDraft({ ...base, ...instantly });
    expect(await offline.purge).toBe(false);
  });

  it("leaves the sent copy alone when the copy is meant to be kept", async () => {
    const calls = fakeGraph();
    const sent = await sendMailViaDraft({ ...base, saveToSentItems: true, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], ...instantly });
    expect(await sent.purge).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/permanentDelete"))).toBe(false);
  });

  it("deletes the draft for good and throws what Graph said when an upload fails part-way, and never sends", async () => {
    const calls = fakeGraph((method, url, nth) => (method === "PUT" && nth === 2 ? Response.json({ error: { code: "ErrorInternalServerError", message: "upload broke" } }, { status: 500 }) : undefined));
    const err = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(4 * MB) }], ...instantly }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).httpStatus).toBe(500);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
    expect(calls[calls.length - 1].url).toBe(`${GRAPH}/me/messages/AAMk-immutable/permanentDelete`);
  });

  it("deletes the draft when the send itself is refused, and when the upload session cannot be made", async () => {
    const refused = fakeGraph((_method, url) => (url.endsWith("/send") ? Response.json({ error: { code: "ErrorInvalidRecipients", message: "bad recipient" } }, { status: 400 }) : undefined));
    const e1 = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], ...instantly }).then(() => null, (e: unknown) => e);
    expect((e1 as GraphApiError).code).toBe("ErrorInvalidRecipients");
    expect(refused[refused.length - 1].url.endsWith("/permanentDelete")).toBe(true);

    const noSession = fakeGraph((_method, url) => (url.endsWith("/createUploadSession") ? Response.json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, { status: 403 }) : undefined));
    const e2 = await sendMailViaDraft({ ...base, attachments: [{ name: "a.pdf", contentType: "application/pdf", contentBytesBase64: base64Of(100) }], ...instantly }).then(() => null, (e: unknown) => e);
    expect((e2 as GraphApiError).httpStatus).toBe(403);
    expect(noSession[noSession.length - 1].url.endsWith("/permanentDelete")).toBe(true);
  });

  it("throws what Graph said, with nothing to clean up, when the draft cannot be created; a failed clean-up never hides the real error", async () => {
    const calls = fakeGraph((_method, url) => (url === `${GRAPH}/me/messages` ? Response.json({ error: { code: "ErrorQuotaExceeded", message: "mailbox full" } }, { status: 507 }) : undefined));
    const err = await sendMailViaDraft({ ...base, ...instantly }).then(() => null, (e: unknown) => e);
    expect((err as GraphApiError).code).toBe("ErrorQuotaExceeded");
    expect(calls).toHaveLength(1);

    fakeGraph((_method, url) => (url.endsWith("/send") ? Response.json({ error: { code: "ErrorServerBusy", message: "busy" } }, { status: 503 }) : url.endsWith("/permanentDelete") ? Response.json({}, { status: 500 }) : undefined));
    const busy = await sendMailViaDraft({ ...base, ...instantly }).then(() => null, (e: unknown) => e);
    expect((busy as GraphApiError).code).toBe("ErrorServerBusy");
  });
});
