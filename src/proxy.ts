import { auth } from "@/auth";
import { NextResponse, type NextRequest } from "next/server";
import { frameAncestors, readSessionToken } from "@/lib/incidents/intake/keys";

export async function proxy(request: NextRequest) {
  // The coach's report page (/report/<token>) and the acknowledge page are opened by people with no Halo login, often inside another site's frame or a
  // phone web view where third-party cookies are blocked. They need no session and must not set a cookie, so they skip the session handling below.
  // The report may be framed only by the origins registered for the key that issued the link; they are signed into the token, so no lookup is needed.
  if (request.nextUrl.pathname.startsWith("/report/")) {
    const token = decodeURIComponent(request.nextUrl.pathname.split("/")[2] ?? "");
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", frameAncestors(readSessionToken(token)?.origins ?? []));
    return response;
  }
  if (request.nextUrl.pathname.startsWith("/incident-ack/")) return NextResponse.next();

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

  // Forward the JWT in a non-HTTP-only cookie (sb-access-token) so any
  // server-side code that still reads it for PostgREST-style role checks
  // continues to work without changes.
  //
  // Exception: /reset-password uses sb-access-token as the recovery JWT
  // set by /auth/confirm — never overwrite or delete it on that path.
  const secure = process.env.NODE_ENV === "production";
  const isResetPassword =
    request.nextUrl.pathname.startsWith("/reset-password") ||
    request.nextUrl.pathname === "/api/auth/reset-password";
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
