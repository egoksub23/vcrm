"use client";

// ============================================================
// "Send a test" on the template page (F-10): send yourself a document made from this template, marked TEST on every page, to try the
// whole flow (the email, the signing page, the sealed file) before a real person does. It is not counted against the monthly limit, is
// never announced to webhooks or automations, and is kept 30 days after it is signed. It goes to YOU only: your own address, or your own
// address with a +tag for another inbox of yours. The server checks that; this dialog only makes it easy (service/test-mode.ts).
//
// The frame (a portal) and what is inside it are two components, so the render tests draw `TestSendBody` on its own in every language.
// ============================================================

import { useMemo, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FlaskConical, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { TestSendResult } from "@/lib/sign/service/test-mode";
import { isOwnAddress, rolesNeedingPeople, TEST_RETENTION_DAYS } from "@/lib/sign/test-mode";
import type { SignRole } from "@/lib/sign/types";
import { createClient } from "@/lib/supabase/client";

interface Props {
  templateId: string;
  /** The saved version's roles, fields and form: what the test is made from. */
  roles: readonly SignRole[];
  fields: readonly PlacedField[];
  form: FormDefinition | null;
  /** The screen has changes that are not saved as a version: the test would not include them. */
  unsaved: boolean;
}

export function TestSendButton(props: Props) {
  const t = useTranslations("Sign.editor");
  const canSend = useCapability("sign.send");
  const [open, setOpen] = useState(false);
  if (!canSend) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FlaskConical />
        {t("testSend.button")}
      </Button>
      <TestSendDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * "Send a test" on a row of the template library: the template's saved (latest) version is read when the button is pressed, then the
 * same dialog opens as in the editor. Offered by the caller only for a template that has a version.
 */
export function TestSendRowButton({ templateId, name }: { templateId: string; name: string }) {
  const t = useTranslations("Sign.editor");
  const canSend = useCapability("sign.send");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<Pick<Props, "roles" | "fields" | "form"> | null>(null);
  const [open, setOpen] = useState(false);
  if (!canSend) return null;

  const start = async () => {
    if (busy) return;
    if (version) {
      setOpen(true);
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await createClient().from("sign_template_versions").select("roles, fields, form").eq("template_id", templateId).order("version_no", { ascending: false }).limit(1).maybeSingle();
      if (error || !data) throw error ?? new Error("no version");
      const v = data as { roles: SignRole[]; fields: PlacedField[]; form: FormDefinition | null };
      setVersion({ roles: v.roles ?? [], fields: v.fields ?? [], form: v.form ?? null });
      setOpen(true);
    } catch {
      toast.error(t("testSend.loadFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t("testSend.rowLabel", { name })} title={t("testSend.button")} onClick={() => void start()}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FlaskConical aria-hidden />}
      </Button>
      {version ? <TestSendDialog {...version} templateId={templateId} unsaved={false} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

function TestSendDialog(props: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <TestSendBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

interface BodyProps extends Props {
  onOpenChange: (open: boolean) => void;
  /** Tests only: the signed-in address, instead of reading it from the session. */
  ownAddress?: string;
}

/** Everything inside the dialog. Its state starts fresh each time the dialog opens (the frame removes it when closed). */
export function TestSendBody({ templateId, roles, fields, form, unsaved, onOpenChange, ownAddress }: BodyProps) {
  const t = useTranslations("Sign.editor");
  const tErr = useTranslations("Sign.send");
  const { user } = useAuth();
  const own = ownAddress ?? user?.email ?? "";
  const needed = useMemo(() => rolesNeedingPeople(roles, fields, form), [roles, fields, form]);
  const [email, setEmail] = useState("");
  const [perRole, setPerRole] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorRole, setErrorRole] = useState<string | null>(null);
  const [result, setResult] = useState<TestSendResult | null>(null);

  const chosen = email.trim() || own;
  const problems = [chosen, ...Object.values(perRole).filter((v) => v.trim())].some((a) => !isOwnAddress(a, [own]));
  const close = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };

  const send = async () => {
    if (busy || problems || needed.length === 0) return;
    setBusy(true);
    setErrorCode(null);
    setErrorRole(null);
    try {
      const emails = Object.fromEntries(Object.entries(perRole).filter(([, v]) => v.trim()));
      const res = await signRequest<{ result: TestSendResult }>(`/api/sign/templates/${templateId}/test`, { json: { email: chosen, emails } });
      setResult(res.result);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setErrorRole(err instanceof SignApiError ? (err.issues.find((i) => i.role)?.role ?? null) : null);
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (key: string) => roles.find((r) => r.key === key)?.label ?? key;
  const undelivered = result?.invited.filter((i) => i.delivery.status !== "sent" && i.link) ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("testSend.title")}</DialogTitle>
        <DialogDescription>{result ? t("testSend.sentIntro") : t("testSend.intro")}</DialogDescription>
      </DialogHeader>

      {result ? (
        <div className="space-y-3 text-sm">
          <p className="text-foreground">{t("testSend.sentTo", { email: result.people[0]?.email ?? chosen })}</p>
          {result.orderIgnored ? <p className="text-muted-foreground">{t("testSend.orderIgnored")}</p> : null}
          <p className="text-muted-foreground">{t("testSend.whereToSign")}</p>
          {undelivered.length > 0 ? (
            <div role="alert" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
              <p className="font-medium text-foreground">{t("testSend.notDelivered")}</p>
              <ul className="space-y-1">
                {undelivered.map((i) => (
                  <li key={i.signerId} className="break-all text-xs">
                    {roleLabel(i.roleKey)}: {i.link}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t("common.close")}
            </Button>
            <Link href={`/sign/${result.documentId}`} className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              {t("testSend.open")}
            </Link>
          </DialogFooter>
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("testSend.pointMarked")}</li>
            <li>{t("testSend.pointNotCounted")}</li>
            <li>{t("testSend.pointKept", { days: TEST_RETENTION_DAYS })}</li>
          </ul>

          {unsaved ? (
            <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-foreground dark:border-amber-800 dark:bg-amber-950/40">
              {t("testSend.unsaved")}
            </p>
          ) : null}

          {needed.length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("testSend.noRoles")}
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label htmlFor="test-email" className="text-sm font-medium text-foreground">
                  {t("testSend.emailLabel")}
                </label>
                <Input id="test-email" type="email" autoComplete="email" value={email} placeholder={own} disabled={busy} aria-invalid={problems} onChange={(e) => setEmail(e.target.value)} />
                <p className={problems ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{problems ? t("testSend.emailNotYours") : t("testSend.emailHint")}</p>
              </div>

              {needed.length > 1 ? (
                <fieldset className="space-y-2" disabled={busy}>
                  <legend className="text-sm font-medium text-foreground">{t("testSend.placesLabel")}</legend>
                  {needed.map((r) => (
                    <div key={r.key} className="grid grid-cols-[8rem_1fr] items-center gap-2">
                      <label htmlFor={`test-role-${r.key}`} className="truncate text-sm text-muted-foreground">
                        {r.label}
                      </label>
                      <Input
                        id={`test-role-${r.key}`}
                        type="email"
                        value={perRole[r.key] ?? ""}
                        placeholder={chosen}
                        aria-invalid={errorRole === r.key || ((perRole[r.key] ?? "").trim() !== "" && !isOwnAddress(perRole[r.key], [own]))}
                        onChange={(e) => setPerRole((p) => ({ ...p, [r.key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">{t("testSend.placesHint")}</p>
                </fieldset>
              ) : null}
            </>
          )}

          {errorCode ? (
            <p role="alert" className="text-sm text-destructive">
              {tErr(errorKey(errorCode))}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
              {t("testSend.cancel")}
            </Button>
            <Button type="button" disabled={busy || problems || needed.length === 0 || !chosen} onClick={() => void send()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FlaskConical aria-hidden />}
              {busy ? t("testSend.sending") : t("testSend.send")}
            </Button>
          </DialogFooter>
        </div>
      )}
    </>
  );
}
