"use client";

// Settings > Doc Sign > Add-ons: the catalogue of ready-made packs, with each one's state for this workspace.
// Only the platform operator can make an add-on available; an Owner or Admin installs it. Installing is safe to
// repeat and never changes what the workspace has edited (lib/sign/addons/install.ts).

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, PackageCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { signRequest } from "@/lib/sign/client/api";
import type { AddonCard, InstallResult } from "@/lib/sign/addons/install";

import { Loading, useAdminErrorText } from "./shared";

type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; cards: AddonCard[] };

export function AddonsSection() {
  const t = useTranslations("Sign.admin.addons");
  const errorText = useAdminErrorText();
  const canEdit = useCapability("sign.settings");

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    signRequest<{ addons: AddonCard[] }>("/api/sign/addons")
      .then((r) => {
        if (live) setLoad({ status: "ready", cards: r.addons });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  const install = async (card: AddonCard) => {
    setInstalling(card.key);
    try {
      const { result } = await signRequest<{ result: InstallResult }>("/api/sign/addons", { method: "POST", json: { key: card.key } });
      const created = result.templates.created.length;
      toast.success(
        result.previousVersion === null
          ? t("installedToast", { name: t(card.nameKey) })
          : t("repeatedToast", { name: t(card.nameKey) }),
        { description: created > 0 ? t("templatesAdded", { count: created }) : undefined },
      );
      reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setInstalling(null);
    }
  };

  if (load.status === "loading") return <Loading label={t("loading")} />;
  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p className="text-destructive">{errorText(load.error)}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
      <ul className="grid gap-3 lg:grid-cols-2">
        {load.cards.map((card) => (
          <li key={card.key}>
            <AddonCardView card={card} busy={installing === card.key} disabled={!canEdit || installing !== null} onInstall={() => void install(card)} />
          </li>
        ))}
      </ul>
      {load.cards.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : null}
      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}

function AddonCardView({ card, busy, disabled, onInstall }: { card: AddonCard; busy: boolean; disabled: boolean; onInstall: () => void }) {
  const t = useTranslations("Sign.admin.addons");
  const installed = card.installed !== null;
  return (
    <article className="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby={`addon-${card.key}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
          <PackageCheck className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`addon-${card.key}`} className="text-sm font-semibold text-foreground">
              {t(card.nameKey)}
            </h3>
            {installed ? (
              <Badge variant="secondary">{t("installedVersion", { version: card.installed!.version })}</Badge>
            ) : card.available ? (
              <Badge variant="outline">{t("notInstalled")}</Badge>
            ) : (
              <Badge variant="outline">{t("unavailableBadge")}</Badge>
            )}
            {card.updateAvailable ? <Badge variant="outline">{t("updateAvailable", { version: card.version })}</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t(card.descriptionKey)}</p>
        </div>
      </div>

      <ul className="space-y-1 text-sm text-foreground">
        <li>{t("adds.category", { name: card.category.name })}</li>
        <li className="text-muted-foreground">
          {card.templates.installable > 0 ? t("adds.templates", { count: card.templates.installable }) : t("adds.templatesLater")}
        </li>
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
        {card.available ? (
          <Button onClick={onInstall} disabled={disabled} variant={installed ? "outline" : "default"}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {installed ? t("installAgain") : t("install")}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t("needsOperator")}</p>
        )}
        {installed && card.available ? <p className="text-xs text-muted-foreground">{t("installAgainHint")}</p> : null}
      </div>
    </article>
  );
}
