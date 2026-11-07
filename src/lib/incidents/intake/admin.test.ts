import { describe, expect, it } from "vitest";

import { buildHandoffGuide, parseKeyCreate, parseKeyPatch, parseSchool, TEST_ROSTER } from "./admin";

describe("parseKeyCreate", () => {
  it("accepts a live key with a name", () => {
    expect(parseKeyCreate({ mode: "live", label: " Coach portal " })).toEqual({ ok: true, value: { mode: "live", label: "Coach portal" } });
  });
  it("names a test key for you", () => {
    expect(parseKeyCreate({ mode: "test" })).toEqual({ ok: true, value: { mode: "test", label: "Test key" } });
  });
  it("says what is wrong", () => {
    expect(parseKeyCreate(null)).toMatchObject({ ok: false });
    expect(parseKeyCreate({ mode: "prod" })).toMatchObject({ ok: false, error: "Choose a live key or a test key." });
  });
});

describe("parseSchool: a Vircle Group mapped to a Halo school", () => {
  const ok = { group_id: " G-12 ", group_name: " SMK Seri Puteri ", account_id: "0b9c1f00-0000-4000-8000-000000000001", allowed_origins: ["https://coach.example.edu.my/"] };
  it("takes the Group ID and name, the school, the allowed addresses, and on by default", () => {
    expect(parseSchool(ok)).toEqual({ ok: true, value: { groupId: "G-12", groupName: "SMK Seri Puteri", accountId: ok.account_id, allowedOrigins: ["https://coach.example.edu.my"], enabled: true } });
    expect(parseSchool({ ...ok, allowed_origins: undefined, enabled: false })).toMatchObject({ ok: true, value: { allowedOrigins: [], enabled: false } });
  });
  it("says what is missing or wrong", () => {
    expect(parseSchool(null)).toMatchObject({ ok: false });
    expect(parseSchool({ ...ok, group_id: " " })).toMatchObject({ ok: false, error: expect.stringContaining("Group ID") });
    expect(parseSchool({ ...ok, group_id: "x".repeat(101) })).toMatchObject({ ok: false });
    expect(parseSchool({ ...ok, group_name: "" })).toMatchObject({ ok: false, error: expect.stringContaining("Group Name") });
    expect(parseSchool({ ...ok, account_id: "not-an-id" })).toMatchObject({ ok: false, error: expect.stringContaining("Halo school") });
    expect(parseSchool({ ...ok, allowed_origins: ["coach.example.edu.my"] })).toMatchObject({ ok: false });
    expect(parseSchool({ ...ok, allowed_origins: "x" })).toMatchObject({ ok: false });
    expect(parseSchool({ ...ok, allowed_origins: Array.from({ length: 11 }, (_, i) => `https://a${i}.example.edu.my`) })).toMatchObject({ ok: false });
    expect(parseSchool({ ...ok, enabled: "yes" })).toMatchObject({ ok: false });
  });
});

describe("parseKeyPatch", () => {
  it("accepts a rename or a revoke (the allowed addresses belong to a school, not the key)", () => {
    expect(parseKeyPatch({ label: "Portal v2" })).toEqual({ ok: true, value: { label: "Portal v2" } });
    expect(parseKeyPatch({ allowed_origins: ["https://a.example"] })).toMatchObject({ ok: false, error: "Nothing to change." });
    expect(parseKeyPatch({ revoke: true })).toEqual({ ok: true, value: { revoke: true } });
  });
  it("refuses an empty change and an 'un-revoke'", () => {
    expect(parseKeyPatch({})).toMatchObject({ ok: false });
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
    // every call names the school by its Vircle Group ID, and the guide says who sets the school up
    expect(guide.match(/X-Vircle-Group-Id: <the school's Vircle Group ID>/g)).toHaveLength(2);
    expect(guide).toContain("group_required");
    expect(guide).toContain("unknown_group");
    expect(guide).toContain("data.group_id");
    expect(guide).toContain("Halo administrator");
    expect(guide).toContain("\"return_url\": \"https://coach.example.edu.my/activities/A-1187\"");
  });

  it("documents every message the page sends and the web-view settings", () => {
    for (const type of ["ready", "resize", "submitted", "error"]) expect(guide).toContain(`"type": "${type}"`);
    expect(guide).toContain("onShowFileChooser");
    expect(guide).toContain("X-Halo-Signature: sha256=");
    expect(guide).toContain("incident.created");
    expect(guide).toContain("allow=\"camera\"");
  });

  it("never contains a complete key, and tells the reader how to ask for an address that is not set", () => {
    expect(guide).not.toMatch(/ik_(live|test)_[A-Za-z0-9_-]{43}/);
    const blank = buildHandoffGuide({ address: null, keyPrefix: null, origins: [] });
    expect(blank).toContain("https://<halo-address>");
    expect(blank).toContain("ask the Halo administrator to add your portal's address");
  });

  it("uses made-up students for tests", () => {
    expect(TEST_ROSTER.every((s) => s.name.startsWith("Test "))).toBe(true);
  });
});

describe("parseKeyPatch: the events address", () => {
  it("accepts a public https address, and clears it with an empty value", () => {
    expect(parseKeyPatch({ webhook_url: "https://coach.example.edu.my/hooks/halo" })).toEqual({ ok: true, value: { webhookUrl: "https://coach.example.edu.my/hooks/halo" } });
    expect(parseKeyPatch({ webhook_url: "" })).toEqual({ ok: true, value: { webhookUrl: null } });
    expect(parseKeyPatch({ webhook_url: null })).toEqual({ ok: true, value: { webhookUrl: null } });
  });
  it("refuses an address that points inside the network or is not https", () => {
    for (const bad of ["http://coach.example.edu.my/x", "https://localhost/x", "https://10.1.2.3/x", "https://intranet/x", 5]) expect(parseKeyPatch({ webhook_url: bad })).toMatchObject({ ok: false });
  });
});
