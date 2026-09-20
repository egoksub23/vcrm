"use client";

// Settings > Integrations > Jira > Connection. Presentational: the container
// passes the loaded connection and the two actions. Three states:
//   - the server has no Jira app configured (the operator has to set it up),
//   - configured but not connected (Connect Jira + the admin setup help),
//   - connected (site, user, health, Reconnect, Disconnect, callback URL).

import { useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JiraConnectionRow } from "@/lib/jira/types";

import { SettingsChip } from "../settings-chip";

export interface JiraConnectionCardProps {
  /** false = the server has no Jira app credentials. */
  configured: boolean;
  callbackUrl: string;
  connection: JiraConnectionRow | null;
  counts: { links: number; paused: number; broken: number };
  /** Full-page navigation to /api/integrations/jira/connect. */
  onConnect: () => void;
  /** Resolves true when the disconnect went through. */
  onDisconnect: (purge: boolean) => Promise<boolean>;
}

export function JiraConnectionCard({
  configured,
  callbackUrl,
  connection,
  counts,
  onConnect,
  onDisconnect,
}: JiraConnectionCardProps) {
  const t = useTranslations("Settings.jira.connection");
  const live = connection && connection.status !== "revoked" ? connection : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        {!configured ? (
          <NotConfigured />
        ) : !live ? (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{t("notConnected.title")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t("notConnected.description")}</p>
            </div>
            <Button onClick={onConnect}>
              <Link2 className="size-4" />
              {t("connect")}
            </Button>
          </div>
        ) : (
          <Connected connection={live} counts={counts} onConnect={onConnect} onDisconnect={onDisconnect} />
        )}
      </div>

      <PermissionsNote />
      <JiraSetupHelp defaultOpen={configured && !live} />
      <CallbackUrlCard callbackUrl={callbackUrl} />
    </div>
  );
}

// ------------------------------------------------------------
// The three bodies
// ------------------------------------------------------------

function NotConfigured() {
  const t = useTranslations("Settings.jira.connection.notConfigured");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 text-amber-600 dark:text-amber-300" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
        <li>{t("vars")}</li>
        <li>{t("callback")}</li>
      </ul>
      <p className="text-xs text-muted-foreground">{t("docs")}</p>
    </div>
  );
}

function Connected({
  connection,
  counts,
  onConnect,
  onDisconnect,
}: {
  connection: JiraConnectionRow;
  counts: JiraConnectionCardProps["counts"];
  onConnect: () => void;
  onDisconnect: JiraConnectionCardProps["onDisconnect"];
}) {
  const t = useTranslations("Settings.jira.connection");
  const [confirming, setConfirming] = useState(false);
  const needsReconnect = connection.status === "reauth_required";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {connection.site_name || connection.site_url}
            </h3>
            <SettingsChip variant={needsReconnect ? "warn" : "ok"}>
              {needsReconnect ? <TriangleAlert aria-hidden /> : <Check aria-hidden />}
              {t(needsReconnect ? "health.needsReconnect" : "health.connected")}
            </SettingsChip>
          </div>
          <a
            href={connection.site_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <span className="truncate">{connection.site_url}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden />
            <span className="sr-only">{t("opensInNewTab")}</span>
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onConnect}>
            <RefreshCw className="size-4" />
            {t("reconnect")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <Unlink className="size-4" />
            {t("disconnect")}
          </Button>
        </div>
      </div>

      {needsReconnect ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
        >
          <p className="font-medium">{t("reauth.title")}</p>
          <p className="mt-1">{t("reauth.body")}</p>
          {connection.status_reason ? (
            <p className="mt-1 text-xs">{t("reauth.reason", { reason: connection.status_reason })}</p>
          ) : null}
        </div>
      ) : null}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label={t("facts.connectedAs")}>
          {connection.jira_display_name || t("facts.unknownUser")}
        </Fact>
        <Fact label={t("facts.links")}>
          {t("facts.linksValue", { count: counts.links, paused: counts.paused, broken: counts.broken })}
        </Fact>
      </dl>

      <DisconnectDialog
        open={confirming}
        siteName={connection.site_name || connection.site_url}
        onClose={() => setConfirming(false)}
        onConfirm={onDisconnect}
      />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-foreground">{children}</dd>
    </div>
  );
}

// ------------------------------------------------------------
// Disconnect
// ------------------------------------------------------------

function DisconnectDialog({
  open,
  siteName,
  onClose,
  onConfirm,
}: {
  open: boolean;
  siteName: string;
  onClose: () => void;
  onConfirm: (purge: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("Settings.jira.connection.disconnectDialog");
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const ok = await onConfirm(purge);
    setBusy(false);
    if (ok) {
      setPurge(false);
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { site: siteName })}</DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-foreground">
          <li>{t("tokens")}</li>
          <li>{t("webhooks")}</li>
          <li>{purge ? t("linksRemoved") : t("linksPaused")}</li>
          <li>{t("notesStay")}</li>
          <li>{t("nothingDeleted")}</li>
        </ul>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
          <Checkbox checked={purge} onCheckedChange={(c) => setPurge(c === true)} className="mt-0.5" />
          <span className="min-w-0 text-sm">
            <span className="block font-medium text-foreground">{t("purge")}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t("purgeHint")}</span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Side cards
// ------------------------------------------------------------

function PermissionsNote() {
  const t = useTranslations("Settings.jira.connection.permissions");
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t("asks")}</li>
        <li>{t("never")}</li>
        <li>{t("asUser")}</li>
        <li>{t("recommend")}</li>
      </ul>
    </div>
  );
}

/** The Jira admin's checklist (design 7.2). */
export function JiraSetupHelp({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const t = useTranslations("Settings.jira.connection.setup");
  const steps = ["one", "two", "three", "four"] as const;
  return (
    <details open={defaultOpen} className="group rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">{t("title")}</summary>
      <p className="mt-2 text-sm text-muted-foreground">{t("intro")}</p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-foreground">
        {steps.map((s) => (
          <li key={s}>
            <span className="font-medium">{t(`${s}.title`)}</span>
            <span className="mt-0.5 block text-muted-foreground">{t(`${s}.body`)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function CallbackUrlCard({ callbackUrl }: { callbackUrl: string }) {
  const t = useTranslations("Settings.jira.connection.callback");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-foreground">
          {callbackUrl || t("unknown")}
        </code>
        <Button variant="outline" size="sm" onClick={() => void copy()} disabled={!callbackUrl}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {t("copy")}
        </Button>
      </div>
    </div>
  );
}
