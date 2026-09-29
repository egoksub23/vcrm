"use client";

// Settings > Incidents > Escalation recipients (incidents.manage). Two
// MultiSelectPopover pickers — Level 2, Level 3 — backed by
// incident_escalation_recipients (migration 122). Each toggle saves
// immediately, same convention multi-select-popover.tsx's own header
// comment describes and this session's Sembang Tasks v2 assignee picker
// already used. Empty for a level falls back to Admins/Owner plus
// anyone holding incidents.manage (including via a Compliance Officer
// custom role) — surfaced as a hint, not hidden.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";

import { MultiSelectPopover, type PickerOption } from "@/components/settings/team/multi-select-popover";
import { useAccountMembers } from "@/hooks/use-account-members";
import { createClient } from "@/lib/supabase/client";

interface RecipientRow {
  id: string;
  level: 2 | 3;
  user_id: string;
}

export function EscalationRecipientsTab() {
  const t = useTranslations("Settings.incidents.recipients");
  const { members } = useAccountMembers();
  const [rows, setRows] = useState<RecipientRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = await createClient().from("incident_escalation_recipients").select("id, level, user_id");
    setRows((data as RecipientRow[]) ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const options: PickerOption[] = members.map((m) => ({ id: m.user_id, label: m.full_name }));

  const toggle = async (level: 2 | 3, nextIds: string[]) => {
    if (!rows) return;
    const current = rows.filter((r) => r.level === level);
    const currentIds = current.map((r) => r.user_id);
    const added = nextIds.filter((id) => !currentIds.includes(id));
    const removed = current.filter((r) => !nextIds.includes(r.user_id));

    setBusy(true);
    try {
      await Promise.all([
        ...added.map(async (userId) => {
          const res = await fetch("/api/account/incidents/escalation-recipients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level, user_id: userId }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast.error(data?.error || t("saveFailed"));
          }
        }),
        ...removed.map(async (row) => {
          const res = await fetch(`/api/account/incidents/escalation-recipients/${row.id}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast.error(data?.error || t("saveFailed"));
          }
        }),
      ]);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {([2, 3] as const).map((level) => {
        const selected = rows.filter((r) => r.level === level).map((r) => r.user_id);
        return (
          <div key={level} className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-foreground">{t(`level${level}Title` as "level2Title" | "level3Title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t(`level${level}Hint` as "level2Hint" | "level3Hint")}</p>
            <div className="mt-2">
              <MultiSelectPopover
                options={options}
                selected={selected}
                onChange={(next) => void toggle(level, next)}
                label={selected.length === 0 ? t("noneConfigured") : t("recipientCount", { count: selected.length })}
                icon={<UserPlus className="size-3.5" />}
                emptyLabel={t("noMembers")}
                disabled={busy}
                className="h-8 w-full max-w-sm text-xs"
              />
            </div>
            {selected.length === 0 && <p className="mt-2 text-[11px] text-muted-foreground">{t("fallbackHint")}</p>}
          </div>
        );
      })}
    </div>
  );
}
