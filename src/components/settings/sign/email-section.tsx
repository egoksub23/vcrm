"use client";

// Settings > Doc Sign > General > Email: which way the workspace's email goes out (its connected Microsoft 365 or Gmail mailbox, the platform sender, or
// nowhere yet), read only, with a link to where the mailbox is connected, and a button that sends one short test email to the signed-in person. Nothing
// is set here: the mailbox belongs to Settings > Channels. GET and POST /api/sign/settings/email (sign.settings).

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, Mail, TriangleAlert } from "lucide-react";

import { useDeliveryReason } from "@/components/sign/delivery-reason";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { reasonDetail } from "@/lib/email/send-reason";
import { signRequest } from "@/lib/sign/client/api";
import type { EmailStatus, TestEmailResult } from "@/lib/sign/service/email-status";

import { Loading, useAdminErrorText } from "./shared";

/** Where each kind of mailbox is connected (Settings > Channels, on that channel's tab). */
export const CHANNEL_LINK = { microsoft365: "/settings?tab=channels&channel=email", gmail: "/settings?tab=channels&channel=gmail" } as const;

const OK_COLOR = { color: "light-dark(#047857, #6ee7b7)" } as const;
const WARN_COLOR = { color: "light-dark(#b45309, #fcd34d)" } as const;

type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; email: EmailStatus };
export type TestState = { status: "idle" } | { status: "sending" } | { status: "done"; result: TestEmailResult } | { status: "error"; error: unknown };

export function EmailSection() {
  const t = useTranslations("Sign.admin.email");
  const errorText = useAdminErrorText();
  const canEdit = useCapability("sign.settings");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [test, setTest] = useState<TestState>({ status: "idle" });

  useEffect(() => {
    let live = true;
    signRequest<{ email: EmailStatus }>("/api/sign/settings/email")
      .then((r) => {
        if (live) setLoad({ status: "ready", email: r.email });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, []);

  async function sendTest() {
    setTest({ status: "sending" });
    try {
      const { result } = await signRequest<{ result: TestEmailResult }>("/api/sign/settings/email", { method: "POST", json: {} });
      setTest({ status: "done", result });
    } catch (error) {
      setTest({ status: "error", error });
    }
  }

  if (load.status === "loading") return <Loading label={t("loading")} />;
  if (load.status === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorText(load.error)}
      </p>
    );
  }
  return <EmailStatusCard email={load.email} canEdit={canEdit} test={test} onTest={() => void sendTest()} />;
}

/** The card itself: what the server said about the transport, and the test email's outcome. */
export function EmailStatusCard({ email: e, canEdit, test, onTest }: { email: EmailStatus; canEdit: boolean; test: TestState; onTest: () => void }) {
  const t = useTranslations("Sign.admin.email");
  const errorText = useAdminErrorText();
  const reasonOf = useDeliveryReason();

  const where = e.provider ?? "microsoft365";
  const ready = e.via !== "none";
  const headline =
    e.via === "mailbox" && e.provider
      ? t(`transport.${e.provider}`, { address: e.address ?? "" })
      : e.via === "platform"
        ? t("transport.platform")
        : e.problem
          ? t("transport.noneProblem")
          : t("transport.none");

  let outcome: ReactNode = null;
  if (test.status === "done" && test.result.sent) {
    outcome = (
      <p role="status" className="text-sm" style={OK_COLOR}>
        {test.result.from ? t("test.sentMailbox", { to: test.result.to, from: test.result.from }) : t("test.sentPlatform", { to: test.result.to })}
      </p>
    );
  } else if (test.status === "done") {
    const reason = reasonOf(reasonDetail(test.result.reason, test.result.detail));
    outcome = (
      <div role="alert" className="space-y-0.5 text-sm" style={WARN_COLOR}>
        <p className="font-medium">{t("test.failed")}</p>
        {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      </div>
    );
  } else if (test.status === "error") {
    outcome = (
      <p role="alert" className="text-sm text-destructive">
        {errorText(test.error)}
      </p>
    );
  }

  return (
    <section aria-labelledby="sign-email-title" className="max-w-2xl space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="space-y-1">
        <h3 id="sign-email-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Mail className="size-4" aria-hidden />
          {t("title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <div className="space-y-2" data-email-via={e.via}>
        <p className="flex items-start gap-2 text-sm font-medium text-foreground" role="status">
          {ready ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={OK_COLOR} aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" style={WARN_COLOR} aria-hidden />}
          <span className="break-words">{headline}</span>
        </p>

        {e.problem ? (
          <p className="text-sm text-muted-foreground" data-email-problem={e.problem}>
            {t(`problem.${e.problem}`, { address: e.address ?? "" })} {e.via === "platform" ? t("platformInstead") : null}
          </p>
        ) : null}

        {e.via === "mailbox" ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {e.fromName ? <li>{t("nameNote", { name: e.fromName })}</li> : null}
            {e.provider ? <li>{t(`keptNote.${e.provider}`)}</li> : null}
            <li>{t("inboxNote")}</li>
            <li>{t("inboxOffNote")}</li>
          </ul>
        ) : null}

        {e.via === "platform" && !e.problem ? <p className="text-sm text-muted-foreground">{t("platformNote")}</p> : null}

        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {e.via === "mailbox" || e.problem ? (
            <Link href={CHANNEL_LINK[where]} className="font-medium text-primary underline-offset-2 hover:underline">
              {t("link.manage")}
            </Link>
          ) : (
            <>
              <Link href={CHANNEL_LINK.microsoft365} className="font-medium text-primary underline-offset-2 hover:underline">
                {t("link.connectMicrosoft365")}
              </Link>
              <Link href={CHANNEL_LINK.gmail} className="font-medium text-primary underline-offset-2 hover:underline">
                {t("link.connectGmail")}
              </Link>
            </>
          )}
        </p>
      </div>

      {canEdit ? (
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" disabled={test.status === "sending"} onClick={onTest}>
              {test.status === "sending" ? <Loader2 className="animate-spin" aria-hidden /> : <Mail aria-hidden />}
              {test.status === "sending" ? t("test.sending") : t("test.button")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("test.hint")}</span>
          </div>
          {outcome}
        </div>
      ) : null}
    </section>
  );
}
