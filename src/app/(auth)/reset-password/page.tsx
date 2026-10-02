"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeyRound, MessageSquare } from "lucide-react";

const MIN_PASSWORD_LENGTH = 8;

// Landing page for "set / reset your password". Reached after
// /auth/callback (forgot-password's PKCE code) or /auth/confirm (the
// operator's new-workspace link) has already established a session, so
// the visitor is signed in just long enough to choose a password.
export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const supabase = createClient();

  // null = still checking, false = no session (link expired / reused).
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (active) setHasSession(Boolean(data.user));
    });
    return () => {
      active = false;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("tooShort", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirm) {
      setError(t("mismatch"));
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }
    // Full-page navigation so the middleware sees the refreshed cookies.
    window.location.href = "/dashboard";
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">{t("title")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {hasSession === false ? t("expired") : t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasSession === false ? (
            <Link href="/forgot-password">
              <Button className="w-full">{t("requestNew")}</Button>
            </Link>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t("newPassword")}
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={hasSession === null}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm" className="text-muted-foreground">
                  {t("confirmPassword")}
                </Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  disabled={hasSession === null}
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || hasSession === null}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {loading ? t("saving") : t("save")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
