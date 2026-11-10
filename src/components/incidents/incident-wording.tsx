"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_DESCRIPTION, MAX_TITLE, MIN_REASON } from "@/lib/incidents/platform/amend";

/**
 * The incident's title and description, with an Edit link for people who manage incidents. Nothing is overwritten: the database writes the wording before and
 * after to the Audit log, and once the incident is closed a reason is required, so a filed record cannot be reworded without saying why.
 */
export function IncidentWording({
  title,
  description,
  descriptionNode,
  closed,
  canEdit,
  onSave,
}: {
  title: string;
  description: string | null;
  /** How the description reads when not being edited (links made clickable by the page). */
  descriptionNode: ReactNode;
  closed: boolean;
  canEdit: boolean;
  onSave: (fields: { title: string; description: string }, reason: string) => Promise<boolean>;
}) {
  const t = useTranslations("Incidents.detail");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [descDraft, setDescDraft] = useState(description ?? "");
  const [reason, setReason] = useState("");

  const start = () => {
    setTitleDraft(title);
    setDescDraft(description ?? "");
    setReason("");
    setEditing(true);
  };
  const unchanged = titleDraft.trim() === title && descDraft.trim() === (description ?? "").trim();
  const needsReason = closed && reason.trim().length < MIN_REASON;

  if (!editing) {
    return (
      <div className="min-w-0">
        <div className="mt-1 flex items-start gap-2">
          <h1 className="text-xl font-bold text-foreground">{title}</h1>
          {canEdit ? (
            <button type="button" onClick={start} className="mt-1 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:underline">
              <Pencil className="size-3" />
              {t("amendEdit")}
            </button>
          ) : null}
        </div>
        {description ? <div className="mt-3">{descriptionNode}</div> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2.5">
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        {t("amendTitleLabel")}
        <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} maxLength={MAX_TITLE} className="bg-muted text-base font-semibold text-foreground" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        {t("amendDescriptionLabel")}
        <Textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} rows={4} maxLength={MAX_DESCRIPTION} className="bg-muted text-sm text-foreground" />
      </label>
      {closed ? (
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          {t("amendReasonLabel")}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t("amendReasonPlaceholder")} className="bg-muted text-sm text-foreground" />
          <span className="font-normal">{t("amendClosedNote")}</span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || unchanged || !titleDraft.trim() || needsReason}
          onClick={async () => {
            setBusy(true);
            const ok = await onSave({ title: titleDraft.trim(), description: descDraft.trim() }, reason.trim());
            setBusy(false);
            if (ok) setEditing(false);
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("editSave")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
          {t("cancel")}
        </Button>
        <span className="text-[11px] text-muted-foreground">{t("amendKept")}</span>
      </div>
    </div>
  );
}
