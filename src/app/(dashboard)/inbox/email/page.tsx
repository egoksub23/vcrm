"use client";

import { Suspense } from "react";
import { InboxPageInner } from "../page";
import { EMAIL_CHANNELS } from "@/lib/inbox/channel-scope";

/**
 * "Email Inbox" — the other half of the Email/Chat split
 * (user-requested Sep 19, 2026). Same `InboxPageInner` as `/inbox`
 * ("Chat Inbox"), just scoped to the email channels — no separate data
 * layer or components, per the ask: "you don't need to build a whole
 * new inbox architecture, just have 2 inboxes based on filtered
 * omnichannel incoming messages."
 */
export default function EmailInboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner channelScope={EMAIL_CHANNELS} />
    </Suspense>
  );
}
