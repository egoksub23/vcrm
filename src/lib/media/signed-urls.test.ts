import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIEW_URL_TTL_SECONDS } from "@/lib/storage/media-urls";
import {
  cachedSignedUrl,
  clearSignedUrlCache,
  setSignerForTests,
  signedMediaUrl,
} from "./signed-urls";

const HOST = "https://x.supabase.co/storage/v1/object";
const priv = (path: string) => `${HOST}/public/chat-media/${path}`;
const A = priv("account-a/1-a.png");
const B = priv("account-a/2-b.pdf");
const C = priv("account-a/3-c.mp4");

type SignerFn = (paths: string[], ttl: number) => Promise<Map<string, string>>;

/** A signer that answers `signed:<path>` for every path and records each call. */
function fakeSigner() {
  const calls: { paths: string[]; ttl: number }[] = [];
  const impl = vi.fn<SignerFn>(async (paths, ttl) => {
    calls.push({ paths: [...paths], ttl });
    return new Map(paths.map((p) => [p, `signed:${p}`]));
  });
  return { impl, calls };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  setSignerForTests(null);
  vi.useRealTimers();
});

describe("signedMediaUrl", () => {
  it("signs a private URL once for concurrent callers", async () => {
    const { impl, calls } = fakeSigner();
    setSignerForTests(impl);

    const [one, two, three] = await Promise.all([signedMediaUrl(A), signedMediaUrl(A), signedMediaUrl(A)]);

    expect(one).toBe("signed:account-a/1-a.png");
    expect(two).toBe(one);
    expect(three).toBe(one);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(calls[0].paths).toEqual(["account-a/1-a.png"]);
    expect(calls[0].ttl).toBe(VIEW_URL_TTL_SECONDS);
  });

  it("batches several paths asked for in the same tick into one signer call", async () => {
    const { impl, calls } = fakeSigner();
    setSignerForTests(impl);

    const out = await Promise.all([signedMediaUrl(A), signedMediaUrl(B), signedMediaUrl(C), signedMediaUrl(A)]);

    expect(out).toEqual([
      "signed:account-a/1-a.png",
      "signed:account-a/2-b.pdf",
      "signed:account-a/3-c.mp4",
      "signed:account-a/1-a.png",
    ]);
    expect(impl).toHaveBeenCalledTimes(1);
    expect([...calls[0].paths].sort()).toEqual(
      ["account-a/1-a.png", "account-a/2-b.pdf", "account-a/3-c.mp4"].sort(),
    );
  });

  it("serves a later call from the cache without asking again", async () => {
    const { impl } = fakeSigner();
    setSignerForTests(impl);

    expect(cachedSignedUrl(A)).toBeNull();
    const first = await signedMediaUrl(A);
    expect(cachedSignedUrl(A)).toBe(first);
    expect(await signedMediaUrl(A)).toBe(first);

    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("keeps using a link until it is within five minutes of expiring, then signs again", async () => {
    const { impl } = fakeSigner();
    setSignerForTests(impl);
    await signedMediaUrl(A);
    expect(impl).toHaveBeenCalledTimes(1);

    // Six minutes of life left: still good.
    vi.setSystemTime(Date.now() + VIEW_URL_TTL_SECONDS * 1000 - 6 * 60 * 1000);
    expect(cachedSignedUrl(A)).not.toBeNull();
    await signedMediaUrl(A);
    expect(impl).toHaveBeenCalledTimes(1);

    // Four minutes left: refreshed.
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(cachedSignedUrl(A)).toBeNull();
    await signedMediaUrl(A);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("forgets every cached link on clearSignedUrlCache", async () => {
    const { impl } = fakeSigner();
    setSignerForTests(impl);
    await signedMediaUrl(A);
    clearSignedUrlCache();
    expect(cachedSignedUrl(A)).toBeNull();
    await signedMediaUrl(A);
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("returns a non-private URL unchanged and never calls the signer", async () => {
    const { impl } = fakeSigner();
    setSignerForTests(impl);

    const publicAsset = `${HOST}/public/public-assets/account-a/kb/1-x.png`;
    const external = "https://example.com/logo.png";
    const proxied = "/api/whatsapp/media/123";
    const blob = "blob:http://localhost/abc";

    expect(await signedMediaUrl(publicAsset)).toBe(publicAsset);
    expect(await signedMediaUrl(external)).toBe(external);
    expect(await signedMediaUrl(proxied)).toBe(proxied);
    expect(await signedMediaUrl(blob)).toBe(blob);
    expect(cachedSignedUrl(external)).toBeNull();
    expect(cachedSignedUrl(null)).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it("rejects every waiting caller when the signer fails, and tries again next time", async () => {
    const impl = vi
      .fn<SignerFn>()
      .mockRejectedValueOnce(new Error("storage down"))
      .mockImplementation(async (paths) => new Map(paths.map((p) => [p, `signed:${p}`])));
    setSignerForTests(impl);

    const results = await Promise.allSettled([signedMediaUrl(A), signedMediaUrl(B)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(((results[0] as PromiseRejectedResult).reason as Error).message).toBe("storage down");
    expect(cachedSignedUrl(A)).toBeNull();

    await expect(signedMediaUrl(A)).resolves.toBe("signed:account-a/1-a.png");
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it("rejects a path the signer returned nothing for, without failing its batch mates", async () => {
    const impl = vi.fn<SignerFn>(async (paths) => {
      const out = new Map<string, string>();
      for (const p of paths) if (p !== "account-a/2-b.pdf") out.set(p, `signed:${p}`);
      return out;
    });
    setSignerForTests(impl);

    const [good, missing] = await Promise.allSettled([signedMediaUrl(A), signedMediaUrl(B)]);

    expect(good).toEqual({ status: "fulfilled", value: "signed:account-a/1-a.png" });
    expect(missing.status).toBe("rejected");
    expect(((missing as PromiseRejectedResult).reason as Error).message).toMatch(/not available/i);
    expect(cachedSignedUrl(B)).toBeNull();
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
