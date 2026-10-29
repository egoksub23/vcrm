"use client";

// ============================================================
// ShareGate — shown when a Secure Share link requires an email
// capture or OTP before the document is visible.
//
// email gate: asks for email → POST gate/submit_email → cleared
// otp gate:   asks for email → POST gate/request_otp → shows
//             code input → POST gate/verify_otp → cleared
//
// On success calls router.refresh() so the server component
// re-runs loadShare() with the new session cookie in place.
// ============================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Mail } from "lucide-react";

interface ShareGateProps {
  token: string;
  title: string;
  gateType: "email" | "otp";
  product: string;
}

type Step = "email" | "code";

export function ShareGate({ token, title, gateType, product }: ShareGateProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);

  const gateUrl = `/api/share/public/${token}/gate`;

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError(null);
    setLoading(true);

    try {
      if (gateType === "email") {
        const res = await fetch(gateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit_email", email: email.trim() }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError((d as { error?: string }).error ?? "Something went wrong.");
          return;
        }
        router.refresh();
      } else {
        // OTP gate: request the code
        const res = await fetch(gateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "request_otp", email: email.trim() }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError((d as { error?: string }).error ?? "Something went wrong.");
          return;
        }
        const d = await res.json();
        setOtpSent((d as { sent?: boolean }).sent ?? false);
        setStep("code");
      }
    } catch {
      setError("Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(gateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify_otp", email: email.trim(), code }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((d as { error?: string }).error ?? "Incorrect code.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resendOtp() {
    setError(null);
    setLoading(true);
    try {
      await fetch(gateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_otp", email: email.trim() }),
      });
      setCode("");
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col">
      <header className="sticky top-0 z-10 bg-background border-b border-border px-4 py-3 flex items-center gap-3">
        <FileText className="size-5 text-primary shrink-0" />
        <p className="text-sm font-semibold text-foreground truncate flex-1">{title}</p>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-xl border border-border bg-background shadow-sm p-6 space-y-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Mail className="size-5 text-primary shrink-0" />
              <h1 className="text-base font-semibold text-foreground">
                {step === "email"
                  ? gateType === "otp"
                    ? "Verify your email to continue"
                    : "Enter your email to continue"
                  : "Enter your verification code"}
              </h1>
            </div>
            <p className="text-sm text-muted-foreground pl-7">
              {step === "email"
                ? gateType === "otp"
                  ? "We'll send a 6-digit code to your email address."
                  : "The sender wants to know who is viewing this document."
                : otpSent
                ? `We sent a 6-digit code to ${email}. It expires in 10 minutes.`
                : `Enter the 6-digit code sent to ${email}.`}
            </p>
          </div>

          {step === "email" ? (
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoFocus
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={!email.trim() || loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading && <Loader2 className="size-3.5 animate-spin" />}
                {gateType === "otp" ? "Send code" : "View document"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit} className="space-y-3">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoFocus
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 tracking-widest text-center font-mono text-lg"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={code.length !== 6 || loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading && <Loader2 className="size-3.5 animate-spin" />}
                Verify and view
              </button>
              <button
                type="button"
                onClick={resendOtp}
                disabled={loading}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Resend code
              </button>
            </form>
          )}
        </div>
      </main>

      <footer className="py-3 text-center text-xs text-muted-foreground border-t border-border">
        Shared via {product}
      </footer>
    </div>
  );
}
