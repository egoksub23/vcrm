"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useTags } from "@/hooks/use-tags";
import { createClient } from "@/lib/supabase/client";
import { matchAutoLabelRules, type AutoLabelRule } from "@/lib/conversations/auto-label-match";
import { parseKeywords } from "@/lib/conversations/auto-label-keywords";
import { SettingsChip } from "./settings-chip";

interface Draft {
  id: string | null;
  tagId: string;
  keywordsText: string;
  matchType: "word" | "contains";
  description: string;
  isActive: boolean;
}

const EMPTY: Draft = {
  id: null,
  tagId: "",
  keywordsText: "",
  matchType: "word",
  description: "",
  isActive: true,
};

/**
 * Settings → Conversation labels → Auto-labels (migration 067). Admins map a
 * label to keywords and/or a plain description; matching inbound messages
 * get that conversation label automatically. An opt-in AI pass covers what
 * keywords miss.
 */
export function AutoLabelSettings() {
  const t = useTranslations("Settings.autoLabels");
  const { accountId } = useAuth();
  // `tags` resolves ids on saved rules; only conversation labels can be
  // picked for a new one (migration 068).
  const { tags, conversationLabels } = useTags();
  const [rules, setRules] = useState<AutoLabelRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testText, setTestText] = useState("");

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const [rulesRes, accountRes, aiRes] = await Promise.all([
      supabase
        .from("auto_label_rules")
        .select("id, tag_id, keywords, match_type, description, is_active")
        .order("created_at"),
      supabase.from("accounts").select("auto_label_ai_enabled").eq("id", accountId).maybeSingle(),
      supabase.from("ai_configs").select("is_active").eq("account_id", accountId).maybeSingle(),
    ]);
    setRules(((rulesRes.data ?? []) as (AutoLabelRule & { is_active: boolean })[]));
    setAiEnabled(Boolean(accountRes.data?.auto_label_ai_enabled));
    setAiConfigured(Boolean(aiRes.data?.is_active));
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const tagById = new Map(tags.map((tg) => [tg.id, tg]));
  const keywords = draft ? parseKeywords(draft.keywordsText) : [];
  const hasSignal = keywords.length > 0 || (draft?.description.trim().length ?? 0) > 0;
  const canSave = !!draft && draft.tagId !== "" && hasSignal;

  const openEdit = (r: AutoLabelRule & { is_active?: boolean }) =>
    setDraft({
      id: r.id,
      tagId: r.tag_id,
      keywordsText: r.keywords.join("\n"),
      matchType: r.match_type,
      description: r.description ?? "",
      isActive: r.is_active ?? true,
    });

  const handleSave = async () => {
    if (!draft || !accountId || !canSave) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      tag_id: draft.tagId,
      keywords,
      match_type: draft.matchType,
      description: draft.description.trim() || null,
      is_active: draft.isActive,
    };
    const { error } = draft.id
      ? await supabase.from("auto_label_rules").update(payload).eq("id", draft.id)
      : await supabase.from("auto_label_rules").insert({ ...payload, account_id: accountId });
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    setDraft(null);
    await load();
  };

  const toggleActive = async (r: AutoLabelRule & { is_active?: boolean }) => {
    const { error } = await createClient()
      .from("auto_label_rules")
      .update({ is_active: !(r.is_active ?? true) })
      .eq("id", r.id);
    if (error) toast.error(t("saveFailed"));
    await load();
  };

  const handleDelete = async (r: AutoLabelRule) => {
    if (!window.confirm(t("deleteConfirm"))) return;
    const { error } = await createClient().from("auto_label_rules").delete().eq("id", r.id);
    if (error) toast.error(t("saveFailed"));
    await load();
  };

  const handleAiToggle = async (next: boolean) => {
    if (!accountId) return;
    setAiEnabled(next);
    const { error } = await createClient()
      .from("accounts")
      .update({ auto_label_ai_enabled: next })
      .eq("id", accountId);
    if (error) {
      setAiEnabled(!next);
      toast.error(t("saveFailed"));
    }
  };

  const testHits = testText.trim()
    ? matchAutoLabelRules(
        (rules as (AutoLabelRule & { is_active?: boolean })[]).filter((r) => r.is_active ?? true),
        testText,
      )
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Sparkles className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : (
          <>
            {rules.length === 0 ? (
              <p className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                {t("empty")}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {(rules as (AutoLabelRule & { is_active?: boolean })[]).map((r) => {
                  const tag = tagById.get(r.tag_id);
                  const active = r.is_active ?? true;
                  return (
                    <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{
                              backgroundColor: `${tag?.color ?? "#888888"}20`,
                              color: tag?.color ?? undefined,
                            }}
                          >
                            {tag?.name ?? t("deletedLabel")}
                          </span>
                          {!active && <SettingsChip>{t("paused")}</SettingsChip>}
                          {r.keywords.length === 0 && <SettingsChip variant="admin">{t("aiOnly")}</SettingsChip>}
                        </div>
                        {r.keywords.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {r.keywords.join(", ")}
                            <span className="ml-1 opacity-70">
                              · {t(r.match_type === "word" ? "matchWord" : "matchContains")}
                            </span>
                          </p>
                        )}
                        {r.description && (
                          <p className="text-xs text-muted-foreground">“{r.description}”</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Switch
                          checked={active}
                          onCheckedChange={() => void toggleActive(r)}
                          aria-label={t("toggleRule")}
                        />
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(r)} title={t("edit")}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void handleDelete(r)}
                          title={t("delete")}
                          className="text-muted-foreground hover:text-red-400"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <Button variant="outline" onClick={() => setDraft({ ...EMPTY })} disabled={conversationLabels.length === 0}>
              <Plus className="size-4" />
              {t("addRule")}
            </Button>
            {conversationLabels.length === 0 && <p className="text-xs text-muted-foreground">{t("needLabels")}</p>}

            <div className="space-y-1.5 border-t border-border pt-4">
              <Label htmlFor="al-test" className="text-foreground">
                {t("testLabel")}
              </Label>
              <Input
                id="al-test"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder={t("testPlaceholder")}
              />
              {testText.trim() && (
                <p className="text-xs text-muted-foreground">
                  {testHits.length === 0
                    ? t("testNoMatch")
                    : t("testMatch", {
                        labels: testHits.map((id) => tagById.get(id)?.name ?? "?").join(", "),
                      })}
                </p>
              )}
            </div>

            <div className="flex items-start gap-3 border-t border-border pt-4">
              <Switch
                checked={aiEnabled}
                onCheckedChange={(v) => void handleAiToggle(v)}
                aria-label={t("aiToggle")}
              />
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">{t("aiToggle")}</p>
                <p className="text-xs text-muted-foreground">{t("aiHint")}</p>
                {aiEnabled && !aiConfigured && (
                  <p className="text-xs text-amber-600 dark:text-amber-300">{t("aiNotConfigured")}</p>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>

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
                <Label className="text-foreground">{t("labelLabel")}</Label>
                <Select
                  value={draft.tagId === "" ? undefined : draft.tagId}
                  onValueChange={(v) => setDraft({ ...draft, tagId: v ?? "" })}
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue placeholder={t("labelPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {conversationLabels.map((tg) => (
                      <SelectItem key={tg.id} value={tg.id}>
                        {tg.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="al-kw" className="text-foreground">
                  {t("keywordsLabel")}
                </Label>
                <textarea
                  id="al-kw"
                  value={draft.keywordsText}
                  onChange={(e) => setDraft({ ...draft, keywordsText: e.target.value })}
                  rows={3}
                  placeholder={t("keywordsPlaceholder")}
                  className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <p className="text-xs text-muted-foreground">{t("keywordsHint", { count: keywords.length })}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-foreground">{t("matchLabel")}</Label>
                <Select
                  value={draft.matchType}
                  onValueChange={(v) => setDraft({ ...draft, matchType: v === "contains" ? "contains" : "word" })}
                >
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="word">{t("matchWordLong")}</SelectItem>
                    <SelectItem value="contains">{t("matchContainsLong")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="al-desc" className="text-foreground">
                  {t("descriptionLabel")}
                </Label>
                <textarea
                  id="al-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={2}
                  maxLength={300}
                  placeholder={t("descriptionPlaceholder")}
                  className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <p className="text-xs text-muted-foreground">{t("descriptionHint")}</p>
              </div>
              {!hasSignal && <p className="text-xs text-destructive">{t("needSignal")}</p>}
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
    </Card>
  );
}
