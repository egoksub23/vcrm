// GET /api/public/clearances?student_ids=S-1,S-2 — Return to Play dates, for the coach portal to show a warning. Warn only: nothing here blocks anything.
import { NextResponse } from "next/server";

import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { clearances } from "@/lib/incidents/intake/service";

export async function GET(request: Request) {
  try {
    const ids = (new URL(request.url).searchParams.get("student_ids") ?? "").split(",");
    const out = await clearances(intakeDeps(), { authorization: request.headers.get("authorization"), studentIds: ids });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[GET /api/public/clearances]", err);
    return NextResponse.json({ error: { code: "server_error", message: "Something went wrong on our side. Try again in a moment." } }, { status: 500 });
  }
}
