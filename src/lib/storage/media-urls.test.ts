import { describe, expect, it } from "vitest";
import {
  PRIVATE_MEDIA_BUCKET,
  PUBLIC_MEDIA_BUCKET,
  accountFolder,
  isPrivateMediaUrl,
  parseStorageUrl,
  pathInAccount,
  privateMediaPath,
} from "./media-urls";

const HOST = "https://x.supabase.co/storage/v1/object";

describe("bucket names", () => {
  it("keeps the private and public buckets distinct", () => {
    expect(PRIVATE_MEDIA_BUCKET).toBe("chat-media");
    expect(PUBLIC_MEDIA_BUCKET).toBe("public-assets");
  });
});

describe("parseStorageUrl", () => {
  it("reads the three URL forms", () => {
    expect(parseStorageUrl(`${HOST}/public/chat-media/account-a/1-p.png`)).toEqual({
      kind: "public",
      bucket: "chat-media",
      path: "account-a/1-p.png",
    });
    expect(parseStorageUrl(`${HOST}/sign/chat-media/account-a/1-p.png?token=abc`)).toEqual({
      kind: "sign",
      bucket: "chat-media",
      path: "account-a/1-p.png",
    });
    expect(parseStorageUrl(`${HOST}/authenticated/public-assets/account-a/kb/x.pdf`)).toEqual({
      kind: "authenticated",
      bucket: "public-assets",
      path: "account-a/kb/x.pdf",
    });
  });

  it("decodes the path and drops a query string or fragment", () => {
    const parsed = parseStorageUrl(`${HOST}/public/chat-media/account-a/my%20file%20%281%29.png?download=1#top`);
    expect(parsed?.path).toBe("account-a/my file (1).png");
  });

  it("returns null for anything that is not a storage object URL", () => {
    expect(parseStorageUrl(null)).toBeNull();
    expect(parseStorageUrl(undefined)).toBeNull();
    expect(parseStorageUrl("")).toBeNull();
    expect(parseStorageUrl("https://example.com/logo.png")).toBeNull();
    expect(parseStorageUrl("/api/whatsapp/media/123")).toBeNull();
    expect(parseStorageUrl(`${HOST}/public/chat-media`)).toBeNull();
  });

  it("returns null for a path that is not valid percent-encoding", () => {
    expect(parseStorageUrl(`${HOST}/public/chat-media/account-a/%E0%A4%A.png`)).toBeNull();
  });
});

describe("privateMediaPath / isPrivateMediaUrl", () => {
  it("returns the path for a chat-media URL in any form", () => {
    expect(privateMediaPath(`${HOST}/public/chat-media/account-a/1-p.png`)).toBe("account-a/1-p.png");
    expect(privateMediaPath(`${HOST}/sign/chat-media/account-a/1-p.png?token=t`)).toBe("account-a/1-p.png");
    expect(isPrivateMediaUrl(`${HOST}/public/chat-media/account-a/1-p.png`)).toBe(true);
  });

  it("is null / false for the public bucket, other hosts and empty input", () => {
    const publicAsset = `${HOST}/public/public-assets/account-a/kb/1-p.png`;
    expect(privateMediaPath(publicAsset)).toBeNull();
    expect(isPrivateMediaUrl(publicAsset)).toBe(false);
    expect(isPrivateMediaUrl("https://example.com/a.png")).toBe(false);
    expect(isPrivateMediaUrl("/api/whatsapp/media/9")).toBe(false);
    expect(isPrivateMediaUrl(null)).toBe(false);
    expect(isPrivateMediaUrl(undefined)).toBe(false);
  });

  it("does not mistake a bucket whose name merely starts with chat-media", () => {
    expect(isPrivateMediaUrl(`${HOST}/public/chat-media-old/account-a/1.png`)).toBe(false);
  });
});

describe("pathInAccount", () => {
  it("builds the account folder name", () => {
    expect(accountFolder("abc")).toBe("account-abc");
  });

  it("accepts a path inside the workspace's folder, nested or flat", () => {
    expect(pathInAccount("account-abc/1-p.png", "abc")).toBe(true);
    expect(pathInAccount("account-abc/kb/1-p.png", "abc")).toBe(true);
  });

  it("rejects another workspace's folder", () => {
    expect(pathInAccount("account-other/1-p.png", "abc")).toBe(false);
    // A prefix match on the id alone is not enough.
    expect(pathInAccount("account-abcd/1-p.png", "abc")).toBe(false);
    expect(pathInAccount("account-abc", "abc")).toBe(false);
  });

  it("rejects traversal and empty segments", () => {
    expect(pathInAccount("account-abc/../account-other/1.png", "abc")).toBe(false);
    expect(pathInAccount("account-abc/kb/../../account-other/1.png", "abc")).toBe(false);
    expect(pathInAccount("account-abc//1.png", "abc")).toBe(false);
    expect(pathInAccount("account-abc/1.png/", "abc")).toBe(false);
  });
});
