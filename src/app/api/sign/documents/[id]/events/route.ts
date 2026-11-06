import { UUID_RE, json, staff } from "@/lib/sign/http";
import { NextResponse } from "next/server";

type Params = { params: Promise<{ id: string }> };

const EVENT_COLUMNS = "id, doc_seq, signer_id, type, actor_type, actor_user_id, detail, ip, device, created_at";
const WRITEBACK_COLUMNS = "id, doc_seq, signer_id, type, actor_type, actor_user_id, ip, device, created_at, field:detail->>field, contact_id:detail->>contact_id";

export function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

    const [eventsRes, writebackRes, chainRes] = await Promise.all([
      ctx.admin.from("sign_events").select(EVENT_COLUMNS).eq("document_id", id).neq("type", "writeback").order("created_at"),
      ctx.admin.from("sign_events").select(WRITEBACK_COLUMNS).eq("document_id", id).eq("type", "writeback").order("created_at"),
      ctx.admin.rpc("sign_verify_chain", { p_document: id }),
    ]);

    if (eventsRes.error) return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });
    if (writebackRes.error) return NextResponse.json({ error: writebackRes.error.message }, { status: 500 });

    return json({
      events: eventsRes.data ?? [],
      writebackRows: writebackRes.data ?? [],
      chainData: chainRes.data ?? null,
      chainError: !!chainRes.error,
    });
  });
}
