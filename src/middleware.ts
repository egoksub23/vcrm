import { auth } from "@/auth";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const session = await auth();
  const user = session?.user ?? null;

  // Build the base response.
  let response: NextResponse;

  // Auth pages — redirect to dashboard if already logged in.
  if (
    user &&
    (request.nextUrl.pathname === "/login" ||
      request.nextUrl.pathname === "/signup" ||
      request.nextUrl.pathname === "/forgot-password")
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get("invite");
    if (
      inviteToken &&
      (request.nextUrl.pathname === "/login" ||
        request.nextUrl.pathname === "/signup")
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`;
      url.search = "";
    } else {
      url.pathname = "/dashboard";
      url.search = "";
    }
    response = NextResponse.redirect(url);
  } else if (
    !user &&
    [
      "/dashboard",
      "/inbox",
      "/contacts",
      "/pipelines",
      "/broadcasts",
      "/automations",
      "/settings",
      "/help",
    ].some((p) => request.nextUrl.pathname.startsWith(p))
  ) {
    // Protected pages — redirect to login if not authenticated.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    response = NextResponse.redirect(url);
  } else if (
    !user &&
    request.nextUrl.pathname.startsWith("/api/whatsapp/") &&
    !request.nextUrl.pathname.includes("/webhook")
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  } else {
    response = NextResponse.next();
  }

  // Forward the Supabase-compatible JWT in a non-HTTP-only cookie so the
  // browser supabase-js client can inject it as the Authorization header.
  // This lets PostgREST see the correct auth.uid() and role on every
  // client-side query without any code changes to existing components.
  //
  // Exception: /reset-password uses sb-access-token as the recovery JWT
  // set by /auth/confirm — never overwrite or delete it on that path.
  const secure = process.env.NODE_ENV === "production";
  const isResetPassword = request.nextUrl.pathname.startsWith("/reset-password");
  if (!isResetPassword) {
    if (session?.supabaseAccessToken) {
      response.cookies.set("sb-access-token", session.supabaseAccessToken, {
        httpOnly: false,
        secure,
        sameSite: "lax",
        maxAge: 3600,
        path: "/",
      });
    } else {
      response.cookies.delete("sb-access-token");
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
