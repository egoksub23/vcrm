"use client";

// "Continue with Google" / "Continue with Microsoft" — shared by
// /login and /signup (Supabase Auth's signInWithOAuth() call is
// identical for both cases; there's no separate "OAuth signup" flow to
// build). Requires the Google/Azure providers to be configured in
// Supabase Auth first (owner-side dashboard/env config, not app code —
// see docs/sso-login-setup.md) and the new /auth/callback route to
// exchange the returned code for a session.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type OAuthProvider = "google" | "azure";

interface AuthOAuthSectionProps {
  /** Where to land after a successful round-trip — e.g. "/dashboard" or
   *  "/join/<token>" when arriving via an invite link (mirrors the
   *  password-login flow's own `destination` choice). */
  next: string;
  onError: (message: string) => void;
}

/** OAuth buttons plus the "or continue with email" divider above the
 *  existing password form — one unit since the two pages always render
 *  them together, in the same order. */
export function AuthOAuthSection({ next, onError }: AuthOAuthSectionProps) {
  const t = useTranslations("AuthOAuth");
  const [loadingProvider, setLoadingProvider] = useState<OAuthProvider | null>(null);

  const handleOAuth = async (provider: OAuthProvider) => {
    onError("");
    setLoadingProvider(provider);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      onError(error.message);
      setLoadingProvider(null);
    }
    // On success Supabase immediately navigates the browser to the
    // provider's consent screen — there's nothing further to do here.
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={loadingProvider !== null}
          onClick={() => handleOAuth("google")}
          className="w-full border-border text-foreground hover:bg-muted disabled:opacity-50"
        >
          {loadingProvider === "google" && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("continueWithGoogle")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={loadingProvider !== null}
          onClick={() => handleOAuth("azure")}
          className="w-full border-border text-foreground hover:bg-muted disabled:opacity-50"
        >
          {loadingProvider === "azure" && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("continueWithMicrosoft")}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">{t("orDivider")}</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
