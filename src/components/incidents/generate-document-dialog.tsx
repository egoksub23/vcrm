"use client";

// "Generate document" — produces a Form A/B/C/D .docx from the incident
// record plus a short compose step for whatever narrative doesn't live
// on the record (see src/lib/incidents/documents' own header comment on
// persisted vs. compose-time-only fields). Downloads the file and,
// optionally, attaches it to the incident's evidence log via the
// existing client-side upload path (attachFileToIncident) — this route
// has no server-side storage helper of its own.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { attachFileToIncident } from "@/lib/incidents/attachment-actions";
import { useAuth } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import type { Incident } from "@/lib/incidents/types";

type FormLetter = "a" | "b" | "c" | "d";

const FORM_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const A_RECIPIENTS = ["bnm", "sponsor_emi", "safeguarding_bank", "settlement_bank_acquirer", "payment_network", "other"] as const;
const A_OTHER_PARTIES = ["sponsor_emi", "pdp_commissioner", "nsrc", "mycert", "none_yet"] as const;
const C_TIMELINESS_LABELS = [
  "L1 acknowledgement",
  "Escalation to Incident Lead",
  "Initial notification sent",
  "Containment",
  "Service restoration",
  "Full incident report sent",
  "Status updates on schedule",
];

function CheckboxGroup({
  options,
  labels,
  selected,
  onChange,
}: {
  options: readonly string[];
  labels: Record<string, string>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={selected.includes(o)}
            onCheckedChange={(checked) => onChange(checked ? [...selected, o] : selected.filter((x) => x !== o))}
          />
          {labels[o] ?? o}
        </label>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

export function GenerateDocumentDialog({
  open,
  onOpenChange,
  incident,
  incidentLeadName,
  onAttached,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incident: Incident;
  incidentLeadName: string | null;
  onAttached: () => void;
}) {
  const t = useTranslations("Incidents.detail.documents");
  const { user } = useAuth();
  const { nameOf } = useAccountMembers();
  const [form, setForm] = useState<FormLetter | null>(null);
  const [preparedByName, setPreparedByName] = useState("");
  const [preparedByRole, setPreparedByRole] = useState("");
  const [approvedByName, setApprovedByName] = useState("");
  const [approvedByRole, setApprovedByRole] = useState("");
  const [saveAsEvidence, setSaveAsEvidence] = useState(true);
  const [generating, setGenerating] = useState(false);

  // Form A
  const [recipients, setRecipients] = useState<string[]>([]);
  const [actionsRequested, setActionsRequested] = useState("");
  const [otherPartiesNotified, setOtherPartiesNotified] = useState<string[]>([]);

  // Form B
  const [executiveSummary, setExecutiveSummary] = useState("");
  const [timelineText, setTimelineText] = useState("");
  const [reputationalRegulatoryImpact, setReputationalRegulatoryImpact] = useState("");
  const [nextStepsContactName, setNextStepsContactName] = useState("");
  const [nextStepsContactRole, setNextStepsContactRole] = useState("");

  // Form C
  const [reviewMeetingAttendees, setReviewMeetingAttendees] = useState("");
  const [timelinessRows, setTimelinessRows] = useState(
    C_TIMELINESS_LABELS.map((label) => ({ label, required: "", actual: "", reasonIfMissed: "" })),
  );
  const [signOffCeoName, setSignOffCeoName] = useState("");

  // Form D
  const [updateType, setUpdateType] = useState<"status_update" | "final_closure">("status_update");
  const [changesSinceLastUpdate, setChangesSinceLastUpdate] = useState("");
  const [completedSinceLastUpdate, setCompletedSinceLastUpdate] = useState("");
  const [inProgressNextSteps, setInProgressNextSteps] = useState("");
  const [requestsToRecipient, setRequestsToRecipient] = useState("");

  const reset = () => {
    setForm(null);
    setRecipients([]);
    setActionsRequested("");
    setOtherPartiesNotified([]);
    setExecutiveSummary("");
    setTimelineText("");
    setReputationalRegulatoryImpact("");
    setNextStepsContactName("");
    setNextStepsContactRole("");
    setReviewMeetingAttendees("");
    setTimelinessRows(C_TIMELINESS_LABELS.map((label) => ({ label, required: "", actual: "", reasonIfMissed: "" })));
    setSignOffCeoName("");
    setUpdateType("status_update");
    setChangesSinceLastUpdate("");
    setCompletedSinceLastUpdate("");
    setInProgressNextSteps("");
    setRequestsToRecipient("");
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  useEffect(() => {
    if (open && user?.id) setPreparedByName((prev) => prev || nameOf(user.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  const generate = async () => {
    if (!form || !preparedByName.trim() || !preparedByRole.trim()) return;
    const common = {
      preparedByName: preparedByName.trim(),
      preparedByRole: preparedByRole.trim(),
      approvedByName: approvedByName.trim() || undefined,
      approvedByRole: approvedByRole.trim() || undefined,
    };

    let body: Record<string, unknown>;
    if (form === "a") {
      body = { ...common, recipients, actionsRequested: actionsRequested.trim() || undefined, otherPartiesNotified };
    } else if (form === "b") {
      if (!executiveSummary.trim()) return;
      const timeline = timelineText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ at: new Date().toISOString(), event: line, by: preparedByName.trim() }));
      body = {
        ...common,
        executiveSummary: executiveSummary.trim(),
        timeline,
        reputationalRegulatoryImpact: reputationalRegulatoryImpact.trim() || undefined,
        nextStepsContact: { name: nextStepsContactName.trim() || preparedByName.trim(), role: nextStepsContactRole.trim() || preparedByRole.trim() },
      };
    } else if (form === "c") {
      body = {
        ...common,
        reviewMeetingAttendees: reviewMeetingAttendees.trim() || undefined,
        timelinessRows: timelinessRows.map((r) => ({
          label: r.label,
          required: r.required.trim() || undefined,
          actual: r.actual.trim() || undefined,
          reasonIfMissed: r.reasonIfMissed.trim() || undefined,
        })),
        signOffIncidentLeadName: incidentLeadName ?? undefined,
        signOffCeoName: signOffCeoName.trim() || undefined,
      };
    } else {
      if (!changesSinceLastUpdate.trim()) return;
      body = {
        ...common,
        updateType,
        changesSinceLastUpdate: changesSinceLastUpdate.trim(),
        completedSinceLastUpdate: completedSinceLastUpdate.trim() || undefined,
        inProgressNextSteps: inProgressNextSteps.trim() || undefined,
        requestsToRecipient: requestsToRecipient.trim() || undefined,
      };
    }

    setGenerating(true);
    try {
      const res = await fetch(`/api/incidents/${incident.id}/documents/${form}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || t("generateFailed"));
        return;
      }

      const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: FORM_MIME });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);

      if (saveAsEvidence && user?.id) {
        const file = new File([bytes], data.filename, { type: FORM_MIME });
        try {
          await attachFileToIncident(incident, file, user.id);
          onAttached();
        } catch {
          toast.error(t("attachFailed"));
        }
      }

      toast.success(t("generated"));
      close();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {!form ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                { key: "a" as const, name: t("formA"), hint: t("formAHint") },
                { key: "b" as const, name: t("formB"), hint: t("formBHint") },
                { key: "c" as const, name: t("formC"), hint: t("formCHint") },
                { key: "d" as const, name: t("formD"), hint: t("formDHint") },
              ]
            ).map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setForm(f.key)}
                className="rounded-lg border border-border p-3 text-left hover:border-primary/40 hover:bg-primary/5"
              >
                <p className="text-sm font-medium text-foreground">{f.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.hint}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("preparedByName")}>
                <Input value={preparedByName} onChange={(e) => setPreparedByName(e.target.value)} className="h-8 text-xs" />
              </Field>
              <Field label={t("preparedByRole")}>
                <Input value={preparedByRole} onChange={(e) => setPreparedByRole(e.target.value)} className="h-8 text-xs" />
              </Field>
            </div>
            {form !== "c" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("approvedByName")}>
                  <Input value={approvedByName} onChange={(e) => setApprovedByName(e.target.value)} className="h-8 text-xs" />
                </Field>
                <Field label={t("approvedByRole")}>
                  <Input value={approvedByRole} onChange={(e) => setApprovedByRole(e.target.value)} className="h-8 text-xs" />
                </Field>
              </div>
            )}

            {form === "a" && (
              <>
                <Field label={t("recipients")}>
                  <CheckboxGroup
                    options={A_RECIPIENTS}
                    labels={{
                      bnm: "BNM",
                      sponsor_emi: "Sponsor EMI",
                      safeguarding_bank: "Safeguarding bank",
                      settlement_bank_acquirer: "Settlement bank / acquirer",
                      payment_network: "Payment network",
                      other: "Other",
                    }}
                    selected={recipients}
                    onChange={setRecipients}
                  />
                </Field>
                <Field label={t("otherPartiesNotified")}>
                  <CheckboxGroup
                    options={A_OTHER_PARTIES}
                    labels={{ sponsor_emi: "Sponsor EMI", pdp_commissioner: "PDP Commissioner", nsrc: "PDRM / NSRC", mycert: "MyCERT", none_yet: "None yet" }}
                    selected={otherPartiesNotified}
                    onChange={setOtherPartiesNotified}
                  />
                </Field>
                <Field label={t("actionsRequested")}>
                  <Textarea value={actionsRequested} onChange={(e) => setActionsRequested(e.target.value)} rows={2} className="text-xs" />
                </Field>
              </>
            )}

            {form === "b" && (
              <>
                <Field label={t("executiveSummary")}>
                  <Textarea value={executiveSummary} onChange={(e) => setExecutiveSummary(e.target.value)} rows={4} className="text-xs" />
                </Field>
                <Field label={t("timeline")}>
                  <Textarea
                    value={timelineText}
                    onChange={(e) => setTimelineText(e.target.value)}
                    rows={4}
                    placeholder={t("timelinePlaceholder")}
                    className="text-xs"
                  />
                </Field>
                <Field label={t("reputationalImpact")}>
                  <Textarea value={reputationalRegulatoryImpact} onChange={(e) => setReputationalRegulatoryImpact(e.target.value)} rows={2} className="text-xs" />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("nextStepsContactName")}>
                    <Input value={nextStepsContactName} onChange={(e) => setNextStepsContactName(e.target.value)} className="h-8 text-xs" />
                  </Field>
                  <Field label={t("nextStepsContactRole")}>
                    <Input value={nextStepsContactRole} onChange={(e) => setNextStepsContactRole(e.target.value)} className="h-8 text-xs" />
                  </Field>
                </div>
              </>
            )}

            {form === "c" && (
              <>
                <Field label={t("reviewMeetingAttendees")}>
                  <Input value={reviewMeetingAttendees} onChange={(e) => setReviewMeetingAttendees(e.target.value)} className="h-8 text-xs" />
                </Field>
                <Field label={t("timeliness")}>
                  <div className="space-y-2">
                    {timelinessRows.map((row, i) => (
                      <div key={row.label} className="rounded-md border border-border p-2">
                        <p className="text-xs font-medium text-foreground">{row.label}</p>
                        <div className="mt-1 grid grid-cols-3 gap-1.5">
                          <Input
                            placeholder={t("required")}
                            value={row.required}
                            onChange={(e) => setTimelinessRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, required: e.target.value } : r)))}
                            className="h-7 text-[11px]"
                          />
                          <Input
                            placeholder={t("actual")}
                            value={row.actual}
                            onChange={(e) => setTimelinessRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, actual: e.target.value } : r)))}
                            className="h-7 text-[11px]"
                          />
                          <Input
                            placeholder={t("reasonIfMissed")}
                            value={row.reasonIfMissed}
                            onChange={(e) => setTimelinessRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, reasonIfMissed: e.target.value } : r)))}
                            className="h-7 text-[11px]"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </Field>
                <Field label={t("signOffCeo")}>
                  <Input value={signOffCeoName} onChange={(e) => setSignOffCeoName(e.target.value)} className="h-8 text-xs" />
                </Field>
              </>
            )}

            {form === "d" && (
              <>
                <Field label={t("updateType")}>
                  <div className="flex gap-4 text-xs">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={updateType === "status_update"} onChange={() => setUpdateType("status_update")} />
                      {t("statusUpdate")}
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" checked={updateType === "final_closure"} onChange={() => setUpdateType("final_closure")} />
                      {t("finalClosure")}
                    </label>
                  </div>
                </Field>
                <Field label={t("changesSinceLastUpdate")}>
                  <Textarea value={changesSinceLastUpdate} onChange={(e) => setChangesSinceLastUpdate(e.target.value)} rows={3} className="text-xs" />
                </Field>
                <Field label={t("completedSinceLastUpdate")}>
                  <Textarea value={completedSinceLastUpdate} onChange={(e) => setCompletedSinceLastUpdate(e.target.value)} rows={2} className="text-xs" />
                </Field>
                <Field label={t("inProgressNextSteps")}>
                  <Textarea value={inProgressNextSteps} onChange={(e) => setInProgressNextSteps(e.target.value)} rows={2} className="text-xs" />
                </Field>
                <Field label={t("requestsToRecipient")}>
                  <Textarea value={requestsToRecipient} onChange={(e) => setRequestsToRecipient(e.target.value)} rows={2} className="text-xs" />
                </Field>
              </>
            )}

            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={saveAsEvidence} onCheckedChange={(c) => setSaveAsEvidence(!!c)} />
              {t("saveAsEvidence")}
            </label>
          </div>
        )}

        <DialogFooter>
          {form && (
            <Button variant="ghost" onClick={() => setForm(null)} disabled={generating}>
              {t("back")}
            </Button>
          )}
          <Button variant="outline" onClick={close} disabled={generating}>
            {t("cancel")}
          </Button>
          {form && (
            <Button onClick={() => void generate()} disabled={generating || !preparedByName.trim() || !preparedByRole.trim()}>
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("generate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
