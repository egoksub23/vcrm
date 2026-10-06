import { afterEach, describe, expect, it, vi } from "vitest";

import { badgeText, COUNTERSIGN_ERROR_CODES, countersignErrorKey, openMyTurn, signerPath, sortedReasons } from "./countersign";

const TOKEN = "ab".repeat(32);

afterEach(() => vi.unstubAllGlobals());

describe("signerPath", () => {
  it("accepts only the signer page of this site", () => {
    expect(signerPath(`/s/${TOKEN}`)).toBe(`/s/${TOKEN}`);
    for (const bad of [`https://evil.example/s/${TOKEN}`, `//evil.example/s/${TOKEN}`, `/s/${TOKEN}/x`, "/s/short", `/sign/${TOKEN}`, `/s/${TOKEN.toUpperCase()}`, null, undefined, 5, ""]) expect(signerPath(bad), String(bad)).toBeNull();
  });
});

describe("openMyTurn", () => {
  it("asks the server to open my turn and answers the signer page", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: `/s/${TOKEN}`, signerId: "s1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(openMyTurn("d1")).resolves.toBe(`/s/${TOKEN}`);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sign/documents/d1/countersign");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("does not follow an address that is not the signer page, and passes a refusal on with its code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ url: "https://evil.example/" }), { status: 200 })));
    await expect(openMyTurn("d1")).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x", code: "not_your_turn" }), { status: 409 })));
    await expect(openMyTurn("d1")).rejects.toMatchObject({ code: "not_your_turn", status: 409 });
  });
});

describe("countersignErrorKey", () => {
  it("words the refusals the server gives and anything else generically", () => {
    for (const code of COUNTERSIGN_ERROR_CODES) expect(countersignErrorKey(code)).toBe(code);
    expect(countersignErrorKey("database_error")).toBe("generic");
    expect(countersignErrorKey(undefined)).toBe("generic");
    // the codes the route can answer are all covered
    for (const code of ["not_your_turn", "document_not_open", "already_signed", "signer_not_open", "not_a_signer"]) expect(COUNTERSIGN_ERROR_CODES).toContain(code);
  });
});

describe("badgeText", () => {
  it("shows nothing at zero, the number up to nine and 9+ from ten", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
  });
});

describe("sortedReasons", () => {
  it("puts what is worst first", () => {
    expect(sortedReasons(["expired", "undelivered", "declined", "failed"])).toEqual(["failed", "declined", "undelivered", "expired"]);
  });
});
