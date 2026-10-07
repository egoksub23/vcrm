"use client";

import { useRef } from "react";
import { AlertTriangle, CheckCircle2, Copy, MailWarning } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { SignChannel, SignMode, SignRole } from "@/lib/sign/types";

export interface SendResultData {
  documentId: string;
  reference: string | null;
  expiresAt: string;
  invited: {
    signerId: string;
    name: string;
    roleKey: string;
    delivery: { channel: SignChannel; status: "sent" | "failed" | "not_configured"; detail?: string };
    /** Only for an invitation that was not delivered. */
    link?: string;
  }[];
}

interface Props {
  result: SendResultData;
  roles: readonly SignRole[];
  ordered: boolean;
  onOpenDocument: () => void;
  /** A form without a signature (migration 169): "Form sent", and the link lets someone fill it in as that person. */
  mode?: SignMode;
  /** Migration 171: an envelope's own words for the heading, the line under it and the last button (an envelope is sent as one). */
  words?: { title: string; subtitle?: string; open: string };
}

/** After Send: who was invited and whether it got through; a link to pass on, privately, for any that did not. */
export function SendResult({ result, roles, ordered, onOpenDocument, mode, words }: Props) {
  const t = useTranslations("Sign.send.result");
  const failed = result.invited.filter((i) => i.delivery.status !== "sent");
  const linkInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const copy = async (id: string, link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t("copied"));
    } catch {
      // clipboard blocked: select the text so the sender can copy it by hand
      linkInputs.current[id]?.select();
      toast.error(t("copyFailed"));
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-1 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold text-foreground">{words ? words.title : t(mode === "form" ? "titleForm" : "title")}</h1>
        <p className="text-sm text-muted-foreground">{result.reference ? t("reference", { reference: result.reference }) : null}</p>
        {words?.subtitle ? <p className="text-sm text-muted-foreground">{words.subtitle}</p> : null}
        {ordered ? <p className="text-sm text-muted-foreground">{t("orderedNote")}</p> : null}
      </div>

      {failed.length > 0 ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <p>{t("someNotDelivered", { count: failed.length })}</p>
        </div>
      ) : null}

      <ul className="space-y-3">
        {result.invited.map((inv) => {
          const ok = inv.delivery.status === "sent";
          // a role the screen does not know (a collection's people) is an internal key: show nothing rather than "pp_z5vg003a"
          const role = roles.find((r) => r.key === inv.roleKey)?.label ?? "";
          return (
            <li key={inv.signerId} className="space-y-2 rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{inv.name}</p>
                  {role ? <p className="text-xs text-muted-foreground">{role}</p> : null}
                </div>
                <p className={ok ? "flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300" : "flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-300"}>
                  {ok ? <CheckCircle2 className="size-4" aria-hidden /> : <MailWarning className="size-4" aria-hidden />}
                  {ok ? t(`delivered.${inv.delivery.channel}`) : t(inv.delivery.status === "not_configured" ? `notConfigured.${inv.delivery.channel}` : `failed.${inv.delivery.channel}`)}
                </p>
              </div>
              {!ok && inv.link ? (
                <div className="space-y-1.5 rounded-lg bg-muted/50 p-3">
                  <label htmlFor={`link-${inv.signerId}`} className="text-xs font-medium text-foreground">
                    {t(mode === "form" ? "linkLabelForm" : "linkLabel", { name: inv.name })}
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`link-${inv.signerId}`}
                      ref={(el) => {
                        linkInputs.current[inv.signerId] = el;
                      }}
                      readOnly
                      value={inv.link}
                      onFocus={(e) => e.currentTarget.select()}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => void copy(inv.signerId, inv.link as string)}>
                      <Copy aria-hidden />
                      {t("copy")}
                    </Button>
                  </div>
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t(mode === "form" ? "privateWarningForm" : "privateWarning", { name: inv.name })}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex justify-center">
        <Button type="button" size="lg" onClick={onOpenDocument}>
          {words ? words.open : t("openDocument")}
        </Button>
      </div>
    </div>
  );
}
