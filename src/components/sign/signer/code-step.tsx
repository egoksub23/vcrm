"use client";

// ============================================================
// Doc Sign, signing page: the code, when the sender asked for one. "Send me a code", six digits (a numeric
// keypad on a phone, filled in from a text message where the phone offers it), "send again" after a wait,
// and a plain statement of what went wrong with how many tries are left. Nothing of the document is shown
// before this is done.
// ============================================================

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { ActionResult } from "./use-signer";
import { useErrorText } from "./errors";

/** Seconds a person waits before asking for another code. */
export const RESEND_WAIT_SECONDS = 60;

interface CodeStepProps {
  title: string;
  /** The session ended while they were working: their answers are kept. */
  sessionExpired: boolean;
  onSend: () => Promise<ActionResult<{ sent: true; to: string }>>;
  onVerify: (code: string) => Promise<ActionResult>;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function CodeStep({ title, sessionExpired, onSend, onVerify }: CodeStepProps) {
  const t = useTranslations("Sign.signer");
  const errorText = useErrorText();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const messageId = useId();

  // one tick a second, only while there is a wait to show
  const waiting = waitUntil > now;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const secondsLeft = waiting ? Math.max(1, Math.ceil((waitUntil - now) / 1000)) : 0;

  async function send() {
    setSending(true);
    setMessage(null);
    const result = await onSend();
    setSending(false);
    if (result.ok) {
      setSent(true);
      setSentTo(result.value.to || null);
      const start = Date.now();
      setNow(start);
      setWaitUntil(start + RESEND_WAIT_SECONDS * 1000);
      setCode("");
      input.current?.focus();
    } else if (!result.handled) {
      setMessage(errorText(result.error));
    }
  }

  async function verify(digits: string) {
    setChecking(true);
    setMessage(null);
    const result = await onVerify(digits);
    // on success the page moves on and this screen goes with it
    setChecking(false);
    if (!result.ok && !result.handled) {
      setMessage(errorText(result.error));
      setCode("");
      input.current?.focus();
    }
  }

  function change(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !checking) void verify(digits);
  }

  return (
    <section className="space-y-5" aria-labelledby="code-title">
      <div className="space-y-2">
        <h1 id="code-title" className="text-xl font-semibold leading-snug">
          {t("code.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-sm">{t("code.intro")}</p>
      </div>

      {sessionExpired ? (
        <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {t("code.sessionExpired")}
        </p>
      ) : null}

      <div className="space-y-2">
        <Button type="button" className="h-12 w-full text-base" variant={sent ? "outline" : "default"} onClick={() => void send()} disabled={sending || waiting}>
          {sending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Mail className="size-4" aria-hidden />}
          {waiting ? t("code.resendIn", { time: clock(secondsLeft) }) : sent ? t("code.resend") : t("code.send")}
        </Button>
        <p role="status" className="min-h-5 text-sm text-muted-foreground">
          {sent ? (sentTo ? t("code.sentTo", { to: sentTo }) : t("code.sent")) : ""}
        </p>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6 && !checking) void verify(code);
        }}
      >
        <label htmlFor={inputId} className="block text-sm font-medium">
          {t("code.inputLabel")}
        </label>
        <Input
          ref={input}
          id={inputId}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          // the code is typed once the person has asked for it; the keyboard is not forced up before then
          autoFocus={sent}
          placeholder="000000"
          className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          onChange={(e) => change(e.target.value)}
        />
        {message ? (
          <p id={messageId} role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {message}
          </p>
        ) : null}
        <Button type="submit" className="h-12 w-full text-base" disabled={code.length !== 6 || checking}>
          {checking ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
          {checking ? t("code.checking") : t("common.continue")}
        </Button>
      </form>
    </section>
  );
}
