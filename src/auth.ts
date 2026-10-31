// ============================================================
// Auth.js v5 configuration.
//
// Phase 1 of the Supabase → self-hosted PG migration:
//   • Session management moves from @supabase/ssr to Auth.js JWT cookies.
//   • Password verification still delegates to Supabase's GoTrue API
//     (transitional — will switch to bcrypt on self-hosted PG in Phase 2).
//   • The jwt/session callbacks produce a Supabase-compatible JWT
//     (role:"authenticated", sub:<uuid>) so PostgREST and every existing
//     RLS policy continue to work with zero query-layer changes.
//
// Named exports consumed by the rest of the app:
//   handlers — GET/POST for /api/auth/[...nextauth]
//   auth      — server-side session (import in Server Components, API routes)
//   signIn    — programmatic sign-in (used in login page action)
//   signOut   — programmatic sign-out
// ============================================================

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { SignJWT } from "jose";

import { supabaseAdmin } from "@/lib/flows/admin-client";

// ── Supabase-compatible JWT ──────────────────────────────────
// PostgREST validates JWTs with SUPABASE_JWT_SECRET and reads auth.uid()
// from the `sub` claim and the `role` claim for row-level decisions.
// Producing it here keeps the token format exactly what PostgREST expects.

const SUPABASE_JWT_SECRET = new TextEncoder().encode(
  process.env.SUPABASE_JWT_SECRET!,
);

async function makeSupabaseJwt(userId: string, email: string): Promise<string> {
  return new SignJWT({
    sub: userId,
    role: "authenticated",
    email,
    aud: "authenticated",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("60m")
    .sign(SUPABASE_JWT_SECRET);
}

// ── Credentials: delegate to Supabase GoTrue for Phase 1 ────
// In Phase 2 (self-hosted PG cutover) this will switch to bcrypt
// against auth.users.password_hash, eliminating the GoTrue call.

async function verifyCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string; name: string } | null> {
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      user: { id: string; email: string; user_metadata?: { full_name?: string } };
    };
    return {
      id: data.user.id,
      email: data.user.email,
      name: data.user.user_metadata?.full_name ?? "",
    };
  } catch {
    return null;
  }
}

// ── OAuth: find or create the user in auth.users ─────────────
async function findOrCreateOAuthUser(
  email: string,
  name: string,
): Promise<string> {
  // Look up the user via GoTrue admin REST API (supabase-js v2 has no getUserByEmail).
  const adminRes = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
    },
  );
  const { users } = (await adminRes.json()) as {
    users?: Array<{ id: string; email: string }>;
  };
  const existing = users?.find(
    (u) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (existing) return existing.id;

  // New OAuth user — create in auth.users so the profiles trigger fires.
  const { data: created, error } =
    await supabaseAdmin().auth.admin.createUser({
      email,
      user_metadata: { full_name: name },
      email_confirm: true,
    });
  if (error || !created?.user)
    throw new Error(`OAuth user creation failed: ${error?.message}`);
  return created.user.id;
}

// ── Auth.js config ───────────────────────────────────────────

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;
        return verifyCredentials(email, password);
      },
    }),

    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      authorization: { params: { access_type: "offline", prompt: "consent" } },
    }),

    MicrosoftEntraID({
      clientId: process.env.AUTH_AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AUTH_AZURE_AD_CLIENT_SECRET!,
      issuer: process.env.AUTH_AZURE_AD_TENANT_ID
        ? `https://login.microsoftonline.com/${process.env.AUTH_AZURE_AD_TENANT_ID}/v2.0`
        : undefined,
    }),
  ],

  session: { strategy: "jwt" },

  callbacks: {
    async signIn({ user, account }) {
      // For OAuth providers, ensure the user exists in auth.users.
      if (account?.type === "oauth" && user.email) {
        try {
          user.id = await findOrCreateOAuthUser(
            user.email,
            user.name ?? user.email,
          );
        } catch (err) {
          console.error("[auth] OAuth user creation failed:", err);
          return false;
        }
      }
      return true;
    },

    async jwt({ token, user }) {
      // Persist the auth.users UUID into the JWT sub on first sign-in.
      if (user?.id) {
        token.sub = user.id;
        token.email = user.email ?? undefined;
      }
      return token;
    },

    async session({ session, token }) {
      // Attach the user UUID to the session so server code can read it.
      if (token.sub) session.user.id = token.sub;

      // Create a fresh Supabase-compatible JWT for this session window.
      // Runs server-side only — the result is exposed to client JS via
      // useSession() so the browser Supabase client can pass it as the
      // Authorization header.
      if (token.sub && session.user.email) {
        session.supabaseAccessToken = await makeSupabaseJwt(
          token.sub,
          session.user.email,
        );
      }

      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },
});
