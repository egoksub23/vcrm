"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { createTypingState, TYPING_EVENT, typingChannelName } from "@/lib/vircle-chat/typing-channel";

/**
 * "typing..." under the last message while a Vircle Chat user is writing
 * (docs/vircle-chat-contract.md, section 3.4). Halo broadcasts an ephemeral
 * Realtime message on `vircle-typing:<conversationId>` for each signal the
 * gateway sends; the line stays up for about 6 seconds after the last one and
 * goes away as soon as a new customer message arrives (the id of the latest one
 * is `lastCustomerMessageId`). Mount it with `key={conversationId}` so switching
 * conversation starts clean; unmounting unsubscribes.
 */
export function VircleTypingIndicator({
  conversationId,
  lastCustomerMessageId,
}: {
  conversationId: string;
  lastCustomerMessageId: string | null;
}) {
  const t = useTranslations("Inbox.messageThread");
  // Which customer message was the latest when the signal came. A different latest
  // message now means the user has sent something since, so the line is hidden.
  const [typingAfter, setTypingAfter] = useState<{ messageId: string | null } | null>(null);
  const latestRef = useRef(lastCustomerMessageId);
  useEffect(() => {
    latestRef.current = lastCustomerMessageId;
  }, [lastCustomerMessageId]);

  useEffect(() => {
    const supabase = createClient();
    const state = createTypingState((typing) =>
      setTypingAfter(typing ? { messageId: latestRef.current } : null),
    );
    const channel = supabase
      .channel(typingChannelName(conversationId))
      .on("broadcast", { event: TYPING_EVENT }, () => state.signal())
      .subscribe();
    return () => {
      state.dispose();
      void supabase.removeChannel(channel);
    };
  }, [conversationId]);

  if (!typingAfter || typingAfter.messageId !== lastCustomerMessageId) return null;
  return (
    <div className="px-1 text-xs italic text-muted-foreground" role="status" aria-live="polite">
      {t("vircleTyping")}
    </div>
  );
}
