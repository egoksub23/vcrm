import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knob ---------------------------------------------------------
// `mockSession` — the session `auth()` resolves to.
let mockSession: {
  user: { id: string; email: string };
  supabaseAccessToken: string;
} | null = null;

vi.mock("@/auth", () => ({
  auth: async () => mockSession,
}));

const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockSession = null;
});

afterEach(() => vi.clearAllMocks());

const SESSION = {
  user: { id: "user-1", email: "user@example.com" },
  supabaseAccessToken: "supabase-jwt-token",
};

describe("middleware — route protection and cookie injection", () => {
  it("redirects a signed-in user off /login to /dashboard", async () => {
    mockSession = SESSION;
    const res = await middleware(new NextRequest("https://app.test/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // Auth.js Supabase JWT cookie is set for signed-in users.
    expect(res.cookies.get("sb-access-token")?.value).toBe("supabase-jwt-token");
  });

  it("redirects an unauthenticated user from /dashboard to /login", async () => {
    mockSession = null;
    const res = await middleware(new NextRequest("https://app.test/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockSession = SESSION;
    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("passes through for a signed-in user on a protected page and sets sb-access-token", async () => {
    mockSession = SESSION;
    const res = await middleware(new NextRequest("https://app.test/dashboard"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-access-token")?.value).toBe("supabase-jwt-token");
  });

  it("clears sb-access-token when signed out", async () => {
    mockSession = null;
    // A signed-out visit to /login should not carry an active sb-access-token.
    // cookies.delete() in Next.js sets the cookie with expires=epoch, so the
    // cookie object may be present but with an empty value and past expiry.
    const res = await middleware(new NextRequest("https://app.test/login"));
    const cookie = res.cookies.get("sb-access-token");
    expect(!cookie || !cookie.value).toBe(true);
  });
});
