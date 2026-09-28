"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  INCIDENT_DETECTION_SOURCES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABEL,
  INCIDENT_TYPES,
  suggestsP2Minimum,
  type IncidentDetectionSource,
  type IncidentSeverity,
  type IncidentTypeCode,
} from "@/lib/incidents/constants";
import type { Incident } from "@/lib/incidents/types";
import { SEVERITY_STYLE } from "./incident-visuals";

interface RaiseIncidentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (incident: Incident) => void;
  onOpenCreated?: (incidentId: string) => void;
}

/**
 * Raise-an-incident form, deliberately short per the plan: title,
 * description, type, how detected, and a best-guess initial severity.
 * Everything else (impact figures, notifiable/PDPA/AML flags, root
 * cause) is filled in by the Compliance Officer during triage — "add
 * what you know now, mark the rest as under investigation" rather than
 * waiting to file a complete report.
 */
export function RaiseIncidentDialog({ open, onOpenChange, onCreated, onOpenCreated }: RaiseIncidentDialogProps) {
  const t = useTranslations("Incidents.raise");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [incidentType, setIncidentType] = useState<IncidentTypeCode | "">("");
  const [detectionSource, setDetectionSource] = useState<IncidentDetectionSource>("customer");
  const [severity, setSeverity] = useState<IncidentSeverity>("P3");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setTitle("");
    setDescription("");
    setIncidentType("");
    setDetectionSource("customer");
    setSeverity("P3");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const showP2Hint = incidentType !== "" && suggestsP2Minimum(incidentType, detectionSource) && severity !== "P1" && severity !== "P2";

  const handleSubmit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t("titleRequired"));
      return;
    }
    if (!incidentType) {
      toast.error(t("typeRequired"));
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          description: description.trim() || undefined,
          incidentType,
          severity,
          detectionSource,
        }),
      });
      const body = (await res.json().catch(() => null)) as { incident?: Incident; error?: string } | null;
      if (!res.ok || !body?.incident) {
        toast.error(body?.error || t("createFailed"));
        return;
      }
      const incident = body.incident;
      toast.success(t("created", { key: `INC-${new Date(incident.created_at).getFullYear()}-${incident.incident_number}` }), {
        action: {
          label: t("open"),
          onClick: () => onOpenCreated?.(incident.id),
        },
      });
      onCreated?.(incident);
      handleOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-red-500/15 text-red-600 dark:text-red-400">
              <ShieldAlert className="size-4" />
            </div>
            <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground">{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="incident-title" className="text-foreground">
              {t("titleLabel")} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="incident-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
              disabled={busy}
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="incident-description" className="text-foreground">
              {t("whatHappenedLabel")} <span className="font-normal text-muted-foreground">{t("whatHappenedHint")}</span>
            </Label>
            <Textarea
              id="incident-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("whatHappenedPlaceholder")}
              rows={4}
              disabled={busy}
              className="resize-y bg-muted"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-foreground">{t("typeLabel")}</Label>
              <Select value={incidentType} onValueChange={(v) => setIncidentType(v as IncidentTypeCode)}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue placeholder={t("typePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_TYPES.map((ty) => (
                    <SelectItem key={ty.code} value={ty.code}>
                      {ty.code} — {ty.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-foreground">{t("detectedLabel")}</Label>
              <Select value={detectionSource} onValueChange={(v) => setDetectionSource(v as IncidentDetectionSource)}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_DETECTION_SOURCES.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-foreground">
              {t("severityLabel")} <span className="font-normal text-muted-foreground">{t("severityHint")}</span>
            </Label>
            <div className="grid grid-cols-4 gap-2">
              {INCIDENT_SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  disabled={busy}
                  className={cn(
                    "rounded-lg border px-2 py-2 text-center text-xs font-semibold transition-colors",
                    severity === s ? cn(SEVERITY_STYLE[s], "border-2") : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {s}
                  <div className="mt-0.5 text-[10.5px] font-normal">{INCIDENT_SEVERITY_LABEL[s]}</div>
                </button>
              ))}
            </div>
            {showP2Hint ? (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-orange-500/10 px-2.5 py-2 text-[12px] text-orange-700 dark:text-orange-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{t("p2MinimumHint")}</span>
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={busy} className="bg-red-600 text-white hover:bg-red-700">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
