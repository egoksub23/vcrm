import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    /** Supabase-compatible JWT — passed to PostgREST so auth.uid() and RLS
     *  continue to work exactly as before.  Exposed to the client so the
     *  supabase-js browser client can inject it as the Authorization header. */
    supabaseAccessToken: string;
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Cached JWT payload signed with JWT_SECRET. */
    supabaseJwt?: string;
  }
}
