"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  createTypingState,
} from "@/lib/vircle-chat/typing-channel";

/**
 * "typing..." under the last message while a Vircle Chat user is writing
 * (docs/vircle-chat-contract.md, section 3.4). Connects to the SSE endpoint
 * /api/vircle-chat/typing-stream for each signal the gateway sends; the line
 * stays up for about 6 seconds after the last one and goes away as soon as a
 * new customer message arrives (the id of the latest one is
 * `lastCustomerMessageId`). Mount it with `key={conversationId}` so switching
 * conversation starts clean; unmounting closes the SSE connection.
 */
export function VircleTypingIndicator({
  conversationId,
  lastCustomerMessageId,
}: {
  conversationId: string;
  lastCustomerMessageId: string | null;
}) {
  const t = useTranslations("Inbox.messageThread");
  const [typingAfter, setTypingAfter] = useState<{
    messageId: string | null;
  } | null>(null);
  const latestRef = useRef(lastCustomerMessageId);
  useEffect(() => {
    latestRef.current = lastCustomerMessageId;
  }, [lastCustomerMessageId]);

  useEffect(() => {
    const state = createTypingState((typing) =>
      setTypingAfter(typing ? { messageId: latestRef.current } : null),
    );
    const es = new EventSource(
      `/api/vircle-chat/typing-stream?conversationId=${encodeURIComponent(conversationId)}`,
    );
    es.onmessage = () => state.signal();
    return () => {
      state.dispose();
      es.close();
    };
  }, [conversationId]);

  if (!typingAfter || typingAfter.messageId !== lastCustomerMessageId)
    return null;
  return (
    <div
      className="px-1 text-xs italic text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {t("vircleTyping")}
    </div>
  );
}
