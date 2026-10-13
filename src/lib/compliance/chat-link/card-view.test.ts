import { describe, expect, it } from "vitest";

import { storedCard } from "./card";
import { ACTIVE_CARD_STATES, anyCardActive, CARD_POLL_MS, cardActions, cardView, countLinkCards, indexStatuses, isActiveCardState, isLinkCardMessage } from "./card-view";
import { LINK_STATES, type LinkState } from "./link-state";
import type { CardStatus } from "./types";

// The pure parts of the closure form card in the Inbox thread (migration 185). The markup is covered by src/components/inbox/link-card-render.test.tsx.

const LINK = "11111111-1111-4111-8111-111111111111";
const status = (over: Partial<CardStatus> = {}): CardStatus => ({ id: LINK, state: "sent", expiresAt: "2026-10-26T08:00:00Z", canManage: true, requestId: "req-1", ...over });

describe("what a link_card row shows", () => {
  it("reads the title, body, button and link id from send_payload", () => {
    const sp = { link_card: storedCard(LINK, "ms") };
    const v = cardView({ content_type: "link_card", content_text: "Borang penutupan akaun", send_payload: sp });
    expect(v.linkId).toBe(LINK);
    expect(v.title).toBe("Borang penutupan akaun");
    expect(v.body).toContain("Vircle");
    expect(v.button).toBe("Buka borang");
  });

  it("still draws a row whose stored words are missing: the title from content_text, nothing else, no link id", () => {
    for (const send_payload of [null, undefined, {}, { link_card: { link_id: "nope" } }, "x", [1]]) {
      expect(cardView({ content_type: "link_card", content_text: "Account closure form", send_payload })).toEqual({ linkId: null, title: "Account closure form", body: "", button: "" });
    }
    expect(cardView({ content_type: "link_card", content_text: null, send_payload: null }).title).toBe("");
  });

  it("never produces an address (the row has none to give)", () => {
    const v = cardView({ content_type: "link_card", content_text: "Account closure form", send_payload: { link_card: storedCard(LINK, "en"), url: "https://x.test/c/link/abc" } });
    expect(JSON.stringify(v)).not.toContain("http");
    expect(JSON.stringify(v)).not.toContain("/c/link/");
  });
});

describe("counting the cards in a thread", () => {
  it("counts only link_card rows", () => {
    expect(isLinkCardMessage({ content_type: "link_card" })).toBe(true);
    expect(isLinkCardMessage({ content_type: "text" })).toBe(false);
    expect(countLinkCards([{ content_type: "text" }, { content_type: "link_card" }, { content_type: "interactive" }, { content_type: "link_card" }])).toBe(2);
    expect(countLinkCards([])).toBe(0);
  });
});

describe("which statuses keep the polling going", () => {
  it("only a card still waiting on the customer: created, sent or opened", () => {
    expect([...ACTIVE_CARD_STATES]).toEqual(["created", "sent", "opened"]);
    const active = LINK_STATES.filter(isActiveCardState);
    expect(active).toEqual(["created", "sent", "opened"]);
    for (const s of ["submitted", "expired", "revoked", "replaced"] as LinkState[]) expect(anyCardActive([status({ state: s })])).toBe(false);
    expect(anyCardActive([status({ state: "submitted" }), status({ id: "b", state: "opened" })])).toBe(true);
    expect(anyCardActive([])).toBe(false);
    expect(CARD_POLL_MS).toBe(30_000);
  });

  it("indexes the statuses by link id", () => {
    const m = indexStatuses([status(), status({ id: "other", state: "opened" })]);
    expect(m.get(LINK)?.state).toBe("sent");
    expect(m.get("other")?.state).toBe("opened");
    expect(m.get("missing")).toBeUndefined();
  });
});

describe("which buttons the card shows", () => {
  it("none without a status, without canManage or without a request to act on", () => {
    expect(cardActions(null)).toEqual({ resend: false, withdraw: false });
    expect(cardActions(undefined)).toEqual({ resend: false, withdraw: false });
    expect(cardActions(status({ canManage: false }))).toEqual({ resend: false, withdraw: false });
    expect(cardActions(status({ requestId: undefined }))).toEqual({ resend: false, withdraw: false });
  });

  it("Withdraw only while the customer can still use the link", () => {
    for (const s of LINK_STATES) expect(cardActions(status({ state: s })).withdraw).toBe(["created", "sent", "opened"].includes(s));
  });

  it("Send again unless the customer submitted or a newer link replaced this one", () => {
    expect(cardActions(status({ state: "created" })).resend).toBe(true);
    expect(cardActions(status({ state: "sent" })).resend).toBe(true);
    expect(cardActions(status({ state: "opened" })).resend).toBe(true);
    expect(cardActions(status({ state: "expired" })).resend).toBe(true);
    expect(cardActions(status({ state: "revoked" })).resend).toBe(true);
    expect(cardActions(status({ state: "submitted" })).resend).toBe(false);
    expect(cardActions(status({ state: "replaced" })).resend).toBe(false);
  });
});
