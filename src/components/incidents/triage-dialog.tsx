"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { severityText } from "@/lib/incidents/severity-display";

export interface TriageResult {
  severity: string;
  leadId: string | null;
  note: string;
}

/**
 * Moving an incident to Triaged is the moment someone takes it on, so it asks for the three things triage is for: confirm how serious it is, say who leads
 * it, and leave a short note. The move, any change and the note are recorded together in the Timeline.
 */
export function TriageDialog({
  open,
  onOpenChange,
  severity,
  severities,
  leadId,
  members,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  severity: string;
  severities: { slug: string; label: string }[];
  leadId: string | null;
  members: { user_id: string; full_name: string }[];
  onConfirm: (r: TriageResult) => Promise<void>;
}) {
  const t = useTranslations("Incidents.detail.triage");
  const [sev, setSev] = useState(severity);
  const [lead, setLead] = useState<string | null>(leadId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Start from what the incident has now each time it opens.
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setSeenOpen(true);
    setSev(severity);
    setLead(leadId);
    setNote("");
  } else if (!open && seenOpen) {
    setSeenOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("help")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label>{t("severity")}</Label>
            <Select value={sev} onValueChange={(v) => setSev(v ?? sev)}>
              <SelectTrigger className="w-full bg-muted">
                <SelectValue>{severityText(sev, severities)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {severities.map((s) => (
                  <SelectItem key={s.slug} value={s.slug}>
                    {severityText(s.slug, severities)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("lead")}</Label>
            <Select value={lead ?? "__none__"} onValueChange={(v) => setLead(v === "__none__" ? null : v)}>
              <SelectTrigger className="w-full bg-muted">
                <SelectValue>{lead ? (members.find((m) => m.user_id === lead)?.full_name ?? "") : t("noLead")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("noLead")}</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="triage-note">{t("note")}</Label>
            <Textarea id="triage-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={t("notePlaceholder")} className="bg-muted" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm({ severity: sev, leadId: lead, note: note.trim() });
              setBusy(false);
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
