"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  ArrowUpCircle,
  Check,
  FileOutput,
  FileText,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Send,
  ShieldCheck,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse } from "@/hooks/use-account-sse";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useCapability } from "@/hooks/use-can";
import { useSignedMediaUrl } from "@/hooks/use-signed-media-url";
import { attachFileToIncident, removeIncidentAttachment } from "@/lib/incidents/attachment-actions";
import {
  INCIDENT_FLAGS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
} from "@/lib/incidents/constants";
import type { IncidentStatus } from "@/lib/incidents/constants";
import { incidentKey } from "@/lib/incidents/types";
import type {
  Incident,
  IncidentAction,
  IncidentActivity,
  IncidentAttachment,
  IncidentComment,
  IncidentNotificationSent,
  IncidentObligation,
} from "@/lib/incidents/types";
import { useStandardCatalogue } from "@/hooks/use-incident-standard";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { linkifySegments } from "@/lib/sembang/linkify";
import { EscalationChip, SeverityBadge, StatusLozenge } from "./incident-visuals";
import { GenerateDocumentDialog } from "./generate-document-dialog";
import { ObligationsPanel } from "./obligations-panel";
import { MessageLogPanel, roleLabel, type DeliveryRow } from "./message-log-panel";
import { DeleteButton, EvidenceGallery, isPicture } from "./evidence-gallery";
import { api } from "@/components/incidents/setup/api";
import { ClearancePanel } from "./clearance-panel";
import { ApprovalsPanel } from "./approvals-panel";
import { ReportAnswersPanel } from "./report-answers-panel";
import { FilingPanel } from "./filing-panel";

/** Plain text with any URL turned into a clickable link — same link
 *  definition Sembang uses (findLinkTokens), so a link pasted into an
 *  incident description or note behaves the same way everywhere. */
function LinkifiedText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {linkifySegments(text).map((seg, i) =>
        seg.type === "link" ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

/** One feed: what people wrote, and everything the system recorded (moves, files, steps done, notices sent). */
type TimelineItem =
  | { kind: "comment"; id: string; at: string; comment: IncidentComment }
  | { kind: "activity"; id: string; at: string; event: IncidentActivity }
  | { kind: "file"; id: string; at: string; file: IncidentAttachment }
  | { kind: "step"; id: string; at: string; step: IncidentObligation }
  | { kind: "mail"; id: string; at: string; mail: DeliveryRow; what: "sent" | "acknowledged" | "failed" }
  | { kind: "notice"; id: string; at: string; notice: IncidentNotificationSent }
  | { kind: "approval"; id: string; at: string; approval: ApprovalEntry; what: "asked" | "decided" }
  | { kind: "report"; id: string; at: string; report: FiledReportEntry };

/** The bits of an approval and of a filed report the timeline needs. */
interface ApprovalEntry {
  id: string;
  role_name: string;
  requested_at: string;
  decision: "approved" | "rejected" | null;
  decided_by: string | null;
  decided_at: string | null;
}
interface FiledReportEntry {
  id: string;
  version: number;
  generated_at: string;
  generated_by: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** An evidence file: the stored URL is signed (private bucket) before it is linked. */
function EvidenceLink({ attachment: a }: { attachment: IncidentAttachment }) {
  const { src } = useSignedMediaUrl(a.url);
  const row = (
    <>
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{a.filename}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(a.size_bytes)}</span>
    </>
  );
  const className = "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs";

  // No link yet (signing, or it could not be signed): show the row, inert.
  if (!src) {
    return (
      <span aria-disabled="true" className={`${className} opacity-60`}>
        {row}
      </span>
    );
  }

  return (
    <a href={src} target="_blank" rel="noreferrer" className={`${className} hover:bg-muted`}>
      {row}
    </a>
  );
}

export function IncidentDetail({ incidentId, onBack }: { incidentId: string; onBack: () => void }) {
  const t = useTranslations("Incidents.detail");
  const tRecord = useTranslations("IncidentPlatform.record");
  const tActivity = useTranslations("Incidents.detail.activity");
  const tNotif = useTranslations("Incidents.detail.notificationsSent");
  const tFlags = useTranslations("Incidents.flags");
  const tStatus = useTranslations("Incidents.common.status");
  const { user } = useAuth();
  const { members, nameOf, profileOf } = useAccountMembers();
  const canManage = useCapability("incidents.manage");
  const canMedical = useCapability("incidents.medical");
  const canExport = useCapability("incidents.export");

  const [incident, setIncident] = useState<Incident | null>(null);
  const [comments, setComments] = useState<IncidentComment[]>([]);
  const [activity, setActivity] = useState<IncidentActivity[]>([]);
  const [attachments, setAttachments] = useState<IncidentAttachment[]>([]);
  const [notificationsSent, setNotificationsSent] = useState<IncidentNotificationSent[]>([]);
  const [actions, setActions] = useState<IncidentAction[]>([]);
  const [obligations, setObligations] = useState<IncidentObligation[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [approvalList, setApprovalList] = useState<ApprovalEntry[]>([]);
  const [filedReports, setFiledReports] = useState<FiledReportEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/detail`);
    if (!res.ok) { setLoading(false); return; }
    const json = (await res.json()) as {
      incident: Incident;
      comments: IncidentComment[];
      activity: IncidentActivity[];
      attachments: IncidentAttachment[];
      notificationsSent: IncidentNotificationSent[];
      actions: IncidentAction[];
      obligations: IncidentObligation[];
    };
    setIncident(json.incident ?? null);
    setComments(json.comments ?? []);
    setActivity(json.activity ?? []);
    setAttachments(json.attachments ?? []);
    setNotificationsSent(json.notificationsSent ?? []);
    setActions(json.actions ?? []);
    setObligations(json.obligations ?? []);
    setLoading(false);
  }, [incidentId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The approvals asked for and answered, and the reports made for filing: they belong in the timeline too.
  useEffect(() => {
    let live = true;
    void api<{ approvals: ApprovalEntry[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/approvals`).then((res) => {
      if (live && res.ok) setApprovalList(res.data.approvals ?? []);
    });
    return () => {
      live = false;
    };
  }, [incidentId]);

  const loadFiledReports = useCallback(async () => {
    const res = await api<{ reports: FiledReportEntry[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/filed-reports`);
    if (res.ok) setFiledReports(res.data.reports ?? []);
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    if (canExport) void loadFiledReports();
  }, [canExport, loadFiledReports]);

  // The notices the rules sent (managers only): they belong in the timeline too.
  useEffect(() => {
    if (!canManage) return;
    let live = true;
    void api<{ deliveries: DeliveryRow[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/deliveries`).then((res) => {
      if (live && res.ok) setDeliveries(res.data.deliveries);
    });
    return () => {
      live = false;
    };
  }, [canManage, incidentId]);

  useAccountSse("incidents", (payload) => {
    if (payload.eventType !== "UPDATE") return;
    if ((payload.new as { id?: string }).id !== incidentId) return;
    setIncident((prev) => (prev ? { ...prev, ...(payload.new as Incident) } : prev));
  });
  useAccountSse("incident_comments", (payload) => {
    if (payload.eventType !== "INSERT") return;
    if ((payload.new as { incident_id?: string }).incident_id !== incidentId) return;
    setComments((prev) => (prev.some((c) => c.id === (payload.new as IncidentComment).id) ? prev : [...prev, payload.new as IncidentComment]));
  });
  useAccountSse("incident_activity", (payload) => {
    if (payload.eventType !== "INSERT") return;
    if ((payload.new as { incident_id?: string }).incident_id !== incidentId) return;
    setActivity((prev) => (prev.some((a) => a.id === (payload.new as IncidentActivity).id) ? prev : [...prev, payload.new as IncidentActivity]));
  });
  useAccountSse("incident_attachments", (payload) => {
    if (payload.eventType !== "INSERT") return;
    if ((payload.new as { incident_id?: string }).incident_id !== incidentId) return;
    setAttachments((prev) => (prev.some((a) => a.id === (payload.new as IncidentAttachment).id) ? prev : [...prev, payload.new as IncidentAttachment]));
  });
  useAccountSse("incident_obligations", (payload) => {
    if ((payload.new as { incident_id?: string }).incident_id !== incidentId) return;
    const row = payload.new as IncidentObligation;
    if (!row?.id) return;
    setObligations((prev) => (prev.some((o) => o.id === row.id) ? prev.map((o) => (o.id === row.id ? row : o)) : [...prev, row]));
  });

  // The categories and severity scale this incident was raised under — which
  // may no longer be the account's current template.
  const catalogue = useStandardCatalogue(incident?.standard_id);
  const typeOptions = catalogue
    ? catalogue.types.map((ty) => ({ code: ty.code, label: ty.name }))
    : INCIDENT_TYPES.map((ty) => ({ code: ty.code as string, label: ty.label }));
  const severityOptions = catalogue
    ? catalogue.severities.map((s) => ({ slug: s.slug, label: s.label }))
    : INCIDENT_SEVERITIES.map((s) => ({ slug: s as string, label: s as string }));
  // Forms A-D are the BNM RMiT notification set; other templates do not use them.
  const hasBnmForms = !incident?.standard_id || catalogue?.standard.slug === "bnm_rmit";

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map((c) => ({ kind: "comment" as const, id: c.id, at: c.created_at, comment: c })),
      ...activity.map((a) => ({ kind: "activity" as const, id: a.id, at: a.created_at, event: a })),
      ...attachments.map((f) => ({ kind: "file" as const, id: `f:${f.id}`, at: f.created_at, file: f })),
      ...obligations.filter((o) => o.status === "done" && o.completed_at).map((o) => ({ kind: "step" as const, id: `s:${o.id}`, at: o.completed_at as string, step: o })),
      ...deliveries.filter((d) => !d.is_test && d.sent_at).map((d) => ({ kind: "mail" as const, id: `m:${d.id}`, at: d.sent_at as string, mail: d, what: "sent" as const })),
      ...deliveries.filter((d) => !d.is_test && (d.status === "failed" || d.status === "skipped")).map((d) => ({ kind: "mail" as const, id: `x:${d.id}`, at: d.created_at, mail: d, what: "failed" as const })),
      ...deliveries.filter((d) => !d.is_test && d.acknowledged_at).map((d) => ({ kind: "mail" as const, id: `a:${d.id}`, at: d.acknowledged_at as string, mail: d, what: "acknowledged" as const })),
      ...notificationsSent.map((n) => ({ kind: "notice" as const, id: `n:${n.id}`, at: n.sent_at, notice: n })),
      ...approvalList.map((a) => ({ kind: "approval" as const, id: `p:${a.id}`, at: a.requested_at, approval: a, what: "asked" as const })),
      ...approvalList.filter((a) => a.decision && a.decided_at).map((a) => ({ kind: "approval" as const, id: `d:${a.id}`, at: a.decided_at as string, approval: a, what: "decided" as const })),
      ...filedReports.map((r) => ({ kind: "report" as const, id: `r:${r.id}`, at: r.generated_at, report: r })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments, activity, attachments, obligations, deliveries, notificationsSent, approvalList, filedReports]);

  const patch = async (fields: Partial<Incident>) => {
    if (!incident) return;
    const prev = incident;
    setIncident({ ...incident, ...fields });
    const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      setIncident(prev);
      // A move the school's requirements hold back comes with the reasons in plain words.
      const reason = res.status === 409 ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      toast.error(reason || t("updateFailed"));
    }
  };

  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/(?:^|\s)@(\w*)$/);
    setMentionQuery(match ? match[1] : null);
  };

  const insertMention = (userId: string, name: string) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const at = before.lastIndexOf("@");
    if (at === -1) return;
    setDraft(`${before.slice(0, at)}@${name} ${after}`);
    setMentions((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    setMentionQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const mentionMatches =
    mentionQuery === null ? [] : members.filter((m) => m.full_name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6);

  const postComment = async () => {
    if (!incident || !draft.trim()) return;
    setPosting(true);
    const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft.trim(), mentions }),
    });
    setPosting(false);
    if (!res.ok) {
      toast.error(t("commentFailed"));
      return;
    }
    // Show it straight away; the live channel may or may not deliver it as well (the same note is never added twice).
    const saved = (await res.json().catch(() => null)) as { comment?: IncidentComment } | null;
    if (saved?.comment) setComments((prev) => (prev.some((c) => c.id === saved.comment!.id) ? prev : [...prev, saved.comment!]));
    setDraft("");
    setMentions([]);
  };

  const handleFiles = async (files: File[]) => {
    if (!incident || !user) return;
    setUploading(true);
    let failed = 0;
    let reason = "";
    for (const file of files) {
      try {
        const saved = await attachFileToIncident(incident, file, user.id);
        setAttachments((prev) => (prev.some((a) => a.id === saved.id) ? prev : [...prev, saved]));
      } catch (err) {
        failed += 1;
        reason = reason || (err instanceof Error ? err.message : "");
      }
    }
    setUploading(false);
    if (failed > 0) toast.error(t("attachmentsFailed", { count: failed }), { description: reason || undefined, duration: 15000 });
  };

  /** Whoever added a file may delete it, and so may anyone who manages incidents. */
  const canDeleteFile = (a: IncidentAttachment) => canManage || (!!user && a.uploaded_by === user.id);
  const deleteFile = async (a: IncidentAttachment) => {
    const ok = await removeIncidentAttachment(a);
    if (!ok) {
      toast.error(t("deleteFailed"));
      return;
    }
    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
    toast.success(t("deleted"));
  };

  const [documentDialogOpen, setDocumentDialogOpen] = useState(false);

  const toggleFlag = async (flag: string) => {
    if (!incident) return;
    const next = incident.incident_flags.includes(flag)
      ? incident.incident_flags.filter((f) => f !== flag)
      : [...incident.incident_flags, flag];
    await patch({ incident_flags: next });
    // The database refreshes the checklist in the same statement; re-read it.
    const oblRes = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/obligations`);
    if (oblRes.ok) {
      const oblJson = (await oblRes.json()) as { obligations?: IncidentObligation[] };
      setObligations(oblJson.obligations ?? []);
    }
  };

  const [escalating, setEscalating] = useState(false);
  const escalate = async () => {
    if (!incident) return;
    setEscalating(true);
    try {
      const res = await fetch(`/api/incidents/${incident.id}/escalate`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(body?.error || t("escalateFailed"));
        return;
      }
      toast.success(t("escalated"));
    } finally {
      setEscalating(false);
    }
  };

  /** Who did it (when known) and what happened, for any item in the feed that is not a note. */
  const eventOf = (item: Exclude<TimelineItem, { kind: "comment" }>): { who: string | null; text: string } => {
    switch (item.kind) {
      case "activity":
        return { who: item.event.actor_id ? nameOf(item.event.actor_id) : null, text: activityText(item.event) };
      case "file":
        return { who: item.file.uploaded_by ? nameOf(item.file.uploaded_by) : null, text: tActivity(isPicture(item.file) ? "photoAdded" : "fileAdded", { name: item.file.filename }) };
      case "step":
        return { who: item.step.completed_by ? nameOf(item.step.completed_by) : null, text: tActivity("stepDone", { title: item.step.title }) };
      case "notice": {
        const party = tNotif(`party.${item.notice.recipient_party}`);
        return { who: item.notice.recorded_by ? nameOf(item.notice.recorded_by) : null, text: item.notice.reference ? tActivity("noticeLoggedRef", { party, reference: item.notice.reference }) : tActivity("noticeLogged", { party }) };
      }
      case "approval":
        return item.what === "asked"
          ? { who: null, text: tActivity("approvalAsked", { role: item.approval.role_name }) }
          : { who: item.approval.decided_by ? nameOf(item.approval.decided_by) : null, text: tActivity(item.approval.decision === "approved" ? "approvalApproved" : "approvalRejected", { role: item.approval.role_name }) };
      case "report":
        return { who: item.report.generated_by ? nameOf(item.report.generated_by) : null, text: tActivity("reportFiled", { version: item.report.version }) };
      case "mail":
        if (item.what === "failed") return { who: null, text: tActivity("mailFailed", { name: item.mail.recipient_name, role: roleLabel(item.mail.role_key), why: item.mail.last_error || item.mail.status }) };
        return { who: null, text: item.what === "sent" ? tActivity("mailSent", { name: item.mail.recipient_name, role: roleLabel(item.mail.role_key) }) : tActivity("mailAcknowledged", { name: item.mail.recipient_name }) };
    }
  };

  const activityText = (event: IncidentActivity): string => {
    switch (event.event_type) {
      case "created":
        return tActivity("created");
      case "status_changed":
        return tActivity("statusChanged", { from: event.from_value ?? "", to: event.to_value ?? "" });
      case "severity_changed":
        return tActivity("severityChanged", { from: event.from_value ?? "", to: event.to_value ?? "" });
      case "type_changed":
        return tActivity("typeChanged", { from: event.from_value ?? "", to: event.to_value ?? "" });
      case "lead_changed":
        return tActivity("leadChanged", { name: event.to_value ? nameOf(event.to_value) : t("unassigned") });
      case "escalated":
        return tActivity("escalatedEvent");
      case "closed":
        return tActivity("closedEvent");
      default:
        return event.event_type;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!incident) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          {t("back")}
        </Button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("back")}
      </button>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{incidentKey(incident)}</span>
              <StatusLozenge status={incident.status} />
              <EscalationChip level={incident.escalation_level} />
            </div>
            <h1 className="mt-1 text-xl font-bold text-foreground">{incident.title}</h1>
          </div>
          {canManage ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {incident.escalation_level < 3 && incident.status !== "closed" ? (
                <Button variant="outline" size="sm" onClick={() => void escalate()} disabled={escalating}>
                  {escalating ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
                  {t("escalateNow")}
                </Button>
              ) : null}
              {hasBnmForms ? (
                <Button variant="outline" size="sm" onClick={() => setDocumentDialogOpen(true)}>
                  <FileOutput className="size-3.5" />
                  {t("documents.generateDocument")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {incident.description ? (
          <LinkifiedText text={incident.description} className="mt-3 text-sm whitespace-pre-wrap text-foreground" />
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Field label={t("fieldSeverity")}>
            {canManage ? (
              <Select value={incident.severity} onValueChange={(v) => void patch({ severity: v ?? incident.severity })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {severityOptions.map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {s.slug === s.label ? s.slug : `${s.slug} · ${s.label}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <SeverityBadge severity={incident.severity} standardId={incident.standard_id} />
            )}
          </Field>
          <Field label={t("fieldStatus")}>
            {canManage ? (
              <Select value={incident.status} onValueChange={(v) => void patch({ status: v as IncidentStatus })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue>{tStatus(incident.status)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {tStatus(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <StatusLozenge status={incident.status} />
            )}
          </Field>
          <Field label={t("fieldType")}>
            {canManage ? (
              <Select value={incident.incident_type} onValueChange={(v) => void patch({ incident_type: v ?? incident.incident_type })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue>{typeOptions.find((ty) => ty.code === incident.incident_type)?.label ?? incident.incident_type}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {typeOptions.map((ty) => (
                    <SelectItem key={ty.code} value={ty.code}>
                      {hasBnmForms ? `${ty.code} — ${ty.label}` : ty.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs text-muted-foreground">{typeOptions.find((ty) => ty.code === incident.incident_type)?.label ?? incident.incident_type}</span>
            )}
          </Field>
          <Field label={t("fieldLead")}>
            {canManage ? (
              <Select
                value={incident.incident_lead_id ?? "__none__"}
                onValueChange={(v) => void patch({ incident_lead_id: v === "__none__" ? null : v })}
              >
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue>{incident.incident_lead_id ? nameOf(incident.incident_lead_id) : t("unassigned")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("unassigned")}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs text-muted-foreground">
                {incident.incident_lead_id ? nameOf(incident.incident_lead_id) : t("unassigned")}
              </span>
            )}
          </Field>
        </div>

        {canManage || incident.incident_flags.length > 0 ? (
          <details className="group mt-4" open={!canManage}>
            <summary className="mb-1.5 cursor-pointer list-none text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase marker:hidden">
              {t("involves")} ({incident.incident_flags.length})
              <span className="ml-1 text-primary group-open:hidden">▸</span>
            </summary>
            <div className="flex flex-wrap gap-1.5">
              {(canManage ? INCIDENT_FLAGS : INCIDENT_FLAGS.filter((f) => incident.incident_flags.includes(f))).map((flag) => {
                const on = incident.incident_flags.includes(flag);
                return (
                  <button
                    key={flag}
                    type="button"
                    disabled={!canManage}
                    aria-pressed={on}
                    onClick={() => void toggleFlag(flag)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                      on ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
                      !canManage && "cursor-default",
                    )}
                  >
                    {tFlags(flag)}
                  </button>
                );
              })}
            </div>
          </details>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("timelineTitle")}</h2>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t("timelineHelp")}</p>
          <div className="flex flex-col gap-3">
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("timelineEmpty")}</p>
            ) : (
              timeline.map((item) =>
                item.kind === "comment" ? (
                  <div key={item.id} className="flex items-start gap-2.5">
                    <PersonAvatar name={item.comment.author_id ? nameOf(item.comment.author_id) : null} avatarUrl={profileOf(item.comment.author_id ?? undefined)?.avatar_url} />
                    <div className="min-w-0 flex-1 rounded-lg bg-muted/50 px-3 py-2">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{item.comment.author_id ? nameOf(item.comment.author_id) : t("unknown")}</span>
                        <span title={format(new Date(item.at), "PPpp")}>{formatDistanceToNow(new Date(item.at), { addSuffix: true })}</span>
                      </div>
                      <LinkifiedText text={item.comment.body} className="mt-0.5 text-[13px] whitespace-pre-wrap text-foreground" />
                    </div>
                  </div>
                ) : (
                  <div key={item.id} className="flex items-center gap-2.5 pl-1 text-[12.5px] text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full bg-border" />
                    <span className="min-w-0">
                      {eventOf(item).who ? <span className="font-medium text-foreground">{eventOf(item).who} · </span> : null}
                      {eventOf(item).text}
                    </span>
                    <span className="shrink-0 text-muted-foreground/70" title={format(new Date(item.at), "PPpp")}>
                      · {formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                    </span>
                  </div>
                ),
              )
            )}
          </div>

          <div className="relative mt-4">
            {mentionQuery !== null && mentionMatches.length > 0 ? (
              <div className="absolute bottom-full left-0 z-20 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-md">
                {mentionMatches.map((m) => (
                  <button
                    key={m.user_id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertMention(m.user_id, m.full_name);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <PersonAvatar name={m.full_name} avatarUrl={m.avatar_url} size="sm" />
                    {m.full_name}
                  </button>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              placeholder={t("composerPlaceholder")}
              rows={3}
              className="resize-y bg-muted text-[13px]"
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
                {t("attachFiles")}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void handleFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <Button size="sm" onClick={() => void postComment()} disabled={posting || !draft.trim()}>
                {posting ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                {t("postComment")}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <Paperclip className="size-3.5" />
              {t("evidenceTitle")}
            </h3>
            {attachments.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("evidenceEmpty")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                <EvidenceGallery pictures={attachments.filter(isPicture)} canDelete={canDeleteFile} onDelete={deleteFile} />
                <ul className="flex flex-col gap-1.5">
                  {attachments.filter((a) => !isPicture(a)).map((a) => (
                    <li key={a.id} className="flex items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <EvidenceLink attachment={a} />
                      </div>
                      {canDeleteFile(a) ? <DeleteButton label={t("deleteFile")} filename={a.filename} onDelete={() => deleteFile(a)} /> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline"
            >
              <Upload className="size-3" />
              {t("uploadEvidence")}
            </button>
          </div>

          <ObligationsPanel
            rows={obligations}
            canManage={canManage}
            onChanged={(row) => setObligations((prev) => prev.map((o) => (o.id === row.id ? row : o)))}
          />

          {canExport ? (
            <Link href={`/incidents/${incident.id}/record`} className="rounded-xl border border-border bg-card px-4 py-3 text-xs font-medium text-primary hover:bg-muted/40">
              {tRecord("open")}
            </Link>
          ) : null}

          {canExport && incident.status === "closed" ? <FilingPanel incidentId={incident.id} onChanged={() => void loadFiledReports()} /> : null}

          {canManage ? <ReportAnswersPanel incidentId={incident.id} /> : null}

          <ApprovalsPanel incidentId={incident.id} />

          {canMedical ? <ClearancePanel incidentId={incident.id} /> : null}

          {canManage ? <MessageLogPanel incidentId={incident.id} canManage={canManage} /> : null}

          <details className="group rounded-xl border border-border bg-card" open={actions.length + notificationsSent.length > 0}>
            <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase marker:hidden">
              {t("actions.title")}{canManage ? ` · ${t("notificationsSent.title")}` : ""} ({actions.length + (canManage ? notificationsSent.length : 0)})
              <span className="ml-1 text-primary group-open:hidden">▸</span>
            </summary>
            <div className="flex flex-col gap-4 p-2 pt-0">
              <ActionsPanel
                incidentId={incident.id}
                rows={actions}
                canManage={canManage}
                onAdded={(row) => setActions((prev) => [...prev, row])}
                onChanged={(row) => setActions((prev) => prev.map((a) => (a.id === row.id ? row : a)))}
              />

              {canManage ? (
                <NotificationsSentPanel
                  incidentId={incident.id}
                  rows={notificationsSent}
                  onAdded={(row) => setNotificationsSent((prev) => [row, ...prev])}
                />
              ) : null}
            </div>
          </details>
        </div>
      </div>

      {canManage && hasBnmForms ? (
        <GenerateDocumentDialog
          open={documentDialogOpen}
          onOpenChange={setDocumentDialogOpen}
          incident={incident}
          incidentLeadName={incident.incident_lead_id ? nameOf(incident.incident_lead_id) : null}
          onAttached={() => void load()}
        />
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

/** PIR (post-incident-review) corrective/preventive actions, Form C §6.
 *  Visible to anyone who can see the incident (RLS SELECT is reporter/
 *  watcher/manage); adding one or toggling done needs incidents.manage. */
function ActionsPanel({
  incidentId,
  rows,
  canManage,
  onAdded,
  onChanged,
}: {
  incidentId: string;
  rows: IncidentAction[];
  canManage: boolean;
  onAdded: (row: IncidentAction) => void;
  onChanged: (row: IncidentAction) => void;
}) {
  const t = useTranslations("Incidents.detail.actions");
  const { user } = useAuth();
  const { members, nameOf } = useAccountMembers();
  const [adding, setAdding] = useState(false);
  const [description, setDescription] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!description.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description.trim(), owner_id: ownerId, due_date: dueDate || null }),
    });
    const json = (await res.json().catch(() => null)) as { action?: IncidentAction } | null;
    setBusy(false);
    if (!res.ok || !json?.action) {
      toast.error(t("addFailed"));
      return;
    }
    onAdded(json.action);
    setAdding(false);
    setDescription("");
    setOwnerId(null);
    setDueDate("");
  };

  const toggleDone = async (row: IncidentAction) => {
    const nextStatus = row.status === "done" ? "open" : "done";
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/actions/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus, closed_at: nextStatus === "done" ? new Date().toISOString() : null }),
    });
    const json = (await res.json().catch(() => null)) as { action?: IncidentAction } | null;
    if (!res.ok || !json?.action) {
      toast.error(t("updateFailed"));
      return;
    }
    onChanged(json.action);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <ListChecks className="size-3.5" />
        {t("title")}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-xs">
              <button
                type="button"
                disabled={!canManage}
                onClick={() => void toggleDone(a)}
                aria-label={a.status === "done" ? t("markOpen") : t("markDone")}
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                  a.status === "done" ? "border-emerald-500 bg-emerald-500 text-white" : "border-border"
                } ${canManage ? "cursor-pointer" : "cursor-default"}`}
              >
                {a.status === "done" ? <Check className="size-3" /> : null}
              </button>
              <div className="min-w-0 flex-1">
                <p className={a.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}>{a.description}</p>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {a.owner_id ? nameOf(a.owner_id) : t("unassigned")}
                  {a.due_date ? ` · ${t("due", { date: format(new Date(a.due_date), "d MMM") })}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        adding ? (
          <div className="mt-2 space-y-2">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={2}
              className="bg-muted text-xs"
            />
            <div className="flex gap-2">
              <Select value={ownerId ?? "__none__"} onValueChange={(v) => setOwnerId(v === "__none__" ? null : v)}>
                <SelectTrigger className="h-8 flex-1 bg-muted text-xs">
                  <SelectValue>{ownerId ? nameOf(ownerId) : t("unassigned")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("unassigned")}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <div className="flex justify-end gap-1.5">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAdding(false)}>
                {t("cancel")}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => void submit()} disabled={busy || !description.trim()}>
                {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                {t("save")}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline"
          >
            <Plus className="size-3" />
            {t("addAction")}
          </button>
        )
      ) : null}
    </div>
  );
}

const RECIPIENT_PARTIES = [
  "bnm",
  "sponsor_emi",
  "partner",
  "pdp_commissioner",
  "data_subjects",
  "police",
  "other",
  "safeguarding_bank",
  "settlement_bank_acquirer",
  "payment_network",
  "nsrc",
  "mycert",
  "parent_guardian",
  "school_leadership",
  "ministry_education",
  "insurer",
] as const;

function NotificationsSentPanel({
  incidentId,
  rows,
  onAdded,
}: {
  incidentId: string;
  rows: IncidentNotificationSent[];
  onAdded: (row: IncidentNotificationSent) => void;
}) {
  const t = useTranslations("Incidents.detail.notificationsSent");
  const { user } = useAuth();
  const [adding, setAdding] = useState(false);
  const [party, setParty] = useState<(typeof RECIPIENT_PARTIES)[number]>("bnm");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_party: party, reference: reference.trim() || null }),
    });
    const json = (await res.json().catch(() => null)) as { notification?: IncidentNotificationSent } | null;
    setBusy(false);
    if (!res.ok || !json?.notification) {
      toast.error(t("addFailed"));
      return;
    }
    onAdded(json.notification);
    setAdding(false);
    setReference("");
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <ShieldCheck className="size-3.5" />
        {t("title")}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-xs">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{t(`party.${r.recipient_party}`)}</span>
              <span className="text-muted-foreground">{format(new Date(r.sent_at), "d MMM, HH:mm")}</span>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-2 space-y-2">
          <Select value={party} onValueChange={(v) => setParty(v as (typeof RECIPIENT_PARTIES)[number])}>
            <SelectTrigger className="h-8 w-full bg-muted text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RECIPIENT_PARTIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`party.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t("referencePlaceholder")}
            className="h-8 text-xs"
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAdding(false)}>
              {t("cancel")}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("save")}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline"
        >
          <Plus className="size-3" />
          {t("log")}
        </button>
      )}
    </div>
  );
}
