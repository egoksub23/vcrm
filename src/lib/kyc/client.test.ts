// The calls to the back end, with a fetch that is a function. Nothing touches the network.

import { describe, expect, it } from "vitest";

import { KycError, checkHealth, fetchImage, fetchSignedImageUrl, fetchValidations, sniffImageType, type KycTransport } from "./client";
import { readKycConfig } from "./config";
import { API_KEY, BASE_URL, ENV, HTML, JPEG, PDF, PNG, WEBP, bytes, json, makeTransport, streamOf, text } from "./test-support";

const cfgOf = (extra: Record<string, string> = {}) => {
  const r = readKycConfig({ ...ENV, ...extra });
  if (!r.ok) throw new Error("config");
  return r.config;
};
const cfg = cfgOf();

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof KycError ? e.code : `not a KycError: ${String(e)}`;
  }
};

describe("fetchValidations", () => {
  it("calls GET /validations with the friend id (encoded), the limit and the key in a header, and follows no redirect", async () => {
    const { transport, calls } = makeTransport({ api: () => json([{ id: "1" }]) });
    expect(await fetchValidations(cfg, transport, "a b/c?d&e", 50)).toEqual([{ id: "1" }]);
    expect(calls.api).toHaveLength(1);
    expect(calls.api[0].url).toBe(`${BASE_URL}/validations?friend_id=a%20b%2Fc%3Fd%26e&limit=50`);
    expect(calls.api[0].headers["x-api-key"]).toBe(API_KEY);
    expect(calls.api[0].init.redirect).toBe("manual");
    expect(calls.api[0].init.method).toBe("GET");
    expect(calls.api[0].url).not.toContain(API_KEY);
  });

  it("clamps the limit to 1..100", async () => {
    const { transport, calls } = makeTransport({ api: () => json([]) });
    await fetchValidations(cfg, transport, "x", 5000);
    await fetchValidations(cfg, transport, "x", 0);
    await fetchValidations(cfg, transport, "x", 7.9);
    expect(calls.api.map((c) => new URL(c.url).searchParams.get("limit"))).toEqual(["100", "1", "7"]);
  });

  it.each([
    [401, "upstream_unauthorized"],
    [403, "upstream_unauthorized"],
    [404, "not_found"],
    [429, "upstream_unreachable"],
    [500, "upstream_unreachable"],
    [503, "upstream_unreachable"],
    [400, "bad_response"],
    [422, "bad_response"],
    [301, "bad_response"],
    [302, "bad_response"],
  ])("answers %i with %s", async (status, code) => {
    const { transport } = makeTransport({ api: () => text("SECRET UPSTREAM WORDS", status, { location: "https://x.example/" }) });
    expect(await codeOf(fetchValidations(cfg, transport, "x", 10))).toBe(code);
  });

  it("answers bad_response for a body that is not JSON, and unreachable when the network fails", async () => {
    expect(await codeOf(fetchValidations(cfg, makeTransport({ api: () => text("<html>nope</html>") }).transport, "x", 10))).toBe("bad_response");
    expect(await codeOf(fetchValidations(cfg, makeTransport({ api: () => text("") }).transport, "x", 10))).toBe("bad_response");
    const boom: KycTransport = { api: async () => { throw new Error(`connect ECONNREFUSED ${BASE_URL} with ${API_KEY}`); }, image: async () => { throw new Error("x"); } };
    expect(await codeOf(fetchValidations(cfg, boom, "x", 10))).toBe("upstream_unreachable");
  });

  it("never keeps what the back end or the network said: the error is a code and nothing else", async () => {
    const boom: KycTransport = { api: async () => { throw new Error(`connect ECONNREFUSED ${BASE_URL} with ${API_KEY}`); }, image: async () => { throw new Error("x"); } };
    try {
      await fetchValidations(cfg, boom, "x", 10);
      throw new Error("expected an error");
    } catch (e) {
      const err = e as KycError;
      expect(err).toBeInstanceOf(KycError);
      expect(err.message).toBe("upstream_unreachable");
      expect(JSON.stringify(err) + String(err.stack ?? "").split("\n")[0] + err.message).not.toContain(API_KEY);
      expect(err.hint).toBeUndefined();
    }
  });

  it("gives up after the deadline, even for a fetch that ignores the abort signal", async () => {
    const hang: KycTransport = { api: () => new Promise<Response>(() => undefined), image: () => new Promise<Response>(() => undefined) };
    const t0 = Date.now();
    expect(await codeOf(fetchValidations(cfg, hang, "x", 10, { timeoutMs: 40 }))).toBe("upstream_unreachable");
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("gives up when the body never finishes (the deadline covers the body, not only the headers)", async () => {
    const stall = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const transport = makeTransport({ api: () => new Response(stall, { status: 200 }) }).transport;
    expect(await codeOf(fetchValidations(cfg, transport, "x", 10, { timeoutMs: 40 }))).toBe("upstream_unreachable");
  });

  it("refuses a JSON answer larger than 2 MB", async () => {
    const transport = makeTransport({ api: () => new Response(streamOf(3 * 1024 * 1024, 64 * 1024, new TextEncoder().encode("[")), { status: 200 }) }).transport;
    expect(await codeOf(fetchValidations(cfg, transport, "x", 10))).toBe("bad_response");
  });
});

describe("checkHealth", () => {
  it("is true for 2xx, false for anything else, and sends no key", async () => {
    const ok = makeTransport({ api: () => text("ok") });
    expect(await checkHealth(cfg, ok.transport)).toBe(true);
    expect(ok.calls.api[0].url).toBe(`${BASE_URL}/health`);
    expect(ok.calls.api[0].headers["x-api-key"]).toBeUndefined();
    expect(await checkHealth(cfg, makeTransport({ api: () => text("down", 503) }).transport)).toBe(false);
    expect(await checkHealth(cfg, { api: async () => { throw new Error("x"); }, image: async () => { throw new Error("x"); } })).toBe(false);
    expect(await checkHealth(cfg, { api: () => new Promise<Response>(() => undefined), image: async () => { throw new Error("x"); } }, { timeoutMs: 30 })).toBe(false);
  });
});

describe("fetchSignedImageUrl", () => {
  const url = (body: Response | (() => Response)) => makeTransport({ api: () => (typeof body === "function" ? body() : body) });

  it("asks GET /validations/{id}/url with the key and returns a guarded URL from a JSON body", async () => {
    const { transport, calls } = url(json({ url: "https://files.vircle.com/a.jpg?sig=1" }));
    const u = await fetchSignedImageUrl(cfg, transport, "val_123");
    expect(u.toString()).toBe("https://files.vircle.com/a.jpg?sig=1");
    expect(calls.api[0].url).toBe(`${BASE_URL}/validations/val_123/url`);
    expect(calls.api[0].headers["x-api-key"]).toBe(API_KEY);
    expect(calls.api[0].init.redirect).toBe("manual");
  });

  it("encodes the id", async () => {
    const { transport, calls } = url(json({ url: "https://files.vircle.com/a.jpg" }));
    await fetchSignedImageUrl(cfg, transport, "a b");
    expect(calls.api[0].url).toBe(`${BASE_URL}/validations/a%20b/url`);
  });

  it.each([
    ["a plain string body", () => text("https://files.vircle.com/plain.jpg")],
    ["a JSON string", () => json("https://files.vircle.com/plain.jpg")],
    ["signed_url", () => json({ signed_url: "https://files.vircle.com/plain.jpg" })],
    ["a redirect (Location is read, not followed)", () => text("", 302, { location: "https://files.vircle.com/plain.jpg" })],
    ["a relative redirect", () => text("", 302, { location: "https://files.vircle.com/plain.jpg" })],
  ])("accepts %s", async (_label, make) => {
    const { transport, calls } = url(make);
    expect((await fetchSignedImageUrl(cfg, transport, "v1")).hostname).toBe("files.vircle.com");
    expect(calls.api).toHaveLength(1);
  });

  it("resolves a relative Location against the back end and then judges it", async () => {
    const { transport } = url(() => text("", 302, { location: "/verify_doc/img/1.jpg" }));
    expect((await fetchSignedImageUrl(cfg, transport, "v1")).toString()).toBe("https://apis-uat.vircle.com/verify_doc/img/1.jpg");
  });

  it("refuses a URL the guard does not allow, with a hint (host only) for the server log and a code for the browser", async () => {
    for (const bad of ["https://evil.example/a.jpg?secret=1", "http://files.vircle.com/a.jpg", "https://127.0.0.1/a.jpg", "https://169.254.169.254/latest", "https://localhost/a"]) {
      const { transport } = url(json({ url: bad }));
      try {
        await fetchSignedImageUrl(cfg, transport, "v1");
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(KycError);
        expect((e as KycError).code).toBe("image_host_blocked");
        expect((e as KycError).hint ?? "").not.toContain("secret=1");
        expect((e as KycError).hint ?? "").not.toContain("?");
      }
    }
  });

  it("accepts an image host from the allow-list", async () => {
    const c = cfgOf({ KYC_DOC_ALLOWED_IMAGE_HOSTS: "*.s3.ap-southeast-1.amazonaws.com" });
    const { transport } = url(json({ url: "https://kyc.s3.ap-southeast-1.amazonaws.com/a.jpg?X-Amz-Signature=1" }));
    expect((await fetchSignedImageUrl(c, transport, "v1")).hostname).toBe("kyc.s3.ap-southeast-1.amazonaws.com");
  });

  it("maps the back end's statuses, and 'no URL in the answer' to bad_response", async () => {
    expect(await codeOf(fetchSignedImageUrl(cfg, url(text("", 404)).transport, "v"))).toBe("not_found");
    expect(await codeOf(fetchSignedImageUrl(cfg, url(text("", 401)).transport, "v"))).toBe("upstream_unauthorized");
    expect(await codeOf(fetchSignedImageUrl(cfg, url(text("", 500)).transport, "v"))).toBe("upstream_unreachable");
    expect(await codeOf(fetchSignedImageUrl(cfg, url(json({ message: "no url" })).transport, "v"))).toBe("bad_response");
    expect(await codeOf(fetchSignedImageUrl(cfg, url(text("")).transport, "v"))).toBe("bad_response");
    expect(await codeOf(fetchSignedImageUrl(cfg, url(text("", 302)).transport, "v"))).toBe("bad_response");
  });

  it("gives up after the deadline", async () => {
    const hang: KycTransport = { api: () => new Promise<Response>(() => undefined), image: async () => { throw new Error("x"); } };
    expect(await codeOf(fetchSignedImageUrl(cfg, hang, "v", { timeoutMs: 30 }))).toBe("upstream_unreachable");
  });
});

describe("fetchImage", () => {
  const u = new URL("https://files.vircle.com/a.jpg?sig=1");
  const img = (res: Response | (() => Response)) => makeTransport({ image: () => (typeof res === "function" ? res() : res) });

  it("returns the bytes and the type, sends NO key, and does not follow redirects", async () => {
    const { transport, calls } = img(bytes(JPEG, "image/jpeg"));
    const out = await fetchImage(transport, u);
    expect(out.contentType).toBe("image/jpeg");
    expect(Array.from(out.bytes)).toEqual(Array.from(JPEG));
    expect(calls.image[0].headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(calls.image[0].headers)).not.toContain(API_KEY);
    expect(calls.image[0].init.redirect).toBe("manual");
    expect(calls.image[0].url).toBe(u.toString());
  });

  it.each([
    ["image/png", PNG],
    ["image/webp", WEBP],
    ["IMAGE/JPEG; charset=binary", JPEG],
  ])("accepts %s", async (type, body) => {
    const out = await fetchImage(img(bytes(body, type)).transport, u);
    expect(["image/png", "image/webp", "image/jpeg"]).toContain(out.contentType);
  });

  it.each([
    ["application/pdf", PDF],
    ["text/html", HTML],
    ["image/svg+xml", new TextEncoder().encode("<svg onload=alert(1)/>")],
    ["image/gif", new TextEncoder().encode("GIF89a")],
    ["application/octet-stream", JPEG],
    ["", JPEG],
  ])("refuses the declared type %s", async (type, body) => {
    expect(await codeOf(fetchImage(img(bytes(body, type)).transport, u))).toBe("image_type_unsupported");
  });

  it("refuses bytes that are not the image type the header claims (a lie about the type)", async () => {
    expect(await codeOf(fetchImage(img(bytes(HTML, "image/jpeg")).transport, u))).toBe("image_type_unsupported");
    expect(await codeOf(fetchImage(img(bytes(PDF, "image/png")).transport, u))).toBe("image_type_unsupported");
    expect(await codeOf(fetchImage(img(bytes(new Uint8Array(0), "image/png")).transport, u))).toBe("image_type_unsupported");
  });

  it("serves what the bytes are when the header names another allowed image type", async () => {
    expect((await fetchImage(img(bytes(PNG, "image/jpeg")).transport, u)).contentType).toBe("image/png");
  });

  it("refuses an image over the size cap, declared or not", async () => {
    const declared = img(new Response(new Uint8Array(10) as unknown as BodyInit, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(16 * 1024 * 1024) } }));
    expect(await codeOf(fetchImage(declared.transport, u))).toBe("image_too_large");
    // no length declared: the stream is cut at the cap, never read to its end
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        const piece = new Uint8Array(1024 * 1024);
        if (sent === 0) piece.set(JPEG);
        sent += piece.length;
        c.enqueue(piece);
      },
    });
    const undeclared = img(new Response(endless, { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect(await codeOf(fetchImage(undeclared.transport, u))).toBe("image_too_large");
    expect(sent).toBeLessThan(40 * 1024 * 1024);
    // a small cap given by the caller
    expect(await codeOf(fetchImage(img(bytes(JPEG, "image/jpeg")).transport, u, { maxBytes: 10 }))).toBe("image_too_large");
  });

  it("accepts an image just under the cap", async () => {
    const res = new Response(streamOf(1024 * 1024, 64 * 1024), { status: 200, headers: { "content-type": "image/jpeg" } });
    expect((await fetchImage(img(res).transport, u)).bytes.length).toBe(1024 * 1024);
  });

  it("does not follow a redirect and maps other statuses", async () => {
    const { transport, calls } = img(text("", 302, { location: "https://169.254.169.254/latest/meta-data/" }));
    expect(await codeOf(fetchImage(transport, u))).toBe("bad_response");
    expect(calls.image).toHaveLength(1);
    expect(await codeOf(fetchImage(img(text("", 404)).transport, u))).toBe("not_found");
    expect(await codeOf(fetchImage(img(text("", 403)).transport, u))).toBe("not_found");
    expect(await codeOf(fetchImage(img(text("", 500)).transport, u))).toBe("bad_response");
    expect(await codeOf(fetchImage(img(text("", 201)).transport, u))).toBe("bad_response");
  });

  it("gives up after the deadline, headers or body", async () => {
    const hang: KycTransport = { api: async () => { throw new Error("x"); }, image: () => new Promise<Response>(() => undefined) };
    expect(await codeOf(fetchImage(hang, u, { timeoutMs: 30 }))).toBe("upstream_unreachable");
    const stall = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    expect(await codeOf(fetchImage(img(new Response(stall, { status: 200, headers: { "content-type": "image/jpeg" } })).transport, u, { timeoutMs: 30 }))).toBe("upstream_unreachable");
    const refused: KycTransport = { api: async () => { throw new Error("x"); }, image: async () => { throw new Error("connect ECONNREFUSED"); } };
    expect(await codeOf(fetchImage(refused, u))).toBe("upstream_unreachable");
  });
});

describe("sniffImageType", () => {
  it("reads the first bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});
