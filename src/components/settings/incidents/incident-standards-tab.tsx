"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Building2, CheckCircle2, Loader2, ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { invalidateIncidentStandardCache } from "@/hooks/use-incident-standard";
import { useAuth } from "@/hooks/use-auth";

interface AvailableStandard {
  id: string;
  slug: string;
  name: string;
  regulatory_body: string | null;
  sector: string | null;
  description: string | null;
  kind: "template" | "framework";
  type_count: number;
  severity_count: number;
  rule_count: number;
  is_active: boolean;
}

/**
 * Settings > Incidents > Standards. An account has ONE incident template
 * (its categories and severity scale) and any number of compliance
 * frameworks (PDPA, ISO 27035, ISO 45001 ...) whose obligations are added to
 * each incident that matches them.
 */
export function IncidentStandardsTab() {
  const t = useTranslations("Settings.incidents.standards");
  const { accountId } = useAuth();

  const [standards, setStandards] = useState<AvailableStandard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/incidents/settings/standard");
      if (!res.ok) throw new Error("Failed to load standards");
      const json = (await res.json()) as { standards: AvailableStandard[] };
      setStandards(json.standards ?? []);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  async function setActive(std: AvailableStandard, isActive: boolean) {
    setBusy(std.id);
    setError(null);
    try {
      const res = await fetch("/api/incidents/settings/standard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ standard_id: std.id, is_active: isActive }),
      });
      if (!res.ok) throw new Error("Failed to switch");
      if (accountId) invalidateIncidentStandardCache(accountId);
      setStandards((prev) =>
        prev.map((s) => {
          if (s.id === std.id) return { ...s, is_active: isActive };
          // Switching templates turns the previous one off.
          if (std.kind === "template" && s.kind === "template" && isActive) return { ...s, is_active: false };
          return s;
        }),
      );
    } catch {
      setError(t("switchFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  const templates = standards.filter((s) => s.kind === "template");
  const frameworks = standards.filter((s) => s.kind === "framework");
  const activeTemplate = templates.find((s) => s.is_active);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">{error}</div>
      ) : null}

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("templatesHeading")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("templatesHint")}</p>
        </div>
        {templates.map((std) => (
          <StandardCard
            key={std.id}
            std={std}
            icon={std.is_active ? <CheckCircle2 className="size-4" /> : <Building2 className="size-4" />}
            action={
              std.is_active ? (
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {t("activeLabel")}
                </span>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0" disabled={busy !== null} onClick={() => setActive(std, true)}>
                  {busy === std.id ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  {busy === std.id ? t("activating") : t("useTemplate")}
                </Button>
              )
            }
            counts={
              <>
                <Count n={std.type_count} label={t("typesCount")} />
                <Count n={std.severity_count} label={t("levelsCount")} />
              </>
            }
          />
        ))}
        {activeTemplate?.slug === "bnm_rmit" ? (
          <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">
            <Building2 className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("bnmNote")}</span>
          </div>
        ) : null}
        <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">{t("switchNote")}</div>
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("frameworksHeading")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("frameworksHint")}</p>
        </div>
        {frameworks.map((std) => (
          <StandardCard
            key={std.id}
            std={std}
            icon={<ScrollText className="size-4" />}
            action={
              <Button
                size="sm"
                variant={std.is_active ? "secondary" : "outline"}
                className="shrink-0"
                disabled={busy !== null}
                onClick={() => setActive(std, !std.is_active)}
              >
                {busy === std.id ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                {std.is_active ? t("switchOff") : t("switchOn")}
              </Button>
            }
            counts={<Count n={std.rule_count} label={t("rulesCount")} />}
          />
        ))}
        <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">{t("frameworksNote")}</div>
      </section>
    </div>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="text-xs text-muted-foreground">
      <span className="font-semibold text-foreground">{n}</span> {label}
    </span>
  );
}

function StandardCard({
  std,
  icon,
  action,
  counts,
}: {
  std: AvailableStandard;
  icon: React.ReactNode;
  action: React.ReactNode;
  counts: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        std.is_active ? "border-primary/30 bg-primary/5" : "border-border bg-background"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
            std.is_active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{std.name}</p>
              {std.regulatory_body ? <p className="mt-0.5 text-xs text-muted-foreground">{std.regulatory_body}</p> : null}
            </div>
            {action}
          </div>
          {std.description ? (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{std.description}</p>
          ) : null}
          <div className="mt-2.5 flex gap-4">{counts}</div>
        </div>
      </div>
    </div>
  );
}
