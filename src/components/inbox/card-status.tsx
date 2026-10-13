"use client";

// ============================================================
// The status of the closure form cards in the open thread (migration 185): ONE fetch for the whole thread, shared by every card through a context.
//
//   asked for when the conversation changes or the number of link cards in it changes (a card was sent, or removed), and again after a resend or a withdraw
//   asked for again every 30 s, and when the tab becomes visible, only while some card is still waiting on the customer (created, sent or opened) and the tab is
//   visible; once every card has reached an end the polling stops
//   NOT asked for at all by a person who holds none of compliance.raise, review or approve (the route would refuse): their cards show with no status line
//
// The statuses carry no address and nothing about the customer (CardStatus). They are kept per conversation, so a thread that was left never shows another's.
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useCapability } from "@/hooks/use-auth";
import { anyCardActive, CARD_POLL_MS, indexStatuses } from "@/lib/compliance/chat-link/card-view";
import type { CardStatus } from "@/lib/compliance/chat-link/types";

import { getCardStatuses } from "../compliance/api";

export interface CardStatusValue {
  /** The status of one card by its link id (null: not known, or the person cannot read statuses). */
  byLink: ReadonlyMap<string, CardStatus>;
  /** Ask again now (after a resend or a withdraw). */
  refresh: () => Promise<void>;
}

const EMPTY: ReadonlyMap<string, CardStatus> = new Map();
const NOOP_VALUE: CardStatusValue = { byLink: EMPTY, refresh: async () => undefined };

/** Exported so tests can hand the cards a status without a network. */
export const CardStatusContext = createContext<CardStatusValue | null>(null);

export function CardStatusProvider({ conversationId, cardCount, children }: { conversationId: string | null | undefined; cardCount: number; children: ReactNode }) {
  const canRaise = useCapability("compliance.raise");
  const canReview = useCapability("compliance.review");
  const canApprove = useCapability("compliance.approve");
  const canRead = canRaise || canReview || canApprove;
  const wanted = !!conversationId && cardCount > 0 && canRead;

  const [held, setHeld] = useState<{ conversationId: string; links: CardStatus[] } | null>(null);
  // the newest request wins: an answer that arrives after the thread changed is dropped
  const ticket = useRef(0);

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    const mine = ++ticket.current;
    const res = await getCardStatuses(conversationId);
    if (mine !== ticket.current) return;
    // a failed read keeps what is known; it is tried again on the next tick
    if (res.ok) setHeld({ conversationId, links: res.data.links });
  }, [conversationId]);

  useEffect(() => {
    if (!wanted) return;
    // load-on-change fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [wanted, conversationId, cardCount, refresh]);

  const links = wanted && held && held.conversationId === conversationId ? held.links : null;
  const polling = links !== null && anyCardActive(links);

  useEffect(() => {
    if (!polling || !wanted) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, CARD_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [polling, wanted, refresh]);

  const value = useMemo<CardStatusValue>(() => ({ byLink: links ? indexStatuses(links) : EMPTY, refresh }), [links, refresh]);
  return <CardStatusContext.Provider value={value}>{children}</CardStatusContext.Provider>;
}

/** The status of one card, and a way to ask again. Without a provider (or without the right to read statuses) there is no status. */
export function useCardStatus(linkId: string | null): { status: CardStatus | null; refresh: () => Promise<void> } {
  const ctx = useContext(CardStatusContext) ?? NOOP_VALUE;
  return { status: linkId ? (ctx.byLink.get(linkId) ?? null) : null, refresh: ctx.refresh };
}
