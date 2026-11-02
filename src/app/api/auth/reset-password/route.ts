import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { verifyRecoveryCookie } from "@/lib/auth/tokens";
import { getPool } from "@/lib/postgres/client";

// Updates the password for a user holding a valid recovery cookie.
// /auth/confirm sets sb-access-token to a signed JWT (signRecoveryCookie)
// after verifying the one-time recovery token. We verify that JWT here to
// identify the user without touching GoTrue.
export async function POST(request: Request) {
  try {
    const { password } = (await request.json()) as { password: string };
    if (!password) {
      return NextResponse.json({ error: "Password required" }, { status: 400 });
    }

    const cookieHeader = request.headers.get("cookie") ?? "";
    const m = cookieHeader.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
    const token = m ? decodeURIComponent(m[1]) : null;

    if (!token) {
      return NextResponse.json(
        { error: "Session expired. Please request a new reset link." },
        { status: 401 },
      );
    }

    const userId = await verifyRecoveryCookie(token);
    if (!userId) {
      return NextResponse.json(
        { error: "Session expired. Please request a new reset link." },
        { status: 401 },
      );
    }

    const encryptedPassword = await bcrypt.hash(password, 10);
    const sql = getPool();
    const updated = await sql`
      UPDATE auth.users
         SET encrypted_password = ${encryptedPassword},
             updated_at         = NOW()
       WHERE id         = ${userId}
         AND deleted_at IS NULL
       RETURNING id
    ` as unknown as Array<{ id: string }>;

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "Could not update password" },
        { status: 400 },
      );
    }

    const response = NextResponse.json({ success: true });
    response.cookies.delete("sb-access-token");
    return response;
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
