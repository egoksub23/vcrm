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
import { useCapability } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { refreshTicketTypes, useTicketTypes } from "@/hooks/use-ticket-types";
import { createClient } from "@/lib/supabase/client";
import type { TicketType } from "@/types";
import { SettingsChip } from "./settings-chip";
import { SettingsPanelHead } from "./settings-panel-head";

interface Draft {
  id: string | null;
  name: string;
}

/** A stable slug from a display name: lower-case, `_`-separated, starting
 *  with a letter (the DB CHECK on ticket_types.slug) — the guard trigger
 *  re-sanitizes it server-side too, this just avoids a round-trip for the
 *  common case. */
function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 39);
  const safe = /^[a-z]/.test(base) ? base : `t_${base}`;
  return safe.slice(0, 40) || "type";
}

/**
 * Settings, Ticket form: the catalogue of ticket "types" (the column is
 * still `category`) an agent picks from when raising a ticket (migration
 * 128). Rename, reorder, add and archive — a straight clone of
 * TicketResolutionsSettings' shape, minus the "require a choice" switch
 * (every ticket always has a type; there is nothing to make optional).
 */
export function TicketTypesSettings() {
  const t = useTranslations("Settings.ticketTypes");
  const canEdit = useCapability("tickets.configure-form");
  const { accountId } = useAuth();
  const { types, active, loaded, reload } = useTicketTypes();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const archived = types.filter((ty) => !ty.is_active);
  const name = draft?.name.trim() ?? "";
  const canSave = !!draft && name.length > 0 && name.length <= 80;

  const failure = (error: { code?: string } | null, typeName: string) =>
    toast.error(error?.code === "23505" ? t("duplicate", { name: typeName }) : t("saveFailed"));

  const save = async () => {
    if (!draft || !accountId || !canSave) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = draft.id
      ? await supabase.from("ticket_types").update({ name }).eq("id", draft.id)
      : await supabase.from("ticket_types").insert({
          account_id: accountId,
          slug: slugify(name),
          name,
          position: types.reduce((max, ty) => Math.max(max, ty.position), 0) + 10,
        });
    setSaving(false);
    if (error) {
      failure(error, name);
      return;
    }
    setDraft(null);
    await reload();
    await refreshTicketTypes(accountId);
  };

  const setActiveFlag = async (ty: TicketType, is_active: boolean) => {
    setBusyId(ty.id);
    const { error } = await createClient().from("ticket_types").update({ is_active }).eq("id", ty.id);
    setBusyId(null);
    if (error) {
      failure(error, ty.name);
      return;
    }
    await reload();
    if (accountId) await refreshTicketTypes(accountId);
  };

  const move = async (index: number, dir: -1 | 1) => {
    const a = active[index];
    const b = active[index + dir];
    if (!a || !b) return;
    setBusyId(a.id);
    const supabase = createClient();
    const posA = a.position === b.position ? b.position + dir : b.position;
    const [r1, r2] = await Promise.all([
      supabase.from("ticket_types").update({ position: posA }).eq("id", a.id),
      supabase.from("ticket_types").update({ position: a.position }).eq("id", b.id),
    ]);
    setBusyId(null);
    if (r1.error || r2.error) toast.error(t("saveFailed"));
    await reload();
    if (accountId) await refreshTicketTypes(accountId);
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200" data-testid="ticket-types-settings">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          canEdit ? (
            <Button onClick={() => setDraft({ id: null, name: "" })}>
              <Plus className="size-4" />
              {t("addType")}
            </Button>
          ) : undefined
        }
      />

      {!canEdit && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t("adminOnly")}</p>
      )}

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
              {active.map((ty, i) => (
                <li key={ty.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{ty.name}</span>
                      {ty.is_system ? <SettingsChip>{t("systemChip")}</SettingsChip> : null}
                    </div>
                    {ty.is_system ? <p className="mt-1 text-xs text-muted-foreground">{t("systemHint")}</p> : null}
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
                        onClick={() => setDraft({ id: ty.id, name: ty.name })}
                        title={t("edit")}
                        aria-label={t("edit")}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {!ty.is_system ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyId === ty.id}
                          onClick={() => void setActiveFlag(ty, false)}
                          title={t("archive")}
                          aria-label={t("archive")}
                          className="text-muted-foreground hover:text-red-400"
                        >
                          {busyId === ty.id ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
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
              {archived.map((ty) => (
                <li key={ty.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex-1 text-sm text-muted-foreground">{ty.name}</span>
                  {canEdit && (
                    <Button variant="ghost" size="sm" disabled={busyId === ty.id} onClick={() => void setActiveFlag(ty, true)}>
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
              <Label htmlFor="tt-name" className="text-foreground">
                {t("nameLabel")}
              </Label>
              <Input
                id="tt-name"
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
