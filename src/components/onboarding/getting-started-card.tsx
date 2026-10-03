"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Check, Circle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useCapability } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { parseOnboardingFacts, summarizeOnboarding, type OnboardingFacts } from "@/lib/onboarding/checklist";

/**
 * The first-run checklist on the dashboard (migration 155) for a new workspace's admins: connect a
 * channel, invite the team, add contacts, then three optional extras. It reads what really exists,
 * so it is always accurate; it hides itself when everything is done, and "Hide" hides it for the
 * whole workspace.
 */
export function GettingStartedCard() {
  const t = useTranslations("Onboarding");
  const { capabilities } = useAuth();
  const canSee = useCapability("settings.workspace");
  const [facts, setFacts] = useState<OnboardingFacts | null>(null);
  const [hiding, setHiding] = useState(false);

  useEffect(() => {
    if (!canSee) return;
    let alive = true;
    void fetch("/api/account/onboarding", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { facts?: unknown } | null) => {
        if (alive) setFacts(parseOnboardingFacts(b?.facts));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [canSee]);

  if (!canSee || !facts) return null;
  const summary = summarizeOnboarding(facts);
  if (!summary.visible) return null;

  const hide = async () => {
    setHiding(true);
    try {
      await fetch("/api/account/onboarding", { method: "POST" });
      setFacts({ ...facts, dismissed: true });
    } finally {
      setHiding(false);
    }
  };

  const pct = Math.round((summary.requiredDone / summary.requiredTotal) * 100);

  return (
    <Card className="border-primary/30 bg-card">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {summary.allRequiredDone ? t("titleExtras") : t("title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {summary.allRequiredDone ? t("descriptionExtras") : t("description", { done: summary.requiredDone, total: summary.requiredTotal })}
            </p>
          </div>
          <Button size="sm" variant="ghost" disabled={hiding} onClick={() => void hide()} aria-label={t("hide")}>
            <X className="mr-1 h-4 w-4" />
            {t("hide")}
          </Button>
        </div>

        {!summary.allRequiredDone && (
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t("progress")}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        )}

        <ul className="divide-y divide-border rounded-lg border border-border">
          {summary.steps.map((s) => {
            const canAct = capabilities.has(s.capability);
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                {s.done ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium ${s.done ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {t(`step.${s.id}.title`)}
                    {!s.required && <span className="ml-2 text-xs font-normal text-muted-foreground">{t("optional")}</span>}
                  </p>
                  {!s.done && <p className="text-xs text-muted-foreground">{t(`step.${s.id}.hint`)}</p>}
                </div>
                {!s.done && canAct && (
                  <Button size="sm" variant={summary.next === s.id ? "default" : "outline"} render={<Link href={s.href} />}>
                    {t(`step.${s.id}.action`)}
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
