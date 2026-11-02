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
import bcrypt from "bcryptjs";

import { getPool } from "@/lib/postgres/client";

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

// ── Credentials: bcrypt against auth.users.encrypted_password ───────────────

async function verifyCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string; name: string } | null> {
  try {
    const sql = getPool();
    const rows = await sql`
      SELECT id, email, encrypted_password, raw_user_meta_data
        FROM auth.users
       WHERE email             = ${email}
         AND deleted_at        IS NULL
         AND email_confirmed_at IS NOT NULL
         AND is_sso_user       = false
    ` as unknown as Array<{
      id: string;
      email: string;
      encrypted_password: string | null;
      raw_user_meta_data: Record<string, unknown> | null;
    }>;
    if (rows.length === 0) return null;
    const user = rows[0];
    if (!user.encrypted_password) return null; // OAuth-only account
    const match = await bcrypt.compare(password, user.encrypted_password);
    if (!match) return null;
    return {
      id: user.id,
      email: user.email,
      name: (user.raw_user_meta_data?.full_name as string | undefined) ?? "",
    };
  } catch {
    return null;
  }
}

// ── OAuth: find or create the user in auth.users directly ────────────────────

async function findOrCreateOAuthUser(
  email: string,
  name: string,
): Promise<string> {
  const sql = getPool();

  // Find by exact email (case-insensitive via citext or LOWER).
  const existing = await sql`
    SELECT id FROM auth.users
     WHERE LOWER(email) = LOWER(${email})
       AND deleted_at IS NULL
     LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (existing.length > 0) return existing[0].id;

  // New OAuth user — INSERT directly so handle_new_user trigger fires and
  // builds the profile + account exactly as it did via GoTrue.
  const metaJson = JSON.stringify({ full_name: name });
  const created = await sql`
    INSERT INTO auth.users (
      id, instance_id, aud, role, email,
      email_confirmed_at, raw_user_meta_data, raw_app_meta_data,
      created_at, updated_at, is_anonymous, is_sso_user
    ) VALUES (
      gen_random_uuid(),
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated', ${email},
      NOW(), ${metaJson}::jsonb, '{}'::jsonb,
      NOW(), NOW(), false, false
    )
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (created.length === 0) throw new Error("OAuth user creation failed");
  return created[0].id;
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
