"use client";

// Settings > Doc Sign > Sealing certificate: a read-only readout of the certificate every completed document
// is sealed with. The facts come from GET /api/sign/settings/certificate, which never returns the key.

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { certificateState } from "@/lib/sign/client/admin-settings";
import { signRequest } from "@/lib/sign/client/api";

import { Loading, useAdminErrorText } from "./shared";

interface CertificateFacts {
  name: string;
  subject: string | null;
  validUntil: string | null;
  selfSigned: boolean;
}

type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; certificate: CertificateFacts | null; now: Date };

export function CertificateSection() {
  const t = useTranslations("Sign.admin.certificate");
  const format = useFormatter();
  const errorText = useAdminErrorText();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    signRequest<{ certificate: CertificateFacts | null }>("/api/sign/settings/certificate")
      .then((r) => {
        if (live) setLoad({ status: "ready", certificate: r.certificate, now: new Date() });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, [round]);

  if (load.status === "loading") return <Loading label={t("loading")} />;
  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p className="text-destructive">{errorText(load.error)}</p>
        <Button variant="outline" size="sm" onClick={() => setRound((n) => n + 1)}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  const cert = load.certificate;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const status = cert ? certificateState(cert.validUntil, load.now) : null;

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      {cert ? (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-semibold text-foreground">{cert.name}</span>
            {status?.state === "valid" ? <Badge variant="secondary">{t("stateValid")}</Badge> : null}
            {status?.state === "expiring" ? <Badge variant="outline">{t("stateExpiring", { count: Math.max(status.daysLeft ?? 0, 0) })}</Badge> : null}
            {status?.state === "expired" ? <Badge variant="destructive">{t("stateExpired")}</Badge> : null}
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">{t("subject")}</dt>
            <dd className="break-words text-foreground">{cert.subject ?? t("unknown")}</dd>
            <dt className="text-muted-foreground">{t("validUntil")}</dt>
            <dd className="text-foreground">{cert.validUntil ? date(cert.validUntil) : t("unknown")}</dd>
            <dt className="text-muted-foreground">{t("kind")}</dt>
            <dd className="text-foreground">{cert.selfSigned ? t("kindSelfSigned") : t("kindOwn")}</dd>
          </dl>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("none")}</div>
      )}

      {status?.state === "expired" ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertTitle>{t("expiredTitle")}</AlertTitle>
          <AlertDescription>{t("expiredBody")}</AlertDescription>
        </Alert>
      ) : null}

      {!cert || cert.selfSigned ? (
        <Alert>
          <ShieldAlert aria-hidden />
          <AlertTitle>{t("selfSignedTitle")}</AlertTitle>
          <AlertDescription>{t("selfSignedBody")}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
