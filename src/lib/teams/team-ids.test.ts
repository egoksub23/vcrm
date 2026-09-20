import { describe, expect, it } from "vitest";

import {
  MAX_TEAM_IDS,
  isUuid,
  parseBulkTeamChange,
  parseInviteTeamIds,
  parseUuidList,
} from "./team-ids";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("isUuid", () => {
  it("accepts uuids and rejects everything else", () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid(A.toUpperCase())).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("parseInviteTeamIds (invitation team_ids validation)", () => {
  it("treats a missing field as no teams", () => {
    expect(parseInviteTeamIds(undefined)).toEqual({ ok: true, ids: [] });
    expect(parseInviteTeamIds(null)).toEqual({ ok: true, ids: [] });
    expect(parseInviteTeamIds([])).toEqual({ ok: true, ids: [] });
  });

  it("accepts a list of uuids, lowercased and de-duplicated", () => {
    expect(parseInviteTeamIds([A, B, A.toUpperCase()])).toEqual({ ok: true, ids: [A, B] });
  });

  it("rejects a non-array", () => {
    const r = parseInviteTeamIds(A);
    expect(r.ok).toBe(false);
    expect(parseInviteTeamIds({ 0: A }).ok).toBe(false);
  });

  it("rejects any entry that is not a uuid (no SQL-ish strings pass)", () => {
    expect(parseInviteTeamIds([A, "not-a-uuid"]).ok).toBe(false);
    expect(parseInviteTeamIds([A, 5]).ok).toBe(false);
    expect(parseInviteTeamIds(["'; drop table teams; --"]).ok).toBe(false);
  });

  it("caps the list at the maximum", () => {
    const many = Array.from({ length: MAX_TEAM_IDS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(parseInviteTeamIds(many).ok).toBe(false);
    expect(parseInviteTeamIds(many.slice(0, MAX_TEAM_IDS)).ok).toBe(true);
  });
});

describe("parseUuidList", () => {
  it("names the field in its error", () => {
    const r = parseUuidList("x", "team_ids");
    expect(r).toEqual({ ok: false, error: "'team_ids' must be an array of ids" });
  });
});

describe("parseBulkTeamChange", () => {
  it("accepts add and remove with members and teams", () => {
    expect(parseBulkTeamChange({ action: "add", user_ids: [A], team_ids: [B] })).toEqual({
      ok: true,
      action: "add",
      userIds: [A],
      teamIds: [B],
    });
    expect(parseBulkTeamChange({ action: "remove", user_ids: [A, B], team_ids: [B] }).ok).toBe(true);
  });

  it("rejects an unknown action, empty picks and bad ids", () => {
    expect(parseBulkTeamChange({ action: "purge", user_ids: [A], team_ids: [B] }).ok).toBe(false);
    expect(parseBulkTeamChange({ action: "add", user_ids: [], team_ids: [B] }).ok).toBe(false);
    expect(parseBulkTeamChange({ action: "add", user_ids: [A], team_ids: [] }).ok).toBe(false);
    expect(parseBulkTeamChange({ action: "add", user_ids: ["x"], team_ids: [B] }).ok).toBe(false);
    expect(parseBulkTeamChange(null).ok).toBe(false);
    expect(parseBulkTeamChange("nope").ok).toBe(false);
  });
});
