"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Bookmark, ChevronDown, Loader2, Trash2, Users } from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { filtersFromJson, filtersToJson, type TicketFilters } from "@/lib/tickets/filters";
import type { TicketSavedFilter } from "@/types";

/**
 * "Saved filters": apply, save the current filters under a name, delete your
 * own. A saved filter can be shared with the account. Saving needs only
 * membership (RLS: your own rows, plus shared ones from teammates).
 */
export function SavedFiltersMenu({
  filters,
  onApply,
  hasActive,
}: {
  filters: TicketFilters;
  onApply: (filters: TicketFilters) => void;
  hasActive: boolean;
}) {
  const t = useTranslations("Tickets.saved");
  const { user, accountId } = useAuth();
  const [saved, setSaved] = useState<TicketSavedFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await createClient()
      .from("ticket_saved_filters")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) console.error("[SavedFiltersMenu] load failed:", error);
    setSaved((data as TicketSavedFilter[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || !user || !accountId) return;
    setSaving(true);
    const { data, error } = await createClient()
      .from("ticket_saved_filters")
      .insert({
        account_id: accountId,
        user_id: user.id,
        name: trimmed.slice(0, 80),
        filter: filtersToJson(filters),
        is_shared: shared,
      })
      .select("*")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error(t("saveFailed"));
      return;
    }
    setSaved((prev) => [data as TicketSavedFilter, ...prev]);
    toast.success(t("saved", { name: trimmed }));
    setDialogOpen(false);
    setName("");
    setShared(false);
  };

  const handleDelete = async (filter: TicketSavedFilter) => {
    const { error } = await createClient().from("ticket_saved_filters").delete().eq("id", filter.id);
    if (error) {
      toast.error(t("deleteFailed"));
      return;
    }
    setSaved((prev) => prev.filter((f) => f.id !== filter.id));
  };

  const mine = saved.filter((f) => f.user_id === user?.id);
  const others = saved.filter((f) => f.user_id !== user?.id);

  const renderItem = (f: TicketSavedFilter, own: boolean) => (
    <DropdownMenuItem key={f.id} onClick={() => onApply(filtersFromJson(f.filter))} className="justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{f.name}</span>
        {f.is_shared ? <Users className="size-3 shrink-0 text-muted-foreground" aria-label={t("shared")} /> : null}
      </span>
      {own ? (
        <button
          type="button"
          aria-label={t("delete", { name: f.name })}
          title={t("delete", { name: f.name })}
          onClick={(e) => {
            e.stopPropagation();
            void handleDelete(f);
          }}
          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <Bookmark className="size-3.5" />
          {t("title")}
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 border-border bg-popover">
          {loading ? (
            <div className="flex justify-center py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : saved.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("none")}</p>
          ) : (
            <>
              {mine.length > 0 ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("mine")}</DropdownMenuLabel>
                  {mine.map((f) => renderItem(f, true))}
                </DropdownMenuGroup>
              ) : null}
              {others.length > 0 ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("sharedWithYou")}</DropdownMenuLabel>
                  {others.map((f) => renderItem(f, false))}
                </DropdownMenuGroup>
              ) : null}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasActive} onClick={() => setDialogOpen(true)}>
            {t("saveCurrent")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("saveTitle")}</DialogTitle>
            <DialogDescription>{t("saveDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="saved-filter-name">{t("nameLabel")}</Label>
              <Input
                id="saved-filter-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={80}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSave();
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={shared} onCheckedChange={(v) => setShared(v === true)} />
              {t("shareLabel")}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
