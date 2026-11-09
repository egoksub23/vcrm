"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InfoTip } from "./info-tip";

/**
 * The root cause: what went wrong and why, once it is known. A school can require it before an incident is closed (Setup, Rules, "Before an incident moves
 * on"), and it prints in the report for filing. Anyone who manages incidents can write it; everyone who can see the incident can read it. Saving is recorded
 * in the Timeline.
 */
export function FindingsPanel({ value, canEdit, onSave }: { value: string | null; canEdit: boolean; onSave: (text: string) => Promise<boolean> }) {
  const t = useTranslations("Incidents.detail.findings");
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep the box in step with the saved value
    setDraft(value ?? "");
  }, [value]);

  if (!canEdit && !value) return null;
  const changed = draft.trim() !== (value ?? "").trim();

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Search className="size-3.5" />
        {t("title")}
        <InfoTip text={t("tip")} />
      </h3>
      {canEdit ? (
        <>
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={2000} placeholder={t("placeholder")} className="bg-muted text-[13px]" />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={busy || !changed}
              onClick={async () => {
                setBusy(true);
                await onSave(draft.trim());
                setBusy(false);
              }}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("save")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-[13px] whitespace-pre-wrap text-foreground">{value}</p>
      )}
    </div>
  );
}
