import { NextResponse } from "next/server";

// Updates the password for a user holding a valid recovery session.
// The browser sends sb-access-token (a GoTrue access token set by
// /auth/confirm after OTP verification). We verify it against GoTrue's
// /user endpoint to get the user ID, then update via the admin API.
export async function POST(request: Request) {
  try {
    const { password } = await request.json() as { password: string };
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

    // Verify the GoTrue token and resolve the user ID.
    const userRes = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        },
      },
    );
    if (!userRes.ok) {
      return NextResponse.json(
        { error: "Session expired. Please request a new reset link." },
        { status: 401 },
      );
    }
    const userPayload = await userRes.json() as { id?: string };
    const userId = userPayload.id;
    if (!userId) {
      return NextResponse.json({ error: "Could not verify session" }, { status: 401 });
    }

    const updateRes = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        },
        body: JSON.stringify({ password }),
      },
    );
    if (!updateRes.ok) {
      const body = await updateRes.json().catch(() => ({})) as { message?: string };
      return NextResponse.json({ error: body.message ?? "Failed to update password" }, { status: 400 });
    }

    // Clear the recovery token so it can't be reused.
    const response = NextResponse.json({ success: true });
    response.cookies.delete("sb-access-token");
    return response;
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
