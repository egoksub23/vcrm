"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Building2, Copy, Loader2, Pause, Pencil, Play, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EncryptionCard } from "@/components/platform/encryption-card";
import { Textarea } from "@/components/ui/textarea";
import type { CronJobStatus } from "@/lib/cron/status";
import { PLATFORM_FEATURES, isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";

interface TenantRow {
  id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  status: "active" | "suspended";
  plan: string;
  limits: Record<string, number>;
  features: Record<string, boolean>;
  suspended_reason: string | null;
  members: number;
  contacts: number;
  conversations: number;
  /** False when the default ticket types/resolutions are missing (migration 133). */
  seed_ok?: boolean;
}

interface CreateDraft {
  companyName: string;
  ownerEmail: string;
  ownerName: string;
  plan: string;
  seats: string;
}

const EMPTY_CREATE: CreateDraft = { companyName: "", ownerEmail: "", ownerName: "", plan: "", seats: "" };

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/**
 * Operator console: every customer workspace on this deployment, with
 * create / edit (plan, seats, feature flags) / suspend and resume. Only
 * rendered for platform admins (the page checks `isPlatformAdmin`); the
 * /api/platform routes and the database RPCs enforce it independently.
 */
export function PlatformConsole() {
  const t = useTranslations("Platform");
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [create, setCreate] = useState<CreateDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ row: TenantRow; plan: string; seats: string; broadcastPerDay: string; features: Record<string, boolean> } | null>(null);
  const [suspend, setSuspend] = useState<{ row: TenantRow; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openSignup, setOpenSignup] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<CronJobStatus[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/accounts", { cache: "no-store" });
      if (!res.ok) throw new Error(await errorFrom(res, t("loadFailed")));
      const body = (await res.json()) as { accounts: TenantRow[] };
      setRows(body.accounts);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load();
    void fetch("/api/platform/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { open_signup?: boolean } | null) =>
        setOpenSignup(typeof b?.open_signup === "boolean" ? b.open_signup : null),
      )
      .catch(() => {});
    void fetch("/api/platform/cron", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { jobs?: CronJobStatus[] } | null) => setJobs(b?.jobs ?? null))
      .catch(() => {});
  }, [load]);

  const toggleSignup = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/platform/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open_signup: next }),
      });
      if (!res.ok) throw new Error(await errorFrom(res, t("updateFailed")));
      setOpenSignup(next);
      toast.success(t("signupSaved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      workspaces: list.length,
      active: list.filter((r) => r.status === "active").length,
      members: list.reduce((n, r) => n + Number(r.members), 0),
    };
  }, [rows]);

  const submitCreate = async () => {
    if (!create) return;
    setCreating(true);
    try {
      const res = await fetch("/api/platform/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: create.companyName,
          ownerEmail: create.ownerEmail,
          ownerName: create.ownerName || undefined,
          plan: create.plan || undefined,
          seats: create.seats ? Number(create.seats) : undefined,
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res, t("createFailed")));
      const body = (await res.json()) as { emailed: boolean; setPasswordUrl?: string; warning?: string };
      setCreate(null);
      if (body.setPasswordUrl) setLink(body.setPasswordUrl);
      else if (body.warning) toast.warning(body.warning);
      else toast.success(t("createdEmailed", { email: create.ownerEmail }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/platform/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorFrom(res, t("updateFailed")));
      toast.success(ok);
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("updateFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    const seats = edit.seats.trim();
    const broadcastPerDay = edit.broadcastPerDay.trim();
    const platform = parsePlatformRow({ features: edit.row.features });
    const features: Record<string, boolean | null> = {};
    for (const f of PLATFORM_FEATURES) {
      const next = edit.features[f] ?? isFeatureEnabled(platform, f);
      features[f] = next;
    }
    const ok = await patch(
      edit.row.id,
      { plan: edit.plan.trim() || edit.row.plan, limits: { seats: seats ? Number(seats) : null, broadcast_per_day: broadcastPerDay ? Number(broadcastPerDay) : null }, features },
      t("saved"),
    );
    if (ok) setEdit(null);
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Building2 className="h-6 w-6 text-primary" />
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button onClick={() => setCreate(EMPTY_CREATE)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("newCustomer")}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [t("statWorkspaces"), totals.workspaces],
          [t("statActive"), totals.active],
          [t("statMembers"), totals.members],
        ].map(([label, value]) => (
          <Card key={String(label)} className="border-border bg-card">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-2xl font-semibold text-foreground">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {openSignup !== null && (
        <Card className="border-border bg-card">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t("signupTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("signupDesc")}</p>
            </div>
            <Switch
              checked={openSignup}
              disabled={busy}
              onCheckedChange={(v) => void toggleSignup(v)}
              aria-label={t("signupTitle")}
            />
          </CardContent>
        </Card>
      )}

      {jobs !== null && (
        <Card className="border-border bg-card">
          <CardContent className="space-y-3 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t("cronTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("cronDesc")}</p>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {jobs.map((j) => {
                const state: "never" | "error" | "late" | "ok" =
                  j.last_run_at === null ? "never" : j.last_status === "error" ? "error" : j.late ? "late" : "ok";
                return (
                  <li key={j.job} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{t(`job_${j.job}`)}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {j.last_run_at ? new Date(j.last_run_at).toLocaleString() : t("cronNeverRan")}
                      </p>
                    </div>
                    <Badge
                      variant={state === "ok" ? "secondary" : "destructive"}
                      className="shrink-0"
                    >
                      {t(`cron_${state}`)}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <EncryptionCard />

      <Card className="border-border bg-card">
        <CardContent className="p-0">
          {rows === null && !loadError ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}
            </div>
          ) : loadError ? (
            <div role="alert" className="p-6 text-sm text-destructive">{loadError}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium">{t("colWorkspace")}</th>
                    <th className="px-4 py-3 font-medium">{t("colPlan")}</th>
                    <th className="px-4 py-3 font-medium">{t("colSeats")}</th>
                    <th className="px-4 py-3 font-medium">{t("colContacts")}</th>
                    <th className="px-4 py-3 font-medium">{t("colStatus")}</th>
                    <th className="px-4 py-3 font-medium">{t("colCreated")}</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{r.name}</p>
                        <p className="text-xs text-muted-foreground">{r.owner_email ?? "—"}</p>
                      </td>
                      <td className="px-4 py-3 text-foreground">{r.plan}</td>
                      <td className="px-4 py-3 text-foreground">
                        {r.members}
                        {typeof r.limits?.seats === "number" ? ` / ${r.limits.seats}` : ""}
                      </td>
                      <td className="px-4 py-3 text-foreground">{r.contacts}</td>
                      <td className="px-4 py-3">
                        {r.status === "suspended" ? (
                          <Badge variant="destructive" title={r.suspended_reason ?? undefined}>{t("statusSuspended")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("statusActive")}</Badge>
                        )}
                        {r.seed_ok === false && (
                          <Badge variant="outline" className="ml-1 border-amber-500/50 text-amber-600" title={t("setupIncompleteHint")}>
                            {t("setupIncomplete")}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setEdit({
                                row: r,
                                plan: r.plan,
                                seats: typeof r.limits?.seats === "number" ? String(r.limits.seats) : "",
                                broadcastPerDay: typeof r.limits?.broadcast_per_day === "number" ? String(r.limits.broadcast_per_day) : "",
                                features: Object.fromEntries(
                                  PLATFORM_FEATURES.map((f) => [f, isFeatureEnabled(parsePlatformRow({ features: r.features }), f)]),
                                ),
                              })
                            }
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            {t("edit")}
                          </Button>
                          {r.seed_ok === false && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void patch(r.id, { reseed: true }, t("repaired"))}>
                              {t("repair")}
                            </Button>
                          )}
                          {r.status === "suspended" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void patch(r.id, { status: "active" }, t("resumed"))}
                            >
                              <Play className="mr-1 h-3.5 w-3.5" />
                              {t("resume")}
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setSuspend({ row: r, reason: "" })}>
                              <Pause className="mr-1 h-3.5 w-3.5" />
                              {t("suspend")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create */}
      <Dialog open={create !== null} onOpenChange={(o) => !o && !creating && setCreate(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("createDesc")}</DialogDescription>
          </DialogHeader>
          {create && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pc-company">{t("fieldCompany")}</Label>
                <Input id="pc-company" value={create.companyName} onChange={(e) => setCreate({ ...create, companyName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pc-email">{t("fieldOwnerEmail")}</Label>
                <Input id="pc-email" type="email" value={create.ownerEmail} onChange={(e) => setCreate({ ...create, ownerEmail: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pc-name">{t("fieldOwnerName")}</Label>
                <Input id="pc-name" value={create.ownerName} onChange={(e) => setCreate({ ...create, ownerName: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pc-plan">{t("fieldPlan")}</Label>
                  <Input id="pc-plan" placeholder="standard" value={create.plan} onChange={(e) => setCreate({ ...create, plan: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pc-seats">{t("fieldSeats")}</Label>
                  <Input id="pc-seats" type="number" min={1} placeholder={t("unlimited")} value={create.seats} onChange={(e) => setCreate({ ...create, seats: e.target.value })} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={creating} onClick={() => setCreate(null)}>{t("cancel")}</Button>
            <Button disabled={creating || !create?.companyName.trim() || !create?.ownerEmail.trim()} onClick={() => void submitCreate()}>
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("createSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time link, shown only when no email provider is configured */}
      <Dialog open={link !== null} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("linkTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("linkDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={link ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(link ?? "");
                toast.success(t("copied"));
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setLink(null)}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={edit !== null} onOpenChange={(o) => !o && !busy && setEdit(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editTitle", { name: edit?.row.name ?? "" })}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("editDesc")}</DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pe-plan">{t("fieldPlan")}</Label>
                  <Input id="pe-plan" value={edit.plan} onChange={(e) => setEdit({ ...edit, plan: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pe-seats">{t("fieldSeats")}</Label>
                  <Input id="pe-seats" type="number" min={1} placeholder={t("unlimited")} value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: e.target.value })} />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="pe-broadcast">{t("fieldBroadcastPerDay")}</Label>
                  <Input id="pe-broadcast" type="number" min={1} placeholder={t("unlimited")} value={edit.broadcastPerDay} onChange={(e) => setEdit({ ...edit, broadcastPerDay: e.target.value })} />
                  <p className="text-xs text-muted-foreground">{t("fieldBroadcastPerDayHint")}</p>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">{t("featuresTitle")}</p>
                {PLATFORM_FEATURES.map((f) => (
                  <div key={f} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                    <div>
                      <p className="text-sm text-foreground">{t(`feature_${f}`)}</p>
                      <p className="text-xs text-muted-foreground">{t(`feature_${f}_desc`)}</p>
                    </div>
                    <Switch
                      checked={edit.features[f] ?? true}
                      onCheckedChange={(v) => setEdit({ ...edit, features: { ...edit.features, [f]: v } })}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setEdit(null)}>{t("cancel")}</Button>
            <Button disabled={busy} onClick={() => void saveEdit()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suspend */}
      <Dialog open={suspend !== null} onOpenChange={(o) => !o && !busy && setSuspend(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("suspendTitle", { name: suspend?.row.name ?? "" })}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("suspendDesc")}</DialogDescription>
          </DialogHeader>
          {suspend && (
            <div className="space-y-1.5">
              <Label htmlFor="ps-reason">{t("suspendReason")}</Label>
              <Textarea id="ps-reason" rows={3} value={suspend.reason} onChange={(e) => setSuspend({ ...suspend, reason: e.target.value })} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setSuspend(null)}>{t("cancel")}</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!suspend) return;
                const ok = await patch(suspend.row.id, { status: "suspended", reason: suspend.reason }, t("suspended"));
                if (ok) setSuspend(null);
              }}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("suspendConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
