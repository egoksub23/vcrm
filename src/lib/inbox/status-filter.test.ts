import { describe, expect, it } from "vitest";

import {
  countByStatus,
  DEFAULT_STATUS_FILTER,
  effectiveStatusFilter,
  isReplyWindowExpired,
  matchesStatusFilter,
  ownershipFromView,
  REPLY_WINDOW_MS,
  statusFromView,
  type StatusFilterRow,
} from "./status-filter";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3600 * 1000;

const chat = (over: Partial<StatusFilterRow> = {}): StatusFilterRow => ({
  status: "open",
  last_channel_type: "whatsapp",
  last_customer_message_at: ago(HOUR),
  ...over,
});

describe("the default", () => {
  it("is Active: open and pending, never closed", () => {
    expect(DEFAULT_STATUS_FILTER).toBe("active");
    expect(matchesStatusFilter(chat({ status: "open" }), "active", NOW)).toBe(true);
    expect(matchesStatusFilter(chat({ status: "pending" }), "active", NOW)).toBe(true);
    expect(matchesStatusFilter(chat({ status: "closed" }), "active", NOW)).toBe(false);
  });
});

describe("each status", () => {
  it("open, pending and closed show exactly that status; all shows every chat", () => {
    for (const s of ["open", "pending", "closed"] as const) {
      expect(matchesStatusFilter(chat({ status: s }), s, NOW)).toBe(true);
      for (const other of (["open", "pending", "closed"] as const).filter((x) => x !== s)) expect(matchesStatusFilter(chat({ status: other }), s, NOW)).toBe(false);
    }
    for (const s of ["open", "pending", "closed"] as const) expect(matchesStatusFilter(chat({ status: s }), "all", NOW)).toBe(true);
  });
});

describe("expired", () => {
  it("is a WhatsApp chat, not closed, whose customer last wrote 24 hours ago or more", () => {
    expect(isReplyWindowExpired(chat({ last_customer_message_at: ago(REPLY_WINDOW_MS) }), NOW)).toBe(true);
    expect(isReplyWindowExpired(chat({ last_customer_message_at: ago(REPLY_WINDOW_MS - 1) }), NOW)).toBe(false);
    expect(isReplyWindowExpired(chat({ status: "pending", last_customer_message_at: ago(3 * 24 * HOUR) }), NOW)).toBe(true);
  });

  it("counts a chat where the customer never wrote as expired, like the thread does", () => {
    expect(isReplyWindowExpired(chat({ last_customer_message_at: null }), NOW)).toBe(true);
    expect(isReplyWindowExpired(chat({ last_customer_message_at: undefined }), NOW)).toBe(true);
  });

  it("is never true for a closed chat or for a channel with no reply window", () => {
    expect(isReplyWindowExpired(chat({ status: "closed", last_customer_message_at: ago(9 * 24 * HOUR) }), NOW)).toBe(false)
    for (const ch of ["email", "gmail", "vircle_chat", "web_widget", "messenger", "instagram"]) {
      expect(isReplyWindowExpired(chat({ last_channel_type: ch, last_customer_message_at: ago(9 * 24 * HOUR) }), NOW)).toBe(false);
    }
  });

  it("is a time that cannot be read: not expired", () => {
    expect(isReplyWindowExpired(chat({ last_customer_message_at: "garbage" }), NOW)).toBe(false);
  });
});

describe("searching", () => {
  it("widens the default view to every status so a closed chat can still be found, and leaves a chosen status alone", () => {
    expect(effectiveStatusFilter("active", true)).toBe("all");
    expect(effectiveStatusFilter("active", false)).toBe("active");
    for (const f of ["open", "pending", "expired", "closed", "all"] as const) expect(effectiveStatusFilter(f, true)).toBe(f);
  });
});

describe("the numbers in the menu", () => {
  it("count what each choice would show", () => {
    const rows = [
      chat({ status: "open" }),
      chat({ status: "open", last_customer_message_at: ago(30 * HOUR) }),
      chat({ status: "pending" }),
      chat({ status: "closed" }),
      chat({ status: "closed" }),
      chat({ status: "open", last_channel_type: "email" }),
    ];
    expect(countByStatus(rows, NOW)).toEqual({ active: 4, open: 3, pending: 1, expired: 1, closed: 2, all: 6 });
  });
});

describe("saved views made before the status filter", () => {
  it("keep meaning what they meant", () => {
    expect(statusFromView({ filter: "closed" })).toBe("closed");
    expect(statusFromView({ filter: "open" })).toBe("open");
    expect(statusFromView({ filter: "pending" })).toBe("pending");
    // an old view that showed every status keeps showing every status
    for (const f of [undefined, "all", "mine", "unassigned", "unread"]) expect(statusFromView({ filter: f })).toBe("all");
    expect(ownershipFromView({ filter: "closed" })).toBe("all");
    expect(ownershipFromView({ filter: "mine" })).toBe("mine");
    expect(ownershipFromView({})).toBe("all");
  });

  it("use the status a new view saved, when it is a real one", () => {
    expect(statusFromView({ filter: "mine", status: "expired" })).toBe("expired");
    expect(statusFromView({ filter: "mine", status: "active" })).toBe("active");
    expect(statusFromView({ filter: "mine", status: "nonsense" })).toBe("all");
  });
});
