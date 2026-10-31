import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Delegates signUp() to the server so the browser Supabase client no
// longer needs to call GoTrue Auth methods directly. Uses the anon key
// (not service role) so Supabase's invite-only gate and email-confirm
// hooks still run exactly as before.
export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      email: string;
      password: string;
      fullName?: string;
      inviteToken?: string | null;
      emailRedirectTo?: string;
    };
    const { email, password, fullName, inviteToken, emailRedirectTo } = body;
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName ?? "",
          ...(inviteToken ? { invite_token: inviteToken } : {}),
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
