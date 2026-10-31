import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Authenticated route: verifies current password then updates to new password.
// The client sends { current, next }; we verify against GoTrue then update.
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { current, next } = await request.json() as { current?: string; next?: string };
    if (!current || !next) {
      return NextResponse.json({ error: "current and next passwords required" }, { status: 400 });
    }

    const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;

    // Verify the current password by attempting a sign-in.
    const verifyRes = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ email: session.user.email, password: current }),
    });
    if (!verifyRes.ok) {
      return NextResponse.json({ error: "currentPasswordIncorrect" }, { status: 401 });
    }

    // Update to new password via admin API.
    const updateRes = await fetch(`${base}/auth/v1/admin/users/${session.user.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      body: JSON.stringify({ password: next }),
    });
    if (!updateRes.ok) {
      const body = await updateRes.json().catch(() => ({})) as { message?: string };
      return NextResponse.json({ error: body.message ?? "Failed to update password" }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
