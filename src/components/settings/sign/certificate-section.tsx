"use client";

// Settings > Doc Sign > Sealing certificate: the certificate every completed document is sealed with (its facts
// come from GET /api/sign/settings/certificate, which never returns the key), what a PDF reader will say about it,
// and the form to install a certificate from a certificate authority (a .p12 or .pfx file). The file is checked on
// the server; each way it can be unfit has its own message.

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { certificateErrorKey, type CertificateView } from "@/lib/sign/client/certificate-view";

import { CertificateFacts } from "./certificate-facts";
import { Field, Loading, useAdminErrorText } from "./shared";

type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; certificate: CertificateView | null; now: Date };

/** The most a certificate file can be (the server refuses more): a key and a chain are a few kilobytes. */
const MAX_FILE_BYTES = 256 * 1024;

export function CertificateSection() {
  const t = useTranslations("Sign.admin.certificate");
  const errorText = useAdminErrorText();
  const canEdit = useCapability("sign.settings");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);

  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [name, setName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    signRequest<{ certificate: CertificateView | null }>("/api/sign/settings/certificate")
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

  const failureText = (err: unknown): string => {
    const key = err instanceof SignApiError ? certificateErrorKey(err.code) : null;
    return key ? t(key) : errorText(err);
  };

  async function install() {
    if (!file) {
      setProblem(t("errors.no_file"));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setProblem(t("errors.certificate_file_too_large"));
      return;
    }
    setProblem(null);
    setInstalling(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("passphrase", passphrase);
      if (name.trim()) form.set("name", name.trim());
      await signRequest("/api/sign/settings/certificate", { method: "POST", form });
      toast.success(t("installed"));
      setFile(null);
      setPassphrase("");
      setName("");
      if (fileInput.current) fileInput.current.value = "";
      setRound((n) => n + 1);
    } catch (err) {
      setProblem(failureText(err));
    } finally {
      setInstalling(false);
    }
  }

  async function remove(id: string) {
    setRemoving(true);
    try {
      await signRequest(`/api/sign/settings/certificate?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success(t("removed"));
      setConfirmRemove(false);
      setRound((n) => n + 1);
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setRemoving(false);
    }
  }

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

  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      <CertificateFacts cert={cert} now={load.now} />

      {canEdit ? (
        <form
          className="space-y-4 rounded-xl border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("uploadTitle")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("uploadIntro")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cert-file" label={t("fileLabel")} hint={t("fileHint")}>
              <Input
                id="cert-file"
                ref={fileInput}
                type="file"
                accept=".p12,.pfx,application/x-pkcs12"
                disabled={installing}
                aria-describedby="cert-file-hint"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setProblem(null);
                }}
              />
            </Field>
            <Field id="cert-pass" label={t("passphraseLabel")} hint={t("passphraseHint")}>
              <Input id="cert-pass" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={installing} aria-describedby="cert-pass-hint" />
            </Field>
            <Field id="cert-name" label={t("nameLabel")} hint={t("nameHint")} className="sm:col-span-2">
              <Input id="cert-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={installing} aria-describedby="cert-name-hint" />
            </Field>
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <Button type="submit" disabled={installing || !file}>
            {installing ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {installing ? t("installing") : t("install")}
          </Button>
        </form>
      ) : null}

      {canEdit && cert?.uploaded ? (
        <div className="space-y-2">
          {confirmRemove ? (
            <div className="space-y-3 rounded-xl border border-border p-4">
              <p className="text-sm text-foreground">{t("removeConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" size="sm" disabled={removing} onClick={() => void remove(cert.id)}>
                  {removing ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {t("removeYes")}
                </Button>
                <Button variant="outline" size="sm" disabled={removing} onClick={() => setConfirmRemove(false)}>
                  {t("removeNo")}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(true)}>
              {t("remove")}
            </Button>
          )}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
