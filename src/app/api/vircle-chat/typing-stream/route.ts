// GET /api/vircle-chat/typing-stream?conversationId=<uuid>
//
// SSE endpoint that delivers "user is typing" signals to the agent's Inbox
// tab. Replaces the Supabase Realtime WebSocket subscription that the
// VircleTypingIndicator component previously opened.
//
// Each agent UI opens one connection per visible conversation thread. The
// server side (broadcastUserTyping) pushes to the in-memory broadcaster
// which fans out to all matching connections. The response stays open until
// the client closes the tab (AbortSignal) or navigates away.
import { toErrorResponse, requireCapability } from "@/lib/auth/account";
import { subscribeToTyping } from "@/lib/vircle-chat/typing-broadcaster";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");
  if (!conversationId) {
    return Response.json({ error: "conversationId required" }, { status: 400 });
  }

  try {
    await requireCapability("messages.send");
  } catch (err) {
    return toErrorResponse(err);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      unsubscribe = subscribeToTyping(conversationId, (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell nginx not to buffer SSE responses.
      "X-Accel-Buffering": "no",
    },
  });
}
