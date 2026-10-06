"use client";

// ============================================================
// Doc Sign forms, the sender's view: how far one person has got. The person and their role, a bar with "3 of 7
// parts", each part with its state and when it was last saved, when and from what they were last active, and
// Remind (which names the parts still open).
// ============================================================

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Bell, Check, Circle, CircleDot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import { showsCount, type DeviceKind, type PartLine, type RoleView } from "@/lib/sign/client/progress-logic";
import { SIGN_STATUS_NAMESPACE, signerBadgeClass, signerStatusKey } from "@/lib/sign/client/status";
import type { SignRole, SignerKind } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { formatWhen } from "../format";

interface Props {
  view: RoleView;
  /** The role as the document holds it (for its colour and whether it signs). */
  role: SignRole | undefined;
  device: DeviceKind | null;
  now: number;
  /** Remind is offered (the person has not finished, the reader may send, and a day has passed since the last one). */
  canRemind: boolean;
  /** Remind is held back until then (an ISO time), when it is. */
  remindHeldUntil: string | null;
  onRemind: () => void;
}

/** A thin bar with a word beside it: colour is never the only signal. */
export function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label} className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function RoleProgressCard({ view, role, device, now, canRemind, remindHeldUntil, onRemind }: Props) {
  const t = useTranslations("Sign.progress");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const f = useFormatter();
  const locale = useLocale();
  const kind: SignerKind = role?.kind ?? "signer";
  const when = view.lastActivityAt ? f.relativeTime(new Date(view.lastActivityAt), now) : null;

  return (
    <li className="grid gap-3 p-4" data-role={view.roleKey}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
            <span className="break-words">{view.signer?.name || t("nobodyAssigned")}</span>
            <span style={roleColorStyle(role?.color ?? 0)} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", ROLE_CLASS.chip)}>
              <span className={cn("size-1.5 rounded-full", ROLE_CLASS.dot)} aria-hidden />
              {view.roleLabel}
            </span>
          </p>
          {view.signer?.email && <p className="mt-0.5 break-all text-xs text-muted-foreground">{view.signer.email}</p>}
        </div>
        {view.signer && <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", signerBadgeClass(view.signer.status))}>{ts(signerStatusKey(view.signer.status, kind))}</span>}
      </div>

      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-medium text-foreground">{t("partsOf", { done: view.partsDone, total: view.parts.length })}</span>
          <span className="text-muted-foreground">{t("percent", { percent: view.percent })}</span>
        </div>
        <Bar percent={view.percent} label={t("barLabel", { name: view.signer?.name || view.roleLabel })} />
        <p className="text-xs text-muted-foreground">{when ? (device ? t("lastActivityFrom", { when, device: t(`device.${device}`) }) : t("lastActivity", { when })) : t("noActivity")}</p>
      </div>

      {view.parts.length > 0 && (
        <ol className="divide-y divide-border rounded-lg border border-border" aria-label={t("partsList", { name: view.roleLabel })}>
          {view.parts.map((p) => (
            <PartRow key={p.key} part={p} locale={locale} />
          ))}
        </ol>
      )}

      {kind === "filler" && <p className="text-xs text-muted-foreground">{t("fillerNote")}</p>}

      {(canRemind || remindHeldUntil) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canRemind} onClick={onRemind} aria-describedby={remindHeldUntil ? `held-${view.roleKey}` : undefined}>
            <Bell aria-hidden />
            {t("remind.button")}
          </Button>
          {remindHeldUntil && (
            <span id={`held-${view.roleKey}`} className="text-xs text-muted-foreground">
              {t("remind.held", { when: formatWhen(remindHeldUntil, locale) })}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

const STATE_CLASS: Record<PartLine["state"], string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  in_progress: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  not_started: "bg-muted text-muted-foreground",
};

function PartRow({ part, locale }: { part: PartLine; locale: string }) {
  const t = useTranslations("Sign.progress");
  const Icon = part.state === "done" ? Check : part.state === "in_progress" ? CircleDot : Circle;
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[1.4fr_1fr_1fr]">
      <span className="min-w-0 break-words text-foreground">
        <span className="text-muted-foreground">{part.number > 0 ? `${part.number} ` : ""}</span>
        {part.title}
      </span>
      <span className={cn("inline-flex h-5 w-fit items-center gap-1 justify-self-end rounded-full px-2 text-xs font-medium sm:justify-self-start", STATE_CLASS[part.state])}>
        <Icon className="size-3" aria-hidden />
        {t(`state.${part.state}`)}
        {part.state === "in_progress" && showsCount(part) ? <span>{` · ${t("count", { done: part.done, total: part.total })}`}</span> : null}
      </span>
      <span className="col-span-2 text-xs text-muted-foreground sm:col-span-1">
        {part.heldBy ? <span className="mr-2 font-medium text-foreground">{t(part.heldBy.done ? "heldByDone" : "heldBy", { name: part.heldBy.name })}</span> : null}
        {part.lastSavedAt ? t("savedAt", { when: formatWhen(part.lastSavedAt, locale) }) : t("notSaved")}
      </span>
    </li>
  );
}
