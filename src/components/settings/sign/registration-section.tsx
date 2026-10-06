"use client";

// Settings > Doc Sign > Registration forms (F-58): the public pages where someone with no login enters a few
// details and the signing flow starts. A card for each form: its address (copy, open, make a new one), whether it
// takes registrations, what it sends, how many came in, and anything that stops it working. Edit opens the editor;
// "Recent activity" shows what became of the latest submissions (what happened and when: never an address or an
// email). Everything goes through /api/sign/registration, so the database checks sign.settings and the audit log
// records who changed a form.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, ExternalLink, History, Loader2, Pencil, Plus, RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useCapability } from "@/hooks/use-can";
import { signRequest, SignApiError } from "@/lib/sign/client/api";
import { issueKey, reasonKey, type FormOptions } from "@/lib/sign/client/registration-admin";
import type { RegistrationCounts, RegistrationEntry, RegistrationFormRow } from "@/lib/sign/registration/types";
import type { Issue } from "@/lib/sign/rules";

import { RegistrationFormDialog } from "./registration-form-dialog";
import { Loading, useAdminErrorText } from "./shared";

export interface ListItem {
  form: RegistrationFormRow;
  counts: RegistrationCounts;
  issues: Issue[];
  url: string;
}

type Load = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; items: ListItem[]; options: FormOptions };

export function RegistrationSection() {
  const t = useTranslations("Sign.admin.registration");
  const errorText = useAdminErrorText();
  const canEdit = useCapability("sign.settings");

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [editing, setEditing] = useState<ListItem | "new" | null>(null);
  const [activity, setActivity] = useState<ListItem | null>(null);
  const [renewing, setRenewing] = useState<ListItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([signRequest<{ forms: ListItem[] }>("/api/sign/registration/forms"), signRequest<FormOptions>("/api/sign/registration/options")])
      .then(([list, options]) => {
        if (live) setLoad({ status: "ready", items: list.forms, options });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ status: "error", error });
      });
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);

  const toggle = async (item: ListItem, active: boolean) => {
    setBusy(item.form.id);
    try {
      await signRequest(`/api/sign/registration/forms/${item.form.id}`, { method: "PATCH", json: { active } });
      toast.success(active ? t("switchedOn") : t("switchedOff"));
      reload();
    } catch (err) {
      toast.error(err instanceof SignApiError && err.code === "form_not_ready" ? t("cannotSwitchOn") : errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const renew = async (item: ListItem) => {
    setBusy(item.form.id);
    try {
      await signRequest(`/api/sign/registration/forms/${item.form.id}/slug`, { method: "POST", json: {} });
      toast.success(t("newAddressMade"));
      setRenewing(null);
      reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
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

  const { items, options } = load;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[62ch] text-sm text-muted-foreground">{t("intro")}</p>
        <Button onClick={() => setEditing("new")} disabled={!canEdit}>
          <Plus aria-hidden />
          {t("new")}
        </Button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" aria-hidden />
        {options.turnstile ? t("botCheckOn") : t("botCheckOff")}
      </p>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <FormCard
              key={item.form.id}
              item={item}
              options={options}
              canEdit={canEdit}
              busy={busy === item.form.id}
              onToggle={(active) => void toggle(item, active)}
              onEdit={() => setEditing(item)}
              onActivity={() => setActivity(item)}
              onRenew={() => setRenewing(item)}
              onCopy={() => void copy(item.url)}
            />
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{t("footnote")}</p>

      <RegistrationFormDialog
        form={editing && editing !== "new" ? editing.form : null}
        open={editing !== null}
        options={options}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
      <ActivityDialog item={activity} onClose={() => setActivity(null)} />
      <Dialog open={renewing !== null} onOpenChange={(o) => !o && setRenewing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("renew.title")}</DialogTitle>
            <DialogDescription>{t("renew.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenewing(null)} disabled={busy !== null}>
              {t("cancel")}
            </Button>
            <Button onClick={() => renewing && void renew(renewing)} disabled={busy !== null}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {t("renew.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- one form ------------------------------------------------------------------------------------------

/** One form's card (exported so it can be drawn on its own in a test). */
export function FormCard({
  item,
  options,
  canEdit,
  busy,
  onToggle,
  onEdit,
  onActivity,
  onRenew,
  onCopy,
}: {
  item: ListItem;
  options: FormOptions;
  canEdit: boolean;
  busy: boolean;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onActivity: () => void;
  onRenew: () => void;
  onCopy: () => void;
}) {
  const t = useTranslations("Sign.admin.registration");
  const { form, counts, issues, url } = item;
  const template = options.templates.find((x) => x.id === form.template_id);
  const stuck = form.active && issues.length > 0;
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold text-foreground">{form.name}</h3>
          <Badge variant={form.active ? "default" : "outline"}>{form.active ? t("on") : t("off")}</Badge>
          {stuck ? <Badge variant="destructive">{t("needsAttention")}</Badge> : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span>{t("takeRegistrations")}</span>
          <Switch checked={form.active} onCheckedChange={onToggle} disabled={!canEdit || busy} aria-label={t("takeRegistrationsFor", { name: form.name })} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 max-w-full flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs" title={url}>
          {url}
        </code>
        <Button variant="outline" size="sm" onClick={onCopy} aria-label={t("copyFor", { name: form.name })}>
          <Copy aria-hidden />
          {t("copy")}
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[0.8rem] font-medium hover:bg-muted"
          aria-label={t("openFor", { name: form.name })}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t("open")}
        </a>
        <Button variant="ghost" size="sm" onClick={onRenew} disabled={!canEdit || busy} aria-label={t("renewFor", { name: form.name })}>
          <RefreshCw aria-hidden />
          {t("newAddress")}
        </Button>
      </div>
      {!form.active ? <p className="mt-1.5 text-xs text-muted-foreground">{t("offHint")}</p> : null}

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t("sends")}</dt>
          <dd>{form.send_document ? (template ? template.name : t("noTemplate")) : t("sendsNothing")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t("today")}</dt>
          <dd>{t("todayValue", { count: counts.today, cap: form.daily_cap })}</dd>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <dt className="text-muted-foreground">{t("last30")}</dt>
          <dd>{t("last30Value", { accepted: counts.accepted, failed: counts.failed, blocked: counts.rejected_spam + counts.rejected_cap })}</dd>
        </div>
      </dl>

      {issues.length > 0 ? (
        <ul className={stuck ? "mt-3 list-disc space-y-0.5 pl-5 text-sm text-destructive" : "mt-3 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground"}>
          {issues.map((issue, i) => (
            <li key={`${issue.code}-${issue.role ?? ""}-${i}`}>{t(issueKey(issue.code), { role: issue.role ?? "" })}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEdit} disabled={!canEdit} aria-label={t("editFor", { name: form.name })}>
          <Pencil aria-hidden />
          {t("edit")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onActivity} aria-label={t("activityFor", { name: form.name })}>
          <History aria-hidden />
          {t("activity")}
        </Button>
      </div>
    </li>
  );
}

// ---- recent activity -----------------------------------------------------------------------------------

function ActivityDialog({ item, onClose }: { item: ListItem | null; onClose: () => void }) {
  const t = useTranslations("Sign.admin.registration");
  const errorText = useAdminErrorText();
  const locale = useLocale();
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; entries: RegistrationEntry[] }>({ status: "loading" });

  useEffect(() => {
    if (!item) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" });
    signRequest<{ entries: RegistrationEntry[] }>(`/api/sign/registration/forms/${item.form.id}`)
      .then((r) => live && setState({ status: "ready", entries: r.entries }))
      .catch((error: unknown) => live && setState({ status: "error", error }));
    return () => {
      live = false;
    };
  }, [item]);

  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("activityTitle", { name: item?.form.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("activityIntro")}</DialogDescription>
        </DialogHeader>
        {state.status === "loading" ? <Loading label={t("loading")} /> : null}
        {state.status === "error" ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(state.error)}
          </p>
        ) : null}
        {state.status === "ready" && state.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t("activityEmpty")}</p> : null}
        {state.status === "ready" && state.entries.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {state.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <time dateTime={e.created_at} className="w-40 shrink-0 text-muted-foreground">
                  {when(e.created_at)}
                </time>
                <Badge variant={e.status === "accepted" ? "default" : e.status === "failed" ? "destructive" : "secondary"}>{t(`status.${e.status}`)}</Badge>
                {e.reason ? <span className="text-muted-foreground">{t(reasonKey(e.reason))}</span> : null}
                {e.document_id ? (
                  <Link href={`/sign/${e.document_id}`} className="ml-auto text-primary underline-offset-4 hover:underline">
                    {t("openDocument")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
