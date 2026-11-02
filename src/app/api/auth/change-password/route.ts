import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { getPool } from "@/lib/postgres/client";

// Authenticated route: verifies current password via bcrypt then updates.
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { current, next } = (await request.json()) as {
      current?: string;
      next?: string;
    };
    if (!current || !next) {
      return NextResponse.json(
        { error: "current and next passwords required" },
        { status: 400 },
      );
    }

    const sql = getPool();

    // Fetch the current bcrypt hash.
    const rows = await sql`
      SELECT encrypted_password FROM auth.users
       WHERE id         = ${session.user.id}
         AND deleted_at IS NULL
       LIMIT 1
    ` as unknown as Array<{ encrypted_password: string | null }>;

    const encryptedPassword = rows[0]?.encrypted_password;
    if (!encryptedPassword) {
      return NextResponse.json(
        { error: "currentPasswordIncorrect" },
        { status: 401 },
      );
    }

    const match = await bcrypt.compare(current, encryptedPassword);
    if (!match) {
      return NextResponse.json(
        { error: "currentPasswordIncorrect" },
        { status: 401 },
      );
    }

    const newHash = await bcrypt.hash(next, 10);
    await sql`
      UPDATE auth.users
         SET encrypted_password = ${newHash},
             updated_at         = NOW()
       WHERE id = ${session.user.id}
    `;

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
