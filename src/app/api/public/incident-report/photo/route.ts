// POST /api/public/incident-report/photo — multipart: token + file. A photo for a report that was just sent (30 minutes after sending, 5 files, 10 MB each).
import { NextResponse } from "next/server";

import { clientIp, intakeDeps } from "@/lib/incidents/intake/runtime";
import { addPhoto, MAX_PHOTO_BYTES } from "@/lib/incidents/intake/service";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    if (!checkRateLimit(`incident-photo:${clientIp(request)}`, { limit: 20, windowMs: 60_000 }).success) {
      return NextResponse.json({ error: { code: "rate_limited", message: "Too many tries. Wait a minute and try again." } }, { status: 429 });
    }
    // Refuse a huge body before reading it.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_PHOTO_BYTES + 64 * 1024) {
      return NextResponse.json({ error: { code: "invalid_file", message: "That file is too big (10 MB at most)." } }, { status: 413 });
    }
    const form = await request.formData().catch(() => null);
    const token = typeof form?.get("token") === "string" ? (form!.get("token") as string).slice(0, 2000) : "";
    const file = form?.get("file");
    if (!token || !(file instanceof File)) {
      return NextResponse.json({ error: { code: "invalid_request", message: "Send a token and a file." } }, { status: 400 });
    }
    const out = await addPhoto(intakeDeps(), { token, filename: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/public/incident-report/photo]", err);
    return NextResponse.json({ error: { code: "server_error", message: "The photo could not be saved. The report itself was sent." } }, { status: 500 });
  }
}
