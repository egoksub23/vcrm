"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Loader2, Pencil, Plus } from "lucide-react";

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
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { setCachedRequireResolution, useTicketResolutions } from "@/hooks/use-ticket-resolutions";
import type { TicketResolution } from "@/types";
import { SettingsChip } from "./settings-chip";
import { SettingsPanelHead } from "./settings-panel-head";

interface Draft {
  id: string | null;
  name: string;
}

/**
 * Settings, Ticket form: the catalogue of resolutions an agent picks from when
 * a ticket is resolved or closed, and the switch that makes the choice
 * required (migration 096). Rename, reorder, add and archive: archiving keeps
 * old tickets readable, the two system entries can be renamed but not archived.
 * Writes go straight to the tables under RLS (`tickets.configure-form`), like
 * the ticket form's fields; every change is audited by the database.
 */
export function TicketResolutionsSettings() {
  const t = useTranslations("Settings.ticketResolutions");
  const canEdit = useCapability("tickets.configure-form");
  const { accountId } = useAuth();
  const { resolutions, active, required, loaded, reload } = useTicketResolutions();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingRequired, setSavingRequired] = useState(false);

  const archived = resolutions.filter((r) => !r.is_active);
  const name = draft?.name.trim() ?? "";
  const canSave = !!draft && name.length > 0 && name.length <= 80;

  const failure = (error: { code?: string } | null, resolutionName: string) =>
    toast.error(error?.code === "23505" ? t("duplicate", { name: resolutionName }) : t("saveFailed"));

  const save = async () => {
    if (!draft || !accountId || !canSave) return;
    setSaving(true);
    const url = draft.id
      ? `/api/account/ticket-resolutions/${encodeURIComponent(draft.id)}`
      : "/api/account/ticket-resolutions";
    const body = draft.id
      ? { name }
      : { name, position: resolutions.reduce((max, r) => Math.max(max, r.position), 0) + 10 };
    const res = await fetch(url, {
      method: draft.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { code?: string } | null;
    setSaving(false);
    if (!res.ok) {
      failure(json, name);
      return;
    }
    setDraft(null);
    await reload();
  };

  const setActiveFlag = async (r: TicketResolution, is_active: boolean) => {
    setBusyId(r.id);
    const res = await fetch(`/api/account/ticket-resolutions/${encodeURIComponent(r.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active }),
    });
    const json = (await res.json().catch(() => null)) as { code?: string } | null;
    setBusyId(null);
    if (!res.ok) {
      failure(json, r.name);
      return;
    }
    await reload();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const a = active[index];
    const b = active[index + dir];
    if (!a || !b) return;
    setBusyId(a.id);
    // Swap positions. If two rows share a position, nudge so the swap still changes their order.
    const posA = a.position === b.position ? b.position + dir : b.position;
    const [res1, res2] = await Promise.all([
      fetch(`/api/account/ticket-resolutions/${encodeURIComponent(a.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: posA }),
      }),
      fetch(`/api/account/ticket-resolutions/${encodeURIComponent(b.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: a.position }),
      }),
    ]);
    setBusyId(null);
    if (!res1.ok || !res2.ok) toast.error(t("saveFailed"));
    await reload();
  };

  const setRequired = async (next: boolean) => {
    if (!accountId) return;
    setSavingRequired(true);
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ require_ticket_resolution: next }),
    });
    setSavingRequired(false);
    if (!res.ok) {
      toast.error(t("requireSaveFailed"));
      return;
    }
    setCachedRequireResolution(accountId, next);
    toast.success(t("requireSaved"));
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200" data-testid="ticket-resolutions-settings">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          canEdit ? (
            <Button onClick={() => setDraft({ id: null, name: "" })}>
              <Plus className="size-4" />
              {t("addResolution")}
            </Button>
          ) : undefined
        }
      />

      {!canEdit && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t("adminOnly")}</p>
      )}

      <Card>
        <CardContent className="flex items-start justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t("requireTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("requireHint")}</p>
          </div>
          <Switch
            checked={required}
            onCheckedChange={(v) => void setRequired(v)}
            disabled={!canEdit || savingRequired || !loaded}
            aria-label={t("requireTitle")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {!loaded ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : active.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {active.map((r, i) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{r.name}</span>
                      {r.is_system ? <SettingsChip>{t("systemChip")}</SettingsChip> : null}
                    </div>
                    {r.is_system ? <p className="mt-1 text-xs text-muted-foreground">{t("systemHint")}</p> : null}
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === 0 || busyId !== null}
                        onClick={() => void move(i, -1)}
                        title={t("moveUp")}
                        aria-label={t("moveUp")}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === active.length - 1 || busyId !== null}
                        onClick={() => void move(i, 1)}
                        title={t("moveDown")}
                        aria-label={t("moveDown")}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDraft({ id: r.id, name: r.name })}
                        title={t("edit")}
                        aria-label={t("edit")}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {!r.is_system ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyId === r.id}
                          onClick={() => void setActiveFlag(r, false)}
                          title={t("archive")}
                          aria-label={t("archive")}
                          className="text-muted-foreground hover:text-red-400"
                        >
                          {busyId === r.id ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
                        </Button>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {archived.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("archivedHeading")}</p>
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t("archivedHint")}</p>
            <ul className="divide-y divide-border">
              {archived.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex-1 text-sm text-muted-foreground">{r.name}</span>
                  {canEdit && (
                    <Button variant="ghost" size="sm" disabled={busyId === r.id} onClick={() => void setActiveFlag(r, true)}>
                      <ArchiveRestore className="size-4" />
                      {t("restore")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{draft?.id ? t("editTitle") : t("addTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("dialogDesc")}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-1.5">
              <Label htmlFor="tr-name" className="text-foreground">
                {t("nameLabel")}
              </Label>
              <Input
                id="tr-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("namePlaceholder")}
                maxLength={80}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
              />
            </div>
          )}
          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={!canSave || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
