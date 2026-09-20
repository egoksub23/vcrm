import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  baseMime,
  checkMimeSanity,
  CHAT_MEDIA_MIME_TYPES,
  extensionFor,
  FROM_JIRA_MAX_BYTES,
  isAcceptedFromJira,
  isOwnTicketPath,
  isSendableMime,
  JIRA_DEFAULT_UPLOAD_LIMIT,
  sanitizeFilename,
  sniffFamily,
  uploadCap,
} from "./attachment-rules";
import { isAllowedMediaHost, JiraClient, resetGlobalBrake } from "./client";
import { JiraValidationError } from "./errors";

const CLOUD = "11111111-2222-4333-8444-555555555555";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7 hello");
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => resetGlobalBrake());
afterEach(() => resetGlobalBrake());

function make(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  const client = new JiraClient({
    cloudId: CLOUD,
    connectionKey: `k-${Math.random()}`,
    fetch: fetchFn as never,
    getAccessToken: async () => "tok",
    sleep: async () => undefined,
    random: () => 0.5,
  });
  return { client, calls };
}

describe("the bucket allow-list", () => {
  it("is exactly the 38 types migration 076 sets on chat-media (the bucket is not changed)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "076_knowledge_v3.sql"), "utf8");
    const at = sql.indexOf("INSERT INTO storage.buckets");
    const block = sql.slice(at, sql.indexOf("ON CONFLICT (id)", at));
    const arr = block.slice(block.indexOf("ARRAY["));
    const sqlTypes = [...arr.replace(/--.*$/gm, "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(sqlTypes).toHaveLength(38);
    expect([...CHAT_MEDIA_MIME_TYPES].sort()).toEqual([...sqlTypes].sort());
  });

  it("takes only images and documents from Jira: listed types yes, octet-stream and active content no", () => {
    for (const ok of ["image/png", "image/jpeg", "application/pdf", "text/plain", "text/csv", "application/msword", "IMAGE/PNG; charset=binary"]) {
      expect(isAcceptedFromJira(ok), ok).toBe(true);
    }
    for (const no of ["application/octet-stream", "text/html", "image/svg+xml", "application/x-msdownload", "application/x-sh", "video/x-matroska", "", null, undefined, "application/x-executable"]) {
      expect(isAcceptedFromJira(no), String(no)).toBe(false);
    }
  });

  it("sends anything with a sane type except active content", () => {
    expect(isSendableMime("application/x-tar")).toBe(true);
    expect(isSendableMime("image/png")).toBe(true);
    for (const no of ["text/html", "image/svg+xml", "application/javascript", "not a mime", "", null, "../../etc/passwd"]) expect(isSendableMime(no as string), String(no)).toBe(false);
  });
});

describe("caps, names and paths", () => {
  it("the upload cap is the site limit, or 10 MB when Jira does not say", () => {
    expect(JIRA_DEFAULT_UPLOAD_LIMIT).toBe(10 * 1024 * 1024);
    expect(uploadCap(null)).toBe(10 * 1024 * 1024);
    expect(uploadCap({ enabled: true })).toBe(10 * 1024 * 1024);
    expect(uploadCap({ uploadLimit: 0 })).toBe(10 * 1024 * 1024);
    expect(uploadCap({ uploadLimit: 2_000_000 })).toBe(2_000_000);
    expect(FROM_JIRA_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("sanitises file names: no path, no control characters, no leading dots, bounded, never empty", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename('we"ird<name>?.png')).toBe("we_ird_name__.png");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename(null)).toBe("file");
    const long = `${"x".repeat(300)}.pdf`;
    const s = sanitizeFilename(long);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith(".pdf")).toBe(true);
  });

  it("only our own ticket folder is ever read: no URL, no traversal, no other workspace", () => {
    const acct = "aaaa1111-2222-4333-8444-555555555555";
    expect(isOwnTicketPath(acct, `account-${acct}/tickets/171-a.png`)).toBe(true);
    for (const bad of [
      `account-${acct}/kb/171-a.png`,
      `account-other/tickets/a.png`,
      `account-${acct}/tickets/../kb/a.png`,
      `account-${acct}/tickets//a.png`,
      `https://evil.example/account-${acct}/tickets/a.png`,
      `account-${acct}\\tickets\\a.png`,
      "",
      "file:///etc/passwd",
    ]) {
      expect(isOwnTicketPath(acct, bad), bad).toBe(false);
    }
  });

  it("extensions", () => {
    expect(extensionFor("photo.JPEG", "image/jpeg")).toBe("jpeg");
    expect(extensionFor("noext", "image/png")).toBe("png");
    expect(extensionFor("noext", "application/x-weird")).toBe("bin");
  });
});

describe("MIME sanity", () => {
  it("pictures and documents must carry their own signature", () => {
    expect(sniffFamily(PNG)).toBe("png");
    expect(checkMimeSanity("image/png", PNG)).toEqual({ ok: true });
    expect(checkMimeSanity("image/jpeg", PNG)).toEqual({ ok: false, reason: "mime_mismatch" });
    expect(checkMimeSanity("application/pdf", PDF)).toEqual({ ok: true });
    expect(checkMimeSanity("application/pdf", bytes("<html>"))).toEqual({ ok: false, reason: "mime_mismatch" });
    expect(checkMimeSanity("application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toEqual({ ok: true });
  });

  it("HTML dressed up as text is refused, plain text passes, binary in text is refused", () => {
    expect(checkMimeSanity("text/plain", bytes("<!DOCTYPE html><html><script>alert(1)</script>"))).toEqual({ ok: false, reason: "active_content" });
    expect(checkMimeSanity("text/csv", bytes("  <html>"))).toEqual({ ok: false, reason: "active_content" });
    expect(checkMimeSanity("text/plain", bytes("hello world\nline 2"))).toEqual({ ok: true });
    expect(checkMimeSanity("text/plain", new Uint8Array([104, 105, 0, 1, 2]))).toEqual({ ok: false, reason: "mime_mismatch" });
    expect(baseMime("Text/Plain; charset=utf-8")).toBe("text/plain");
  });
});

describe("JiraClient.uploadAttachment: multipart to Jira", () => {
  it("posts multipart form data to /issue/{key}/attachments with X-Atlassian-Token: no-check and a bearer token", async () => {
    const { client, calls } = make(() => new Response(JSON.stringify([{ id: "5001", filename: "shot.png", size: 12 }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    const out = await client.uploadAttachment("ENG-1", { filename: "shot.png", contentType: "image/png", data: PNG });
    expect(out).toEqual([{ id: "5001", filename: "shot.png", size: 12 }]);

    const c = calls[0];
    expect(c.url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/ENG-1/attachments`);
    expect(c.init.method).toBe("POST");
    const headers = c.init.headers as Record<string, string>;
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    expect(headers.Authorization).toBe("Bearer tok");
    // fetch must add the multipart boundary itself: no Content-Type may be set by hand
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    const form = c.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("shot.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  });

  it("a 413 is a permanent answer about the file (not an outage to retry)", async () => {
    const { client } = make(() => new Response("", { status: 413 }));
    await expect(client.uploadAttachment("ENG-1", { filename: "big.pdf", contentType: "application/pdf", data: PDF })).rejects.toBeInstanceOf(JiraValidationError);
  });

  it("reads the site's attachment limit from /attachment/meta", async () => {
    const { client, calls } = make(() => new Response(JSON.stringify({ enabled: true, uploadLimit: 5242880 }), { status: 200 }));
    expect(await client.getAttachmentMeta()).toEqual({ enabled: true, uploadLimit: 5242880 });
    expect(calls[0].url.endsWith("/rest/api/3/attachment/meta")).toBe(true);
  });
});

describe("JiraClient.downloadAttachment: Atlassian hosts only, size capped", () => {
  const MEDIA = "https://api.media.atlassian.com/file/abc/binary?token=zzz&client=1";

  function scripted(redirect: string | null, media: (init: RequestInit) => Response) {
    return make((url, init) => {
      if (url.includes("/attachment/content/")) {
        return redirect === null ? new Response(bytes("direct"), { status: 200, headers: { "Content-Type": "image/png" } }) : new Response(null, { status: 303, headers: { Location: redirect } });
      }
      return media(init);
    });
  }

  it("follows the 303 to Atlassian's media host, without the bearer token, and returns the bytes", async () => {
    const { client, calls } = scripted(MEDIA, () => new Response(PNG, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) } }));
    const r = await client.downloadAttachment("5001", 1024);
    expect(r).toMatchObject({ ok: true, contentType: "image/png" });
    if (r.ok) expect(r.data).toEqual(PNG);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/5001`);
    expect(calls[0].init.redirect).toBe("manual");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[1].url).toBe(MEDIA);
    expect(calls[1].init.headers).toBeUndefined(); // the signed link carries its own authorisation
    expect(calls[1].init.redirect).toBe("manual"); // a second redirect is not followed either
  });

  it("refuses a redirect to any other host (no SSRF), http, or a lookalike", async () => {
    for (const evil of [
      "https://evil.example/file",
      "http://api.media.atlassian.com/file",
      "https://api.media.atlassian.com.evil.example/file",
      "https://evilatlassian.net/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:3000/admin",
      "//evil.example/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      const { client, calls } = scripted(evil, () => new Response("secret", { status: 200 }));
      const r = await client.downloadAttachment("5001", 1024);
      expect(r, evil).toEqual({ ok: false, reason: "bad_redirect" });
      expect(calls, evil).toHaveLength(1); // the evil host was never contacted
    }
  });

  it("allows the media host, the site's own atlassian.net address and nothing else", () => {
    for (const ok of ["api.media.atlassian.com", "media.atlassian.com", "acme.atlassian.net", "x-1.media.atlassian.com", "API.MEDIA.ATLASSIAN.COM"]) expect(isAllowedMediaHost(ok), ok).toBe(true);
    for (const no of ["atlassian.net", "evil.example", "atlassian.com", "acme.atlassian.net.evil.example", "media.atlassian.com.evil.example", "a.b.atlassian.net", ""]) expect(isAllowedMediaHost(no), no).toBe(false);
  });

  it("refuses a redirect that points at another redirect", async () => {
    const { client } = scripted(MEDIA, () => new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } }));
    expect(await client.downloadAttachment("5001", 1024)).toEqual({ ok: false, reason: "bad_redirect" });
  });

  it("enforces the size cap from Content-Length before reading anything", async () => {
    const { client } = scripted(MEDIA, () => new Response(PNG, { status: 200, headers: { "Content-Length": "99999999" } }));
    expect(await client.downloadAttachment("5001", 1024)).toEqual({ ok: false, reason: "too_large" });
  });

  it("enforces the cap while streaming when the size is not declared", async () => {
    const big = new Uint8Array(4096).fill(7);
    const { client } = scripted(MEDIA, () => new Response(big, { status: 200 }));
    expect(await client.downloadAttachment("5001", 1000)).toEqual({ ok: false, reason: "too_large" });
    const ok = await scripted(MEDIA, () => new Response(big, { status: 200 })).client.downloadAttachment("5001", 4096);
    expect(ok.ok).toBe(true);
  });

  it("a missing attachment, a bad id and a failing media host are reported, not thrown", async () => {
    expect(await make(() => new Response("{}", { status: 404 })).client.downloadAttachment("5001", 10)).toEqual({ ok: false, reason: "not_found" });
    expect(await make(() => new Response("")).client.downloadAttachment("../../x", 10)).toEqual({ ok: false, reason: "not_found" });
    expect(await scripted(MEDIA, () => new Response("", { status: 500 })).client.downloadAttachment("5001", 10)).toEqual({ ok: false, reason: "failed" });
    expect(await scripted(null, () => new Response("")).client.downloadAttachment("5001", 1024)).toMatchObject({ ok: true }); // a direct 200 is fine too
  });
});
