"use client";

// "Continue with Google" / "Continue with Microsoft" — shared by
// /login and /signup. Phase 1: uses Auth.js signIn() instead of
// Supabase's signInWithOAuth(); Auth.js handles the OAuth round-trip at
// /api/auth/callback/* and then redirects to `callbackUrl`.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

type OAuthProvider = "google" | "azure";

const NEXTAUTH_PROVIDER: Record<OAuthProvider, string> = {
  google: "google",
  azure: "microsoft-entra-id",
};

interface AuthOAuthSectionProps {
  /** Where to land after a successful round-trip — e.g. "/dashboard" or
   *  "/join/<token>" when arriving via an invite link. Passed as
   *  `callbackUrl` to Auth.js, which sets it as the post-OAuth redirect. */
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
    try {
      // Auth.js navigates the browser to the provider's consent page.
      // On success it redirects to callbackUrl; the component never
      // re-renders so there's no need to call setLoadingProvider(null).
      await signIn(NEXTAUTH_PROVIDER[provider], { callbackUrl: next });
    } catch {
      onError(t("callbackFailed"));
      setLoadingProvider(null);
    }
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
