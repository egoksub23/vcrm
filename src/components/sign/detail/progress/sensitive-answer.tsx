"use client";

// ============================================================
// Sensitive answers, the sender's view: the answer arrives masked (`•••• 1234`); "Reveal" asks the server for it, which
// writes a `sensitive_viewed` event first. The value is held in this component's memory only, and hides again after
// thirty seconds, when the tab is left, or on "Hide". It is never put in an attribute, the address or storage.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SignApiError } from "@/lib/sign/client/api";
import { asLocale, describeAnswer, type AnswerDisplay, type AnswerRowView } from "@/lib/sign/client/progress-logic";
import { REVEAL_SHOW_MS, revealErrorKey, revealSensitive } from "@/lib/sign/client/sensitive";

function Lines({ display, empty }: { display: AnswerDisplay; empty: string }) {
  if (display.kind === "text") return <span className="break-words whitespace-pre-wrap">{display.text}</span>;
  if (display.kind === "lines") {
    return (
      <ul className="grid gap-0.5">
        {display.lines.map((line, i) => (
          <li key={`${i}-${line}`} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    );
  }
  return <span className="text-muted-foreground">{empty}</span>;
}

export function SensitiveAnswer({ documentId, row, canReveal }: { documentId: string; row: AnswerRowView; canReveal: boolean }) {
  const t = useTranslations("Sign.progress");
  const lang = asLocale(useLocale());
  const [shown, setShown] = useState<AnswerDisplay | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setShown(null);
  }, []);

  // leaving the tab hides it, and so does leaving the screen
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hide]);

  async function reveal() {
    setBusy(true);
    try {
      const r = await revealSensitive(documentId, row.key);
      setShown(describeAnswer(row.type, r.value, undefined, lang));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, REVEAL_SHOW_MS);
    } catch (err) {
      toast.error(t(revealErrorKey(err instanceof SignApiError ? err.code : "request_failed")));
    } finally {
      setBusy(false);
    }
  }

  if (row.display.kind === "empty") return <span className="text-muted-foreground">{t("answers.notAnswered")}</span>;

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span aria-live="polite" className="min-w-0 font-mono text-sm">
          <Lines display={shown ?? row.display} empty={t("answers.notAnswered")} />
        </span>
        {canReveal &&
          (shown ? (
            <Button type="button" size="xs" variant="outline" onClick={hide} aria-label={t("sensitive.hideNamed", { name: row.label })}>
              <EyeOff aria-hidden />
              {t("sensitive.hide")}
            </Button>
          ) : (
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void reveal()} aria-label={t("sensitive.revealNamed", { name: row.label })}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Eye aria-hidden />}
              {t("sensitive.reveal")}
            </Button>
          ))}
      </div>
      <span className="text-xs text-muted-foreground">{shown ? t("sensitive.shownNote") : t("sensitive.note")}</span>
    </div>
  );
}
