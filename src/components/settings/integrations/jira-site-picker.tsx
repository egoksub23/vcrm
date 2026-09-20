"use client";

// Shown after an Atlassian sign-in that reached more than one Jira site
// (?jira=pick&pending=<id>): choose the one this workspace connects to.
// Presentational; the panel loads the sites and posts the choice.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

import type { JiraSite } from "./jira-api";

export interface JiraSitePickerProps {
  /** null while loading. */
  sites: JiraSite[] | null;
  /** A sentence to show when the sites could not be loaded (expired sign-in ...). */
  error: string | null;
  busy: boolean;
  onPick: (cloudId: string) => void;
  onCancel: () => void;
}

export function JiraSitePicker({ sites, error, busy, onPick, onCancel }: JiraSitePickerProps) {
  const t = useTranslations("Settings.jira.sitePicker");
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = chosen ?? (sites && sites.length === 1 ? sites[0].id : null);

  return (
    <div className="rounded-xl border border-primary-soft-2 bg-primary-soft/40 p-4">
      <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : sites === null ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          {t("loading")}
        </div>
      ) : sites.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="mt-3 space-y-2" role="radiogroup" aria-label={t("title")}>
          {sites.map((site) => (
            <li key={site.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="jira-site"
                  value={site.id}
                  checked={selected === site.id}
                  onChange={() => setChosen(site.id)}
                  disabled={busy}
                  className="size-4 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{site.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{site.url}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => selected && onPick(selected)} disabled={!selected || busy || !!error}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("connect")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
