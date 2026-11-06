import { describe, expect, it } from "vitest";

import { buildHandoffGuide, parseKeyCreate, parseKeyPatch, TEST_ROSTER } from "./admin";

describe("parseKeyCreate", () => {
  it("accepts a live key with its allowed addresses", () => {
    expect(parseKeyCreate({ mode: "live", label: " Coach portal ", allowed_origins: ["https://coach.example.edu.my/"] })).toEqual({
      ok: true,
      value: { mode: "live", label: "Coach portal", allowedOrigins: ["https://coach.example.edu.my"] },
    });
  });
  it("names a test key for you and allows no addresses yet", () => {
    expect(parseKeyCreate({ mode: "test" })).toEqual({ ok: true, value: { mode: "test", label: "Test key", allowedOrigins: [] } });
  });
  it("says what is wrong", () => {
    expect(parseKeyCreate(null)).toMatchObject({ ok: false });
    expect(parseKeyCreate({ mode: "prod" })).toMatchObject({ ok: false, error: "Choose a live key or a test key." });
    expect(parseKeyCreate({ mode: "live", allowed_origins: ["coach.example.edu.my"] })).toMatchObject({ ok: false });
    expect(parseKeyCreate({ mode: "live", allowed_origins: "x" })).toMatchObject({ ok: false });
  });
});

describe("parseKeyPatch", () => {
  it("accepts a rename, new addresses, or a revoke", () => {
    expect(parseKeyPatch({ label: "Portal v2" })).toEqual({ ok: true, value: { label: "Portal v2" } });
    expect(parseKeyPatch({ allowed_origins: ["https://a.example"] })).toEqual({ ok: true, value: { allowedOrigins: ["https://a.example"] } });
    expect(parseKeyPatch({ revoke: true })).toEqual({ ok: true, value: { revoke: true } });
  });
  it("refuses an empty change, a bad address, and an 'un-revoke'", () => {
    expect(parseKeyPatch({})).toMatchObject({ ok: false });
    expect(parseKeyPatch({ allowed_origins: ["nope"] })).toMatchObject({ ok: false });
    expect(parseKeyPatch({ revoke: false })).toMatchObject({ ok: false });
    expect(parseKeyPatch({ label: " " })).toMatchObject({ ok: false });
  });
});

describe("the hand-off guide", () => {
  const guide = buildHandoffGuide({ address: "https://halo.example.edu.my/", keyPrefix: "ik_test_AbC1", origins: ["https://coach.example.edu.my"] });

  it("shows the real address, the key's prefix only, and the registered address", () => {
    expect(guide).toContain("POST https://halo.example.edu.my/api/public/incident-intake/launch");
    expect(guide).toContain("GET https://halo.example.edu.my/api/public/clearances?student_ids=");
    expect(guide).toContain("ik_test_AbC1…");
    expect(guide).toContain("  https://coach.example.edu.my");
    expect(guide).toContain("\"return_url\": \"https://coach.example.edu.my/activities/A-1187\"");
  });

  it("documents every message the page sends and the web-view settings", () => {
    for (const type of ["ready", "resize", "submitted", "error"]) expect(guide).toContain(`"type": "${type}"`);
    expect(guide).toContain("onShowFileChooser");
    expect(guide).toContain("allow=\"camera\"");
  });

  it("never contains a complete key, and tells the reader how to ask for an address that is not set", () => {
    expect(guide).not.toMatch(/ik_(live|test)_[A-Za-z0-9_-]{43}/);
    const blank = buildHandoffGuide({ address: null, keyPrefix: null, origins: [] });
    expect(blank).toContain("https://<halo-address>");
    expect(blank).toContain("ask the school admin to add your portal's address");
  });

  it("uses made-up students for tests", () => {
    expect(TEST_ROSTER.every((s) => s.name.startsWith("Test "))).toBe(true);
  });
});
