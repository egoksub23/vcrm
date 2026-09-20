import { describe, expect, it } from "vitest";

import {
  canShareNote,
  decideCommentAction,
  decideCommentDeleted,
  decideStatusApply,
  ECHO_WINDOW_MS,
  hashText,
  hasVircleMarker,
  isOlderEvent,
  isOwnStatusEcho,
  type CommentMapEntry,
  type StatusDecisionInput,
} from "./rules";
import { normalizeSettings } from "./settings";
import { VIRCLE_COMMENT_PROPERTY } from "./types";

const NOW = Date.parse("2026-09-20T10:00:00Z");

describe("ordering guard", () => {
  it("drops an event older than the last change applied", () => {
    expect(isOlderEvent("2026-09-20T09:00:00Z", "2026-09-20T10:00:00Z")).toBe(true);
    expect(isOlderEvent("2026-09-20T10:00:00Z", "2026-09-20T10:00:00Z")).toBe(false);
    expect(isOlderEvent("2026-09-20T11:00:00Z", "2026-09-20T10:00:00Z")).toBe(false);
    expect(isOlderEvent(null, "2026-09-20T10:00:00Z")).toBe(false);
    expect(isOlderEvent("garbage", "2026-09-20T10:00:00Z")).toBe(false);
  });
});

describe("status echo guard: what we wrote comes back", () => {
  const written = { status_category: "indeterminate" as const, status_name: "In Progress", at: new Date(NOW - 60_000).toISOString() };

  it("recognises our own push within the window", () => {
    expect(isOwnStatusEcho(written, { name: "In Progress", category: "indeterminate" }, NOW)).toBe(true);
    expect(isOwnStatusEcho(written, { name: "in progress", category: "indeterminate" }, NOW)).toBe(true);
  });

  it("does not treat a different state, an old push, or no memory as ours", () => {
    expect(isOwnStatusEcho(written, { name: "Done", category: "done" }, NOW)).toBe(false);
    expect(isOwnStatusEcho(written, { name: "In Review", category: "indeterminate" }, NOW)).toBe(false); // same category, another status
    expect(isOwnStatusEcho(written, { name: "In Progress", category: "indeterminate" }, NOW + ECHO_WINDOW_MS + 61_000)).toBe(false);
    expect(isOwnStatusEcho({}, { name: "In Progress", category: "indeterminate" }, NOW)).toBe(false);
    expect(isOwnStatusEcho(undefined, { name: "x", category: "new" }, NOW)).toBe(false);
  });
});

describe("decideStatusApply: Jira wins for status, carefully", () => {
  const base = (over: Partial<StatusDecisionInput> = {}): StatusDecisionInput => ({
    settings: normalizeSettings({}),
    cached: { status_id: "1", status_name: "To Do", last_synced_at: new Date(NOW - 300_000).toISOString(), last_written: {} },
    now: { id: "2", name: "In Progress", category: "indeterminate" },
    ticketStatus: "open",
    otherLinksAllDone: true,
    at: NOW,
    ...over,
  });

  it("follows a Jira change by category", () => {
    expect(decideStatusApply(base())).toEqual({ apply: "in_progress", reason: "changed" });
  });

  it("does nothing when Jira's status did not change since the last sync (equal writes are ignored)", () => {
    expect(decideStatusApply(base({ now: { id: "1", name: "To Do", category: "new" } }))).toMatchObject({ apply: null, reason: "unchanged" });
  });

  it("does nothing for the ticket's own value (idempotent)", () => {
    expect(decideStatusApply(base({ ticketStatus: "in_progress" }))).toMatchObject({ apply: null, reason: "same_as_ticket" });
  });

  it("ignores the echo of a status Vircle pushed", () => {
    const cached = { status_id: "1", status_name: "To Do", last_synced_at: new Date(NOW - 300_000).toISOString(), last_written: { status_category: "indeterminate" as const, status_name: "In Progress", at: new Date(NOW - 30_000).toISOString() } };
    expect(decideStatusApply(base({ cached }))).toMatchObject({ apply: null, reason: "echo" });
  });

  it("respects the direction toggle", () => {
    const settings = normalizeSettings({ direction: { status_from_jira: false } });
    expect(decideStatusApply(base({ settings }))).toMatchObject({ apply: null, reason: "toggle_off" });
  });

  it("never applies on the very first read of a link", () => {
    expect(decideStatusApply(base({ cached: { status_id: null, status_name: null, last_synced_at: null, last_written: {} } }))).toMatchObject({ apply: null, reason: "first_sync" });
  });

  it("Done: by default notify and add a note instead of silently resolving the customer's ticket", () => {
    expect(decideStatusApply(base({ now: { id: "3", name: "Done", category: "done" } }))).toEqual({ apply: null, reason: "done_note" });
  });

  it("Done with 'resolve' opted in resolves only when every linked issue is Done", () => {
    const settings = normalizeSettings({ done_behaviour: "resolve" });
    const done = { id: "3", name: "Done", category: "done" };
    expect(decideStatusApply(base({ settings, now: done }))).toEqual({ apply: "resolved", reason: "changed" });
    expect(decideStatusApply(base({ settings, now: done, otherLinksAllDone: false }))).toMatchObject({ apply: null, reason: "not_all_done" });
  });

  it("an admin's explicit override to Resolved is honoured even with the note default", () => {
    const settings = normalizeSettings({ mapping: { status_from_jira: { shipped: "resolved" } } });
    expect(decideStatusApply(base({ settings, now: { id: "9", name: "Shipped", category: "done" } }))).toEqual({ apply: "resolved", reason: "changed" });
  });

  it("never reopens a closed ticket", () => {
    expect(decideStatusApply(base({ ticketStatus: "closed" }))).toMatchObject({ apply: null, reason: "ticket_closed" });
  });

  it("ignores a status with no mapping", () => {
    expect(decideStatusApply(base({ now: { id: "7", name: "???", category: "undefined" } }))).toMatchObject({ apply: null, reason: "unmapped" });
  });
});

describe("comment echo guards", () => {
  const comment = (over: Record<string, unknown> = {}) => ({ id: "9001", ...over });
  const mapped = (over: Partial<CommentMapEntry> = {}): CommentMapEntry => ({ id: "m1", origin: "jira", ticket_comment_id: "note-1", body_hash: hashText("hello"), deleted_in_jira: false, ...over });
  const input = (over: Partial<Parameters<typeof decideCommentAction>[0]> = {}) => ({
    comment: comment(),
    text: "hello",
    mapped: null as CommentMapEntry | null,
    commentsFromJira: true,
    seedOnly: false,
    ...over,
  });

  it("a comment Vircle posted (recorded in the map) is ignored when the webhook announces it", () => {
    expect(decideCommentAction(input({ mapped: mapped({ origin: "vircle", ticket_comment_id: "note-9" }) }))).toEqual({ kind: "ignore", reason: "ours" });
  });

  it("a comment carrying our marker is ours even if the webhook beat the map row", () => {
    const c = comment({ properties: [{ key: VIRCLE_COMMENT_PROPERTY, value: { v: 1 } }] });
    expect(hasVircleMarker(c as never)).toBe(true);
    expect(decideCommentAction(input({ comment: c }))).toEqual({ kind: "remember_ours" });
  });

  it("a new Jira comment becomes an internal note", () => {
    expect(decideCommentAction(input())).toEqual({ kind: "create" });
  });

  it("existing comments at link time are only noted as seen", () => {
    expect(decideCommentAction(input({ seedOnly: true }))).toEqual({ kind: "seed" });
  });

  it("an unchanged comment is ignored, an edited one updates the note", () => {
    expect(decideCommentAction(input({ mapped: mapped() }))).toEqual({ kind: "ignore", reason: "unchanged" });
    expect(decideCommentAction(input({ mapped: mapped(), text: "hello, edited" }))).toEqual({ kind: "update" });
  });

  it("whitespace-only differences do not count as an edit", () => {
    expect(decideCommentAction(input({ mapped: mapped(), text: "  hello \n" }))).toEqual({ kind: "ignore", reason: "unchanged" });
  });

  it("a comment restricted to a role or group in Jira is never copied", () => {
    expect(decideCommentAction(input({ comment: comment({ visibility: { type: "role", value: "Administrators" } }) }))).toEqual({ kind: "ignore", reason: "restricted" });
  });

  it("respects the toggle and ignores empty comments", () => {
    expect(decideCommentAction(input({ commentsFromJira: false }))).toEqual({ kind: "ignore", reason: "toggle_off" });
    expect(decideCommentAction(input({ text: "   " }))).toEqual({ kind: "ignore", reason: "empty" });
  });

  it("a deleted comment marks the note, and never deletes a note Vircle wrote", () => {
    expect(decideCommentDeleted(mapped())).toEqual({ kind: "mark_deleted" });
    expect(decideCommentDeleted(mapped({ deleted_in_jira: true }))).toEqual({ kind: "ignore", reason: "already_deleted" });
    expect(decideCommentDeleted(mapped({ origin: "vircle" }))).toEqual({ kind: "ignore", reason: "ours" });
    expect(decideCommentDeleted(null)).toMatchObject({ kind: "ignore" });
  });

  it("a note that came from Jira, a customer message or an empty note is never sent back", () => {
    expect(canShareNote({ source: "vircle", author_id: "u1", body: "hi" })).toBe(true);
    expect(canShareNote({ source: "jira", author_id: null, body: "from Jira" })).toBe(false);
    expect(canShareNote({ source: "vircle", author_id: null, body: "no author" })).toBe(false);
    expect(canShareNote({ source: "vircle", author_id: "u1", body: "   " })).toBe(false);
  });
});
