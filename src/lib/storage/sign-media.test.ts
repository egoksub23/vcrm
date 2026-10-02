import { describe, expect, it, vi } from "vitest";
import { HANDOFF_URL_TTL_SECONDS } from "./media-urls";
import { downloadPrivateMedia, signMediaUrl, signMediaUrls } from "./sign-media";

const HOST = "https://x.supabase.co/storage/v1/object";
const ACCOUNT = "mine";
const OWN = `${HOST}/public/chat-media/account-mine/1-p.png`;
const OTHER = `${HOST}/public/chat-media/account-other/1-p.png`;

/** A storage double: records the bucket asked for and each path signed / downloaded. */
function fakeAdmin(opts: { signError?: boolean; noUrl?: boolean; downloadError?: boolean } = {}) {
  const createSignedUrl = vi.fn(async (path: string, ttl: number) => {
    void ttl;
    if (opts.signError) return { data: null, error: { message: "boom" } };
    if (opts.noUrl) return { data: { signedUrl: "" }, error: null };
    return { data: { signedUrl: `https://x.supabase.co/sign/${path}?token=t` }, error: null };
  });
  const download = vi.fn(async () => {
    if (opts.downloadError) return { data: null, error: { message: "gone" } };
    return { data: new Blob(["bytes"]), error: null };
  });
  const from = vi.fn(() => ({ createSignedUrl, download }));
  const admin = { storage: { from } } as unknown as Parameters<typeof signMediaUrl>[0];
  return { admin, from, createSignedUrl, download };
}

describe("signMediaUrl", () => {
  it("signs a file in the workspace's own folder in the private bucket", async () => {
    const { admin, from, createSignedUrl } = fakeAdmin();

    const out = await signMediaUrl(admin, OWN, ACCOUNT, 600);

    expect(out).toBe("https://x.supabase.co/sign/account-mine/1-p.png?token=t");
    expect(from).toHaveBeenCalledWith("chat-media");
    expect(createSignedUrl).toHaveBeenCalledWith("account-mine/1-p.png", 600);
  });

  it("defaults to the hand-off lifetime", async () => {
    const { admin, createSignedUrl } = fakeAdmin();
    await signMediaUrl(admin, OWN, ACCOUNT);
    expect(createSignedUrl).toHaveBeenCalledWith("account-mine/1-p.png", HANDOFF_URL_TTL_SECONDS);
  });

  it("returns null and never calls the signer for another workspace's file", async () => {
    const { admin, from, createSignedUrl } = fakeAdmin();

    expect(await signMediaUrl(admin, OTHER, ACCOUNT)).toBeNull();

    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a path that climbs out of the workspace folder with ..", async () => {
    const { admin, createSignedUrl } = fakeAdmin();
    const climbing = `${HOST}/public/chat-media/account-mine/../account-other/1-p.png`;
    const encoded = `${HOST}/public/chat-media/account-mine/%2e%2e/account-other/1-p.png`;
    const encodedSlash = `${HOST}/public/chat-media/account-mine%2F..%2Faccount-other/1-p.png`;

    expect(await signMediaUrl(admin, climbing, ACCOUNT)).toBeNull();
    expect(await signMediaUrl(admin, encodedSlash, ACCOUNT)).toBeNull();
    // `%2e%2e` decodes to `..`, which is also refused.
    expect(await signMediaUrl(admin, encoded, ACCOUNT)).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns a non-private URL as given, without touching storage", async () => {
    const { admin, from } = fakeAdmin();
    const publicAsset = `${HOST}/public/public-assets/account-other/kb/1-p.png`;
    const external = "https://example.com/a.png";
    const proxied = "/api/whatsapp/media/123";

    expect(await signMediaUrl(admin, publicAsset, ACCOUNT)).toBe(publicAsset);
    expect(await signMediaUrl(admin, external, ACCOUNT)).toBe(external);
    expect(await signMediaUrl(admin, proxied, ACCOUNT)).toBe(proxied);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns null when storage reports an error", async () => {
    const { admin } = fakeAdmin({ signError: true });
    expect(await signMediaUrl(admin, OWN, ACCOUNT)).toBeNull();
  });

  it("returns null when storage answers without a link", async () => {
    const { admin } = fakeAdmin({ noUrl: true });
    expect(await signMediaUrl(admin, OWN, ACCOUNT)).toBeNull();
  });
});

describe("signMediaUrls", () => {
  it("keeps order and turns refused or failed entries into null", async () => {
    const { admin, createSignedUrl } = fakeAdmin();
    const external = "https://example.com/a.png";

    const out = await signMediaUrls(admin, [OWN, OTHER, external], ACCOUNT, 60);

    expect(out).toEqual(["https://x.supabase.co/sign/account-mine/1-p.png?token=t", null, external]);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
  });
});

describe("downloadPrivateMedia", () => {
  it("reads the bytes of a file in the workspace's folder", async () => {
    const { admin, from, download } = fakeAdmin();

    const blob = await downloadPrivateMedia(admin, OWN, ACCOUNT);

    expect(blob).toBeInstanceOf(Blob);
    expect(from).toHaveBeenCalledWith("chat-media");
    expect(download).toHaveBeenCalledWith("account-mine/1-p.png");
  });

  it("returns null without downloading for another workspace's file or a traversal", async () => {
    const { admin, download } = fakeAdmin();

    expect(await downloadPrivateMedia(admin, OTHER, ACCOUNT)).toBeNull();
    expect(
      await downloadPrivateMedia(admin, `${HOST}/public/chat-media/account-mine/../account-other/1.png`, ACCOUNT),
    ).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("returns null for a URL that is not in the private bucket", async () => {
    const { admin, download } = fakeAdmin();
    expect(await downloadPrivateMedia(admin, `${HOST}/public/public-assets/account-mine/x.png`, ACCOUNT)).toBeNull();
    expect(await downloadPrivateMedia(admin, "https://example.com/a.png", ACCOUNT)).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("returns null when the download fails", async () => {
    const { admin } = fakeAdmin({ downloadError: true });
    expect(await downloadPrivateMedia(admin, OWN, ACCOUNT)).toBeNull();
  });
});
