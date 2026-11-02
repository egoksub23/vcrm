import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/postgres/client";

// Delegates signup to our own PostgreSQL auth.users table. Password is
// hashed with bcrypt before INSERT; the handle_new_user trigger creates
// the profile. Email is confirmed immediately (the CRM uses invitations
// rather than self-service open signup, so the confirmation email flow
// is not needed here).
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email: string;
      password: string;
      fullName?: string;
      inviteToken?: string | null;
    };
    const { email, password, fullName, inviteToken } = body;
    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 },
      );
    }

    const sql = getPool();

    // Always return 200 to avoid leaking whether an email already exists.
    const existing = await sql`
      SELECT id FROM auth.users
       WHERE LOWER(email) = LOWER(${email})
         AND deleted_at IS NULL
       LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (existing.length > 0) {
      return NextResponse.json({ success: true });
    }

    const encryptedPassword = await bcrypt.hash(password, 10);
    const metaJson = JSON.stringify({
      full_name: fullName ?? "",
      ...(inviteToken ? { invite_token: inviteToken } : {}),
    });

    await sql`
      INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
        created_at, updated_at, is_anonymous, is_sso_user
      ) VALUES (
        gen_random_uuid(),
        '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated',
        ${email}, ${encryptedPassword},
        NOW(), ${metaJson}::jsonb, '{}'::jsonb,
        NOW(), NOW(), false, false
      )
    `;

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
