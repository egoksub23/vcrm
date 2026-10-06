import { describe, expect, it } from "vitest";

import { signerFileUrl } from "./api";
import { publicPath, scopeOf, splitScope } from "./scope";

const TOKEN = "a".repeat(64);
const DOC = "11111111-1111-4111-8111-111111111111";

describe("the scope of a call on a signer's link", () => {
  it("is the token alone for a document on its own, and token@document for one document of an envelope", () => {
    expect(scopeOf(TOKEN)).toBe(TOKEN);
    expect(scopeOf(TOKEN, null)).toBe(TOKEN);
    expect(scopeOf(TOKEN, DOC)).toBe(`${TOKEN}@${DOC}`);
    expect(splitScope(TOKEN)).toEqual({ token: TOKEN, documentId: null });
    expect(splitScope(`${TOKEN}@${DOC}`)).toEqual({ token: TOKEN, documentId: DOC });
    expect(splitScope(`${TOKEN}@`)).toEqual({ token: TOKEN, documentId: null });
  });

  it("builds the address of a route with ?doc= only when a document is named", () => {
    expect(publicPath(TOKEN)).toBe(`/api/sign/public/${TOKEN}`);
    expect(publicPath(TOKEN, "/answers")).toBe(`/api/sign/public/${TOKEN}/answers`);
    expect(publicPath(`${TOKEN}@${DOC}`, "/answers")).toBe(`/api/sign/public/${TOKEN}/answers?doc=${DOC}`);
    expect(publicPath(`${TOKEN}@${DOC}`, "/upload", { query: "field=a&id=b" })).toBe(`/api/sign/public/${TOKEN}/upload?doc=${DOC}&field=a&id=b`);
    expect(publicPath(TOKEN, "/upload", { query: "field=a" })).toBe(`/api/sign/public/${TOKEN}/upload?field=a`);
  });

  it("never names a document on a call about the whole link (the code: one code opens every document)", () => {
    expect(publicPath(`${TOKEN}@${DOC}`, "/code", { withDocument: false })).toBe(`/api/sign/public/${TOKEN}/code`);
    expect(publicPath(`${TOKEN}@${DOC}`, "/envelope/finish", { withDocument: false })).toBe(`/api/sign/public/${TOKEN}/envelope/finish`);
  });

  it("keeps the file address of a document on its own exactly as it was, and names the document of an envelope", () => {
    expect(signerFileUrl(TOKEN)).toBe(`/api/sign/public/${TOKEN}/file`);
    expect(signerFileUrl(TOKEN, true)).toBe(`/api/sign/public/${TOKEN}/file?download=1`);
    expect(signerFileUrl(`${TOKEN}@${DOC}`)).toBe(`/api/sign/public/${TOKEN}/file?doc=${DOC}`);
    expect(signerFileUrl(`${TOKEN}@${DOC}`, true)).toBe(`/api/sign/public/${TOKEN}/file?doc=${DOC}&download=1`);
  });
});
