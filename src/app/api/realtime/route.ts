import { auth } from "@/auth";
import { createAdminPgDb } from "@/lib/postgres/db";
import postgres from "postgres";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const pg = createAdminPgDb();
  const rows = await pg.sql`SELECT account_id FROM public.profiles WHERE user_id = ${session.user.id} LIMIT 1`;
  if (!rows.length) return new Response("Not found", { status: 404 });
  const accountId = rows[0].account_id as string;
  const userId = session.user.id;

  const url = process.env.DATABASE_URL;
  if (!url) return new Response("No DATABASE_URL", { status: 500 });

  const listenPg = postgres(url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 30,
    ssl: process.env.DATABASE_SSL === "false" ? false : "prefer",
  });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          /* stream closed */
        }
      };

      send("event: connected\ndata: {}\n\n");

      try {
        await listenPg.listen(`halo_acct_${accountId}`, (payload) => {
          send(`data: ${payload}\n\n`);
        });
        await listenPg.listen(`halo_user_${userId}`, (payload) => {
          send(`data: ${payload}\n\n`);
        });
      } catch (err) {
        console.error("[realtime] LISTEN failed:", err);
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        await listenPg.end().catch(() => {});
        return;
      }

      const hb = setInterval(() => send(": heartbeat\n\n"), 25_000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(hb);
        listenPg.end().catch(() => {});
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
    },
    cancel() {
      closed = true;
      listenPg.end().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
