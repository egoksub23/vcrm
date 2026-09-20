"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Coins, ListPlus, Loader2, Plus, Trash2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth, useCapability } from "@/hooks/use-auth";
import {
  CURRENCIES,
  CURRENCY_LABEL_MAX,
  MAX_ACCOUNT_CURRENCIES,
  currencySymbol,
  serializeCurrencies,
  validateCurrencyEntry,
  withCurrencyIncluded,
  type CurrencyOption,
} from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Deals settings — the account's default currency and the list of
 * currencies it offers.
 *
 * One currency per account is still the rule for totals (issue #218):
 * the default seeds new deals and formats every aggregated total.
 * Existing deals keep their own saved currency, so removing a currency
 * from the list never rewrites a deal. Writes go straight to
 * `accounts.default_currency` / `accounts.currencies` (migration 068);
 * the `accounts_update` RLS policy (017) restricts both to admins+, so
 * non-admins see disabled, read-only controls.
 */
export function DealsSettings() {
  const supabase = createClient();
  const {
    accountId,
    defaultCurrency,
    currencies,
    profileLoading,
    refreshProfile,
  } = useAuth();
  const canEditWorkspace = useCapability('settings.workspace');

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);
  const [savingList, setSavingList] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const t = useTranslations("Settings.deals");

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  const dirty = selected !== defaultCurrency;
  // A legacy default that isn't in the list still has to be selectable.
  const defaultChoices = withCurrencyIncluded(currencies, defaultCurrency);
  const suggestions = CURRENCIES.filter((c) => !currencies.some((x) => x.code === c.code));

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ default_currency: selected })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    // Pull the new value back into the auth context so the deal form
    // and every total pick it up without a full reload.
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  async function saveList(next: CurrencyOption[], successMessage: string): Promise<boolean> {
    if (!accountId) return false;
    setSavingList(true);
    const { error } = await supabase
      .from("accounts")
      .update({ currencies: serializeCurrencies(next) })
      .eq("id", accountId);
    if (error) {
      console.error("[DealsSettings] save currencies failed:", error);
      toast.error(t("saveCurrenciesFailed"));
      setSavingList(false);
      return false;
    }
    await refreshProfile();
    setSavingList(false);
    toast.success(successMessage);
    return true;
  }

  async function handleAdd(entry: { code: string; label: string }) {
    const problem = validateCurrencyEntry(entry, currencies);
    if (problem) {
      toast.error(
        t(`errors.${problem}`, { max: problem === "limit" ? MAX_ACCOUNT_CURRENCIES : CURRENCY_LABEL_MAX }),
      );
      return false;
    }
    const added = { code: entry.code.trim().toUpperCase(), label: entry.label.trim() };
    return saveList([...currencies, added], t("added", { code: added.code }));
  }

  async function handleAddTyped() {
    if (await handleAdd({ code, label })) {
      setCode("");
      setLabel("");
    }
  }

  async function handleRemove(target: CurrencyOption) {
    if (target.code === defaultCurrency) {
      toast.error(t("cannotRemoveDefault"));
      return;
    }
    if (currencies.length <= 1) {
      toast.error(t("cannotRemoveLast"));
      return;
    }
    await saveList(
      currencies.filter((c) => c.code !== target.code),
      t("removed", { code: target.code }),
    );
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Coins className="size-4 text-primary" />
            {t("defaultCurrency")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("defaultCurrencyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("currencyLabel")}</Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditWorkspace || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {defaultChoices.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditWorkspace && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditWorkspace && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <ListPlus className="size-4 text-primary" />
            {t("currenciesTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("currenciesDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {currencies.map((c) => {
              const isDefault = c.code === defaultCurrency;
              return (
                <li key={c.code} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-12 shrink-0 font-mono text-sm font-semibold text-foreground">
                    {c.code}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {c.label}
                  </span>
                  <span className="hidden w-10 shrink-0 text-right text-xs text-muted-foreground sm:block">
                    {currencySymbol(c.code) ?? ""}
                  </span>
                  {isDefault ? (
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {t("defaultBadge")}
                    </span>
                  ) : null}
                  {canEditWorkspace ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={savingList || isDefault}
                      onClick={() => handleRemove(c)}
                      aria-label={t("removeAria", { code: c.code })}
                      title={isDefault ? t("cannotRemoveDefault") : t("removeAria", { code: c.code })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t("removeNote")}</p>

          {canEditWorkspace ? (
            <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid w-24 gap-1.5">
                  <Label htmlFor="currency-code" className="text-muted-foreground">
                    {t("codeLabel")}
                  </Label>
                  <Input
                    id="currency-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                    maxLength={3}
                    placeholder="MYR"
                    className="font-mono uppercase"
                  />
                </div>
                <div className="grid min-w-[160px] flex-1 gap-1.5">
                  <Label htmlFor="currency-name" className="text-muted-foreground">
                    {t("nameLabel")}
                  </Label>
                  <Input
                    id="currency-name"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddTyped();
                    }}
                    maxLength={CURRENCY_LABEL_MAX}
                    placeholder="Malaysian Ringgit"
                  />
                </div>
                <Button
                  onClick={handleAddTyped}
                  disabled={savingList || code.length !== 3 || !label.trim()}
                >
                  {savingList ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t("add")}
                </Button>
              </div>

              {suggestions.length > 0 ? (
                <select
                  value=""
                  disabled={savingList}
                  onChange={(e) => {
                    const pick = suggestions.find((c) => c.code === e.target.value);
                    if (pick) void handleAdd(pick);
                  }}
                  aria-label={t("addFromList")}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60 sm:max-w-xs"
                >
                  <option value="">{t("addFromList")}</option>
                  {suggestions.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
