"use client";

// Settings > Doc Sign > Sealing certificate, the read-out: the facts about the certificate in use, whatever is wrong
// with it, and what a PDF reader will say about it. Pure of data fetching, so it renders the same in a test.

import { useFormatter, useTranslations } from "next-intl";
import { ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { certificateState } from "@/lib/sign/client/admin-settings";
import { CERTIFICATE_WARNING_CODES, certificateKind, groupFingerprint, shortSerial, type CertificateView } from "@/lib/sign/client/certificate-view";

export function CertificateFacts({ cert, now }: { cert: CertificateView | null; now: Date }) {
  const t = useTranslations("Sign.admin.certificate");
  const format = useFormatter();

  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
  const status = cert ? certificateState(cert.validUntil, now) : null;
  const kind = cert ? certificateKind(cert) : "generated";
  const fingerprint = cert ? groupFingerprint(cert.fingerprint) : null;
  const serial = cert ? shortSerial(cert.serial) : null;

  return (
    <>
      {cert ? (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-semibold text-foreground break-words">{cert.name}</span>
            {status?.state === "valid" ? <Badge variant="secondary">{t("stateValid")}</Badge> : null}
            {status?.state === "expiring" ? <Badge variant="outline">{t("stateExpiring", { count: Math.max(status.daysLeft ?? 0, 0) })}</Badge> : null}
            {status?.state === "expired" ? <Badge variant="destructive">{t("stateExpired")}</Badge> : null}
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">{t("subject")}</dt>
            <dd className="break-words text-foreground">{cert.subject ?? t("unknown")}</dd>
            <dt className="text-muted-foreground">{t("issuer")}</dt>
            <dd className="break-words text-foreground">{cert.issuer ?? t("unknown")}</dd>
            <dt className="text-muted-foreground">{t("kind")}</dt>
            <dd className="text-foreground">{t(`kind_${kind}`)}</dd>
            <dt className="text-muted-foreground">{t("serial")}</dt>
            <dd className="break-all font-mono text-xs text-foreground" title={cert.serial ?? undefined}>
              {serial ?? t("unknown")}
            </dd>
            <dt className="text-muted-foreground">{t("validFrom")}</dt>
            <dd className="text-foreground">{cert.validFrom ? date(cert.validFrom) : t("unknown")}</dd>
            <dt className="text-muted-foreground">{t("validUntil")}</dt>
            <dd className="text-foreground">{cert.validUntil ? date(cert.validUntil) : t("unknown")}</dd>
            {status && status.daysLeft !== null && status.state !== "expired" ? (
              <>
                <dt className="text-muted-foreground">{t("daysLeft")}</dt>
                <dd className="text-foreground">{t("daysLeftValue", { count: status.daysLeft })}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("fingerprint")}</dt>
            <dd className="break-all font-mono text-xs text-foreground">{fingerprint ?? t("unknown")}</dd>
            {cert.keyBits ? (
              <>
                <dt className="text-muted-foreground">{t("key")}</dt>
                <dd className="text-foreground">{t("keyValue", { bits: cert.keyBits })}</dd>
              </>
            ) : null}
            {cert.chainLength ? (
              <>
                <dt className="text-muted-foreground">{t("chain")}</dt>
                <dd className="text-foreground">{cert.chainLength === 1 ? t("chainOne") : t("chainMany", { count: cert.chainLength })}</dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("none")}</div>
      )}

      {cert && !cert.readable ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertTitle>{t("unreadableTitle")}</AlertTitle>
          <AlertDescription>{t("unreadableBody")}</AlertDescription>
        </Alert>
      ) : null}

      {status?.state === "expired" ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertTitle>{t("expiredTitle")}</AlertTitle>
          <AlertDescription>{cert?.uploaded ? t("expiredBodyUploaded") : t("expiredBody")}</AlertDescription>
        </Alert>
      ) : null}

      {cert?.warnings.length
        ? CERTIFICATE_WARNING_CODES.filter((w) => cert.warnings.includes(w)).map((w) => (
            <Alert key={w}>
              <TriangleAlert aria-hidden />
              <AlertTitle>{t(`warn_${w}_title`)}</AlertTitle>
              <AlertDescription>{t(`warn_${w}_body`)}</AlertDescription>
            </Alert>
          ))
        : null}

      <Alert>
        <ShieldAlert aria-hidden />
        <AlertTitle>{t("readersTitle")}</AlertTitle>
        <AlertDescription>{t(`readers_${kind}`)}</AlertDescription>
      </Alert>
    </>
  );
}
