import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compareFingerprints, sha256OfFile } from "./file-hash";

describe("sha256OfFile", () => {
  it("matches the fingerprint Node computes", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 128]);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256OfFile(new Blob([bytes]))).toBe(expected);
  });

  it("gives the well-known fingerprint of an empty file", async () => {
    expect(await sha256OfFile(new Blob([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("changes when one byte changes", async () => {
    const a = await sha256OfFile(new Blob([new Uint8Array([1, 2, 3])]));
    const b = await sha256OfFile(new Blob([new Uint8Array([1, 2, 4])]));
    expect(a).not.toBe(b);
  });
});

describe("compareFingerprints", () => {
  const sha = "ab".repeat(32);
  it("matches the same fingerprint in either case, ignoring stray spaces", () => {
    expect(compareFingerprints(sha, sha)).toBe("match");
    expect(compareFingerprints(sha.toUpperCase(), sha)).toBe("match");
    expect(compareFingerprints(` ${sha}\n`, sha)).toBe("match");
  });
  it("does not match a different fingerprint or an empty one", () => {
    expect(compareFingerprints("cd".repeat(32), sha)).toBe("different");
    expect(compareFingerprints("", sha)).toBe("different");
  });
});
