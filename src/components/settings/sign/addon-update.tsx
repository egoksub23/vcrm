"use client";

// ============================================================
// Settings > Doc Sign > Add-ons, F-81: "Update available" on an installed add-on, with what changed (the add-on's own words, in the
// reader's language) and the Update button; and the note that says what an update did to each template afterwards (a new version, a copy
// beside a template that had been edited, or nothing). The rule itself is lib/sign/addons/update.ts.
// ============================================================

import { useLocale, useTranslations } from "next-intl";
import { Loader2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AddonCard } from "@/lib/sign/addons/install";
import type { UpdateResult } from "@/lib/sign/addons/update";

/** The change lines of the add-on in the reader's language, English where it has no wording in theirs. Newest version last. */
export function changeLines(changes: AddonCard["changes"], locale: string): { version: string; items: string[] }[] {
  return changes.map((c) => {
    const own = (c.items as Record<string, string[] | undefined>)[locale];
    return { version: c.version, items: own && own.length > 0 ? own : c.items.en };
  });
}

export function UpdatePanel({ card, busy, disabled, onUpdate }: { card: AddonCard; busy: boolean; disabled: boolean; onUpdate: () => void }) {
  const t = useTranslations("Sign.admin.addons");
  const locale = useLocale();
  if (!card.updateAvailable) return null;
  const lines = changeLines(card.changes, locale);
  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft/40 p-3" aria-label={t("updateTitle", { version: card.version })}>
      <p className="text-sm font-medium text-foreground">{t("updateTitle", { version: card.version })}</p>
      {lines.map((c) => (
        <ul key={c.version} className="list-disc space-y-1 pl-5 text-sm text-foreground">
          {c.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ))}
      <p className="text-xs text-muted-foreground">{t("updateIntro")}</p>
      <Button onClick={onUpdate} disabled={disabled}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        {t("updateButton", { version: card.version })}
      </Button>
    </div>
  );
}

/** What the update did, template by template. Stays on screen until dismissed, so a copy that was made is not missed. */
export function UpdateResultNote({ name, result, onDismiss }: { name: string; result: UpdateResult; onDismiss: () => void }) {
  const t = useTranslations("Sign.admin.addons");
  return (
    <div role="status" className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-foreground">{t("result.title", { name, version: result.toVersion })}</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("result.dismiss")} onClick={onDismiss}>
          <X />
        </Button>
      </div>
      <ul className="space-y-1 text-muted-foreground">
        {result.templates.map((tpl) => (
          <li key={`${tpl.name}:${tpl.outcome}`}>
            {tpl.outcome === "updated"
              ? t("result.updated", { name: tpl.name, versionNo: tpl.versionNo })
              : tpl.outcome === "copied"
                ? t("result.copied", { name: tpl.name, copyName: tpl.copyName })
                : tpl.outcome === "missing"
                  ? t("result.missing", { name: tpl.name })
                  : t("result.current", { name: tpl.name })}
          </li>
        ))}
      </ul>
    </div>
  );
}
