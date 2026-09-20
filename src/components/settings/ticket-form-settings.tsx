"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Archive,
  Loader2,
  Pencil,
  Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { useTicketFields } from "@/hooks/use-ticket-fields";
import { setCachedTicketKeyPrefix, useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { createClient } from "@/lib/supabase/client";
import { isValidPrefix, normalizePrefix, ticketKey } from "@/lib/tickets/key";
import {
  TICKET_FIELD_TYPES,
  fieldsForCategory,
  parseOptions,
} from "@/lib/tickets/custom-fields";
import type {
  TicketCategory,
  TicketCustomValues,
  TicketFieldDefinition,
  TicketFieldType,
} from "@/types";
import { TicketFieldInput } from "@/components/tickets/ticket-field-input";
import { SettingsChip } from "./settings-chip";
import { SettingsPanelHead } from "./settings-panel-head";

const CATEGORIES: TicketCategory[] = [
  "general",
  "billing",
  "technical",
  "feature_request",
  "bug",
  "account",
  "other",
];

interface Draft {
  id: string | null;
  label: string;
  field_type: TicketFieldType;
  optionsText: string;
  is_required: boolean;
  categories: TicketCategory[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  label: "",
  field_type: "text",
  optionsText: "",
  is_required: false,
  categories: [],
};

/**
 * Settings → Ticket form: the admin-side builder for the customizable
 * ticket form (migration 066). Fields are extra inputs on every new
 * ticket, optionally scoped to specific ticket categories. Archiving
 * (not deleting) keeps old tickets' values readable.
 */
export function TicketFormSettings() {
  const t = useTranslations("Settings.ticketForm");
  const tCat = useTranslations("Tickets.detail.category");
  const canEdit = useCapability("tickets.configure-form");
  const { accountId } = useAuth();
  const { fields, loading, reload } = useTicketFields();
  const { prefix: savedPrefix } = useTicketKeyPrefix();
  const [prefixDraft, setPrefixDraft] = useState<string | null>(null);
  const [savingPrefix, setSavingPrefix] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [previewCategory, setPreviewCategory] = useState<TicketCategory>("general");
  const [previewValues, setPreviewValues] = useState<TicketCustomValues>({});

  const active = fields.filter((f) => f.is_active).sort((a, b) => a.position - b.position);
  const archived = fields.filter((f) => !f.is_active);

  const openNew = () => setDraft({ ...EMPTY_DRAFT });
  const openEdit = (f: TicketFieldDefinition) =>
    setDraft({
      id: f.id,
      label: f.label,
      field_type: f.field_type,
      optionsText: f.options.join("\n"),
      is_required: f.is_required,
      categories: f.applies_to_categories,
    });

  const options = draft ? parseOptions(draft.optionsText) : [];
  const dropdownNeedsOptions = draft?.field_type === "dropdown" && options.length === 0;
  const canSave = !!draft && draft.label.trim().length > 0 && !dropdownNeedsOptions;

  const handleSave = async () => {
    if (!draft || !accountId || !canSave) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      label: draft.label.trim(),
      options: draft.field_type === "dropdown" ? options : [],
      is_required: draft.is_required,
      applies_to_categories: draft.categories,
    };
    const { error } = draft.id
      ? await supabase.from("ticket_field_definitions").update(payload).eq("id", draft.id)
      : await supabase.from("ticket_field_definitions").insert({
          ...payload,
          account_id: accountId,
          field_type: draft.field_type,
          position: fields.reduce((max, f) => Math.max(max, f.position), 0) + 1,
        });
    setSaving(false);
    if (error) {
      toast.error(error.code === "23505" ? t("duplicate", { name: payload.label }) : t("saveFailed"));
      return;
    }
    setDraft(null);
    await reload();
  };

  const setActiveFlag = async (f: TicketFieldDefinition, is_active: boolean) => {
    setBusyId(f.id);
    const supabase = createClient();
    const { error } = await supabase
      .from("ticket_field_definitions")
      .update({ is_active })
      .eq("id", f.id);
    setBusyId(null);
    if (error) {
      toast.error(error.code === "23505" ? t("duplicate", { name: f.label }) : t("saveFailed"));
      return;
    }
    await reload();
  };

  const move = async (index: number, dir: -1 | 1) => {
    const a = active[index];
    const b = active[index + dir];
    if (!a || !b) return;
    setBusyId(a.id);
    const supabase = createClient();
    // Swap positions. If two rows share a position (older data), nudge so
    // the swap still changes their order.
    const posA = a.position === b.position ? b.position + dir : b.position;
    const [r1, r2] = await Promise.all([
      supabase.from("ticket_field_definitions").update({ position: posA }).eq("id", a.id),
      supabase.from("ticket_field_definitions").update({ position: a.position }).eq("id", b.id),
    ]);
    setBusyId(null);
    if (r1.error || r2.error) toast.error(t("saveFailed"));
    await reload();
  };

  const toggleCategory = (c: TicketCategory) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            categories: d.categories.includes(c)
              ? d.categories.filter((x) => x !== c)
              : [...d.categories, c],
          }
        : d,
    );

  const previewFields = fieldsForCategory(fields, previewCategory);

  const prefixValue = prefixDraft ?? savedPrefix;
  const prefixValid = isValidPrefix(prefixValue);
  const savePrefix = async () => {
    if (!accountId || !prefixValid || prefixValue === savedPrefix) return;
    setSavingPrefix(true);
    const { error } = await createClient()
      .from("accounts")
      .update({ ticket_key_prefix: prefixValue })
      .eq("id", accountId);
    setSavingPrefix(false);
    if (error) {
      toast.error(t("prefixSaveFailed"));
      return;
    }
    setCachedTicketKeyPrefix(accountId, prefixValue);
    setPrefixDraft(null);
    toast.success(t("prefixSaved", { key: ticketKey(prefixValue, 12) }));
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          canEdit ? (
            <Button onClick={openNew}>
              <Plus className="size-4" />
              {t("addField")}
            </Button>
          ) : undefined
        }
      />

      {!canEdit && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("adminOnly")}
        </p>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t("prefixTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("prefixHint")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={prefixValue}
              onChange={(e) => setPrefixDraft(normalizePrefix(e.target.value).slice(0, 6))}
              disabled={!canEdit || savingPrefix}
              maxLength={6}
              aria-label={t("prefixTitle")}
              aria-invalid={!prefixValid}
              className="w-28 font-mono uppercase"
            />
            <span className="text-sm text-muted-foreground">
              {t("prefixPreview", { key: ticketKey(prefixValid ? prefixValue : savedPrefix, 12) })}
            </span>
            {canEdit && (
              <Button
                size="sm"
                onClick={() => void savePrefix()}
                disabled={savingPrefix || !prefixValid || prefixValue === savedPrefix}
              >
                {savingPrefix ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("save")}
              </Button>
            )}
          </div>
          {!prefixValid && <p className="text-xs text-destructive">{t("prefixInvalid")}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : active.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {active.map((f, i) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{f.label}</span>
                      <SettingsChip>{t(`type.${f.field_type}`)}</SettingsChip>
                      {f.is_required && <SettingsChip variant="warn">{t("required")}</SettingsChip>}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {f.applies_to_categories.length === 0
                        ? t("appliesToAll")
                        : t("appliesTo", {
                            categories: f.applies_to_categories.map((c) => tCat(c)).join(", "),
                          })}
                      {f.field_type === "dropdown" && ` · ${f.options.join(", ")}`}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === 0 || busyId !== null}
                        onClick={() => void move(i, -1)}
                        title={t("moveUp")}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={i === active.length - 1 || busyId !== null}
                        onClick={() => void move(i, 1)}
                        title={t("moveDown")}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(f)} title={t("edit")}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busyId === f.id}
                        onClick={() => void setActiveFlag(f, false)}
                        title={t("archive")}
                        className="text-muted-foreground hover:text-red-400"
                      >
                        {busyId === f.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Archive className="size-4" />
                        )}
                      </Button>
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
            <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t("archivedHeading")}
            </p>
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t("archivedHint")}</p>
            <ul className="divide-y divide-border">
              {archived.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex-1 text-sm text-muted-foreground">{f.label}</span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === f.id}
                      onClick={() => void setActiveFlag(f, true)}
                    >
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

      {/* Live preview — the form an agent will see for the chosen category. */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">{t("previewTitle")}</p>
            <Select value={previewCategory} onValueChange={(v) => setPreviewCategory((v ?? "general") as TicketCategory)}>
              <SelectTrigger className="w-44 bg-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {tCat(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {previewFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("previewEmpty")}</p>
          ) : (
            <div className="space-y-3">
              {previewFields.map((f) => (
                <TicketFieldInput
                  key={f.id}
                  field={f}
                  value={previewValues[f.id]}
                  onChange={(v) =>
                    setPreviewValues((prev) => {
                      const next = { ...prev };
                      if (v === undefined) delete next[f.id];
                      else next[f.id] = v;
                      return next;
                    })
                  }
                  idPrefix="preview-field"
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {draft?.id ? t("editTitle") : t("addTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("dialogDesc")}</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="tf-label" className="text-foreground">
                  {t("labelLabel")}
                </Label>
                <Input
                  id="tf-label"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder={t("labelPlaceholder")}
                  maxLength={80}
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-foreground">{t("typeLabel")}</Label>
                <Select
                  value={draft.field_type}
                  disabled={draft.id !== null}
                  onValueChange={(v) => setDraft({ ...draft, field_type: (v ?? "text") as TicketFieldType })}
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_FIELD_TYPES.map((ft) => (
                      <SelectItem key={ft} value={ft}>
                        {t(`type.${ft}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {draft.id !== null && (
                  <p className="text-xs text-muted-foreground">{t("typeLocked")}</p>
                )}
              </div>

              {draft.field_type === "dropdown" && (
                <div className="space-y-1.5">
                  <Label htmlFor="tf-options" className="text-foreground">
                    {t("optionsLabel")}
                  </Label>
                  <textarea
                    id="tf-options"
                    value={draft.optionsText}
                    onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
                    rows={4}
                    placeholder={t("optionsPlaceholder")}
                    className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                  />
                  <p className="text-xs text-muted-foreground">
                    {dropdownNeedsOptions ? t("optionsNeeded") : t("optionsHint", { count: options.length })}
                  </p>
                </div>
              )}

              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={draft.is_required}
                  onCheckedChange={(c) => setDraft({ ...draft, is_required: c === true })}
                />
                <span className="text-sm text-foreground">{t("requiredLabel")}</span>
              </label>

              <div className="space-y-1.5">
                <Label className="text-foreground">{t("scopeLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("scopeHint")}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {CATEGORIES.map((c) => (
                    <label key={c} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                      <Checkbox
                        checked={draft.categories.includes(c)}
                        onCheckedChange={() => toggleCategory(c)}
                      />
                      {tCat(c)}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="border-border bg-popover">
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={!canSave || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
