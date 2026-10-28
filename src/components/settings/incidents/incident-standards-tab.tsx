"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Building2, CheckCircle2, Loader2 } from "lucide-react";

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
  type_count: number;
  severity_count: number;
  is_active: boolean;
}

export function IncidentStandardsTab() {
  const t = useTranslations("Settings.incidents.standards");
  const { accountId } = useAuth();

  const [standards, setStandards] = useState<AvailableStandard[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
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

  async function activate(standardId: string) {
    setSwitching(standardId);
    setError(null);
    try {
      const res = await fetch("/api/incidents/settings/standard", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ standard_id: standardId }),
      });
      if (!res.ok) throw new Error("Failed to switch");
      if (accountId) invalidateIncidentStandardCache(accountId);
      setStandards((prev) =>
        prev.map((s) => ({ ...s, is_active: s.id === standardId })),
      );
    } catch {
      setError(t("switchFailed"));
    } finally {
      setSwitching(null);
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

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  const active = standards.find((s) => s.is_active);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {standards.map((std) => (
          <div
            key={std.id}
            className={`rounded-xl border p-4 transition-colors ${
              std.is_active
                ? "border-primary/30 bg-primary/5"
                : "border-border bg-background"
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
                  std.is_active
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {std.is_active ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <Building2 className="size-4" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{std.name}</p>
                    {std.regulatory_body ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{std.regulatory_body}</p>
                    ) : null}
                  </div>
                  {std.is_active ? (
                    <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                      {t("activeLabel")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={switching !== null}
                      onClick={() => activate(std.id)}
                    >
                      {switching === std.id ? (
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      ) : null}
                      {switching === std.id ? t("activating") : t("activate")}
                    </Button>
                  )}
                </div>

                {std.description ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">
                    {std.description}
                  </p>
                ) : null}

                <div className="mt-2.5 flex gap-4">
                  <span className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{std.type_count}</span>{" "}
                    {t("typesCount")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{std.severity_count}</span>{" "}
                    {t("levelsCount")}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {active?.slug === "bnm_rmit" ? (
        <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">
          <Building2 className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("bnmNote")}</span>
        </div>
      ) : null}

      <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-[12.5px] text-muted-foreground">
        {t("switchNote")}
      </div>
    </div>
  );
}
