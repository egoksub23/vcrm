"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, FileText, Loader2, Paperclip, ShieldAlert, Upload, X } from "lucide-react";

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
import { useAuth } from "@/hooks/use-auth";
import { dragHasFiles, droppedImages, pastedImages } from "@/lib/media/clipboard-images";
import { attachFileToIncident } from "@/lib/incidents/attachment-actions";
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

interface StagedFile {
  key: string;
  file: File;
  preview: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [incidentType, setIncidentType] = useState<IncidentTypeCode | "">("");
  const [detectionSource, setDetectionSource] = useState<IncidentDetectionSource>("customer");
  const [severity, setSeverity] = useState<IncidentSeverity>("P3");
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setIncidentType("");
    setDetectionSource("customer");
    setSeverity("P3");
    for (const s of staged) if (s.preview) URL.revokeObjectURL(s.preview);
    setStaged([]);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const addFiles = (files: File[]) => {
    const next = files.map((file) => ({
      key: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    if (next.length) setStaged((prev) => [...prev, ...next]);
  };
  const removeStaged = (key: string) =>
    setStaged((prev) => {
      const gone = prev.find((s) => s.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((s) => s.key !== key);
    });

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

      // Evidence goes up after the incident exists (attachments are filed
      // under it). A failed file does not undo the report.
      if (staged.length > 0 && user) {
        let failed = 0;
        for (const s of staged) {
          try {
            await attachFileToIncident(incident, s.file, user.id);
          } catch {
            failed += 1;
          }
        }
        if (failed > 0) toast.error(t("attachmentsFailed", { count: failed }));
      }

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
      <DialogContent
        className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-2xl"
        onPaste={(e) => {
          if ((e.target as HTMLElement).closest?.("input, [contenteditable]")) return;
          const images = pastedImages(e.clipboardData?.files, e.clipboardData?.getData("text/plain"));
          if (images.length === 0) return;
          e.preventDefault();
          addFiles(images);
        }}
      >
        <DialogHeader className="pb-1">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-600 dark:text-red-400">
              <ShieldAlert className="size-4.5" />
            </div>
            <DialogTitle className="text-lg text-popover-foreground">{t("title")}</DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground">{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-1">
          <div className="space-y-2">
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
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="incident-description" className="text-foreground">
              {t("whatHappenedLabel")} <span className="font-normal text-muted-foreground">{t("whatHappenedHint")}</span>
            </Label>
            <div
              onDragOver={(e) => {
                if (!dragHasFiles(e.dataTransfer.types)) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (!dragHasFiles(e.dataTransfer.types)) return;
                e.preventDefault();
                setDragging(false);
                const images = droppedImages(e.dataTransfer.files);
                if (images.length > 0) addFiles(images);
                else if (e.dataTransfer.files.length > 0) addFiles(Array.from(e.dataTransfer.files));
              }}
              className={cn(
                "rounded-lg border transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-transparent",
              )}
            >
              <Textarea
                id="incident-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("whatHappenedPlaceholder")}
                rows={8}
                disabled={busy}
                className="resize-y bg-muted text-[13.5px] leading-relaxed"
              />
            </div>
            <p className="text-[11.5px] text-muted-foreground">{t("composerHint")}</p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Paperclip className="size-3.5" />
                {t("attachFiles")}
              </button>
              <span className="text-[11px] text-muted-foreground">{t("attachHint")}</span>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>

            {staged.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {staged.map((s) => (
                  <li
                    key={s.key}
                    className="flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/50 py-1 pr-1.5 pl-1 text-xs"
                  >
                    {s.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not a network image
                      <img src={s.preview} alt="" className="size-8 rounded object-cover" />
                    ) : (
                      <FileText className="mx-1.5 size-4 text-muted-foreground" />
                    )}
                    <span className="max-w-40 truncate">{s.file.name || t("pastedImage")}</span>
                    <span className="text-muted-foreground">{formatBytes(s.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeStaged(s.key)}
                      disabled={busy}
                      aria-label={t("removeFile", { name: s.file.name })}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-foreground">{t("typeLabel")}</Label>
              <Select value={incidentType} onValueChange={(v) => setIncidentType(v as IncidentTypeCode)}>
                <SelectTrigger className="h-10 w-full bg-muted">
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
            <div className="space-y-2">
              <Label className="text-foreground">{t("detectedLabel")}</Label>
              <Select value={detectionSource} onValueChange={(v) => setDetectionSource(v as IncidentDetectionSource)}>
                <SelectTrigger className="h-10 w-full bg-muted">
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

          <div className="space-y-2">
            <Label className="text-foreground">
              {t("severityLabel")} <span className="font-normal text-muted-foreground">{t("severityHint")}</span>
            </Label>
            <div className="grid grid-cols-4 gap-2.5">
              {INCIDENT_SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  disabled={busy}
                  className={cn(
                    "rounded-lg border px-2 py-2.5 text-center text-xs font-semibold transition-colors",
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

        <DialogFooter className="border-border bg-popover pt-3">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={busy} className="bg-red-600 text-white hover:bg-red-700">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
