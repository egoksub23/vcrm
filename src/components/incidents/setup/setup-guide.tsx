"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Circle, Loader2, Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SetupStep } from "@/lib/incidents/platform/setup-guide";
import { api } from "./api";

/** The first thing an admin sees: from an empty school to a live one, each step opening the right page and ticking itself when done. */
export function SetupGuide() {
  const t = useTranslations("IncidentPlatform.guide");
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    void api<{ steps: SetupStep[] }>("/api/incidents/setup/status").then((res) => {
      if (!live) return;
      if (res.ok) setSteps(res.data.steps);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, []);

  const sendTest = async () => {
    setSending(true);
    const res = await api<{ to: string }>("/api/incidents/setup/test-notice", "POST");
    setSending(false);
    if (res.ok) toast.success(t("testSent", { to: res.data.to }));
    else toast.error(res.error);
  };

  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!steps) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const done = steps.filter((s) => s.done).length;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium" aria-live="polite">{t("progress", { done, total: steps.length })}</p>
      <ol className="flex flex-col gap-3">
        {steps.map((step, i) => (
          <li key={step.key} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <span
              className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border", step.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border text-muted-foreground")}
              aria-label={step.done ? t("done") : t("todo")}
            >
              {step.done ? <Check className="size-3.5" /> : <Circle className="size-3 opacity-0" />}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{i + 1}. {t(`steps.${step.key}.title`)}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{t(`steps.${step.key}.help`)}</p>
              <p className="mt-1 text-xs text-foreground/80">{t(`steps.${step.key}.${step.done ? "doneFact" : "todoFact"}`, step.facts)}</p>
            </div>
            <Button variant={step.done ? "outline" : "default"} size="sm" render={<Link href={step.href} />}>
              {step.done ? t("change") : t("open")}
            </Button>
          </li>
        ))}
      </ol>

      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-4">
        <Mail className="mt-0.5 size-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t("test.title")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("test.help")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={sending}>
          {sending ? <Loader2 className="animate-spin" /> : null}
          {t("test.send")}
        </Button>
      </div>
    </div>
  );
}
