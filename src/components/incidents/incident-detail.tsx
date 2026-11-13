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
  Copy,
  FileOutput,
  FileText,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Send,
  Share2,
  ShieldCheck,
  Upload,
  FileDown,
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
import { IncidentWording } from "./incident-wording";
import { CloseDialog } from "./close-dialog";
import { NOTE_KINDS, conclusionsOf, kindOf, type NoteKind } from "@/lib/incidents/platform/note-kinds";

/** How each kind of note looks in the Timeline: the box, and the small badge beside the author. */
const KIND_STYLE: Record<NoteKind | "none", { box: string; badge: string }> = {
  none: { box: "bg-muted/50", badge: "" },
  investigation: { box: "bg-sky-500/10 ring-1 ring-sky-500/40", badge: "bg-sky-500/20 text-sky-700 dark:text-sky-300" },
  finding: { box: "bg-amber-500/10 ring-1 ring-amber-500/40", badge: "bg-amber-500/20 text-amber-700 dark:text-amber-300" },
  closing: { box: "bg-emerald-500/10 ring-1 ring-emerald-500/40", badge: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300" },
};
import { toldAtEscalation } from "@/lib/incidents/platform/escalation-told";
import { DeleteButton, EvidenceGallery, isPicture } from "./evidence-gallery";
import { InfoTip } from "./info-tip";
import { useStatusOptions } from "@/hooks/use-status-options";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TriageDialog, type TriageResult } from "./triage-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { severityText } from "@/lib/incidents/severity-display";
import { api } from "@/components/incidents/setup/api";
import { ClearancePanel } from "./clearance-panel";
import { ApprovalsPanel } from "./approvals-panel";
import { ReportAnswersPanel } from "./report-answers-panel";
import { FilingPanel } from "./filing-panel";

function ShareLinkButton({ incidentId }: { incidentId: string }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function share() {
    setBusy(true);
    const res = await api<{ url: string }>(`/api/incidents/${encodeURIComponent(incidentId)}/share-link`, "POST");
    setBusy(false);
    if (!res.ok) { toast.error(res.error); return; }
    try {
      await navigator.clipboard.writeText(res.data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      toast.success("Read-only link copied. Valid for 7 days.");
    } catch {
      toast.info(`Link: ${res.data.url}`);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void share()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-xs font-medium text-primary hover:bg-muted/40 disabled:opacity-50"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : copied ? <Copy size={12} className="text-green-600" /> : <Share2 size={12} />}
      Share read-only link
    </button>
  );
}

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
  | { kind: "report"; id: string; at: string; report: FiledReportEntry }
  | { kind: "action"; id: string; at: string; action: IncidentAction; what: "added" | "done" }
  | { kind: "escalation"; id: string; at: string; event: EscalationEntry }
  | { kind: "evidence"; id: string; at: string; entry: EvidenceEntry };

/** From the audit endpoint: every escalation with its reason, and the chain-of-custody lines for files. */
interface EscalationEntry {
  id: string;
  from_level: number;
  to_level: number;
  reason: "manual" | "auto_timeout" | "rule";
  triggered_by: string | null;
  created_at: string;
}
interface EvidenceEntry {
  id: string;
  description: string;
  collected_by: string | null;
  collected_at: string;
  file_hash: string | null;
}

/** What only the Audit log shows: the mechanical record (emails going out, file custody, removals). The Timeline keeps the story. */
const isAuditOnly = (item: TimelineItem): boolean =>
  item.kind === "evidence" || (item.kind === "mail" && item.what !== "failed") || (item.kind === "activity" && item.event.event_type === "file_deleted");

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
  const tTips = useTranslations("Incidents.detail.tips");
  const { options: statusOptions, label: statusLabel } = useStatusOptions();
  const [pendingStatusKey, setPendingStatusKey] = useState<string | null>(null);
  const tTriage = useTranslations("Incidents.detail.triage");
  const tFlags = useTranslations("Incidents.flags");
  const tStatus = useTranslations("Incidents.common.status");
  const { user, accountRole } = useAuth();
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
  const [escalations, setEscalations] = useState<EscalationEntry[]>([]);
  const [custody, setCustody] = useState<EvidenceEntry[]>([]);
  const [view, setView] = useState<"timeline" | "audit" | "summary">("timeline");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [triageOpen, setTriageOpen] = useState(false);
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
    setSummaryDraft(json.incident?.root_cause ?? "");
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
  const loadApprovals = useCallback(async () => {
    const res = await api<{ approvals: ApprovalEntry[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/approvals`);
    if (res.ok) setApprovalList(res.data.approvals ?? []);
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void loadApprovals();
  }, [loadApprovals]);

  const loadFiledReports = useCallback(async () => {
    const res = await api<{ reports: FiledReportEntry[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/filed-reports`);
    if (res.ok) setFiledReports(res.data.reports ?? []);
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    if (canExport) void loadFiledReports();
  }, [canExport, loadFiledReports]);

  // Escalations (with their reason) and the file custody lines (managers only).
  const loadAudit = useCallback(async () => {
    const res = await api<{ evidence: EvidenceEntry[]; escalations: EscalationEntry[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/audit`);
    if (res.ok) {
      setEscalations(res.data.escalations ?? []);
      setCustody(res.data.evidence ?? []);
    }
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    if (canManage) void loadAudit();
  }, [canManage, loadAudit]);

  // The notices the rules sent (managers only): they belong in the timeline too.
  const loadDeliveries = useCallback(async () => {
    const res = await api<{ deliveries: DeliveryRow[] }>(`/api/incidents/${encodeURIComponent(incidentId)}/deliveries`);
    if (res.ok) setDeliveries(res.data.deliveries);
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    if (canManage) void loadDeliveries();
  }, [canManage, loadDeliveries]);

  // Keep the page current without a reload: every 20 seconds, while the page is in view, re-read what other people (or the system) may have changed:
  // approvals, notices, escalations, files, filed reports, notes and the incident itself.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void load();
      void loadApprovals();
      if (canManage) {
        void loadDeliveries();
        void loadAudit();
      }
      if (canExport) void loadFiledReports();
    }, 20_000);
    return () => clearInterval(timer);
  }, [load, loadApprovals, loadDeliveries, loadAudit, loadFiledReports, canManage, canExport]);

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
      ...actions.map((a) => ({ kind: "action" as const, id: `x:${a.id}`, at: a.created_at, action: a, what: "added" as const })),
      ...actions.filter((a) => a.status === "done" && a.closed_at).map((a) => ({ kind: "action" as const, id: `y:${a.id}`, at: a.closed_at as string, action: a, what: "done" as const })),
      ...escalations.map((e) => ({ kind: "escalation" as const, id: `e:${e.id}`, at: e.created_at, event: e })),
      ...custody.map((c) => ({ kind: "evidence" as const, id: `c:${c.id}`, at: c.collected_at, entry: c })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments, activity, attachments, obligations, deliveries, notificationsSent, approvalList, filedReports, actions, escalations, custody]);
  // A filter on the kind of note (all, investigation notes, findings, closing notes), offered once any note has a kind.
  const [noteFilter, setNoteFilter] = useState<NoteKind | "all">("all");
  const anyKinds = comments.some((c) => kindOf(c) !== null);
  const baseShown = view === "timeline" ? timeline.filter((i) => !isAuditOnly(i)) : timeline;
  const shown = noteFilter === "all" || !anyKinds ? baseShown : baseShown.filter((i) => i.kind === "comment" && kindOf(i.comment) === noteFilter);

  const patch = async (fields: Partial<Incident>): Promise<boolean> => {
    if (!incident) return false;
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
      return false;
    }
    return true;
  };

  /** A note can be marked as an investigation note, a finding or a closing note, so it stands out (and is printed that way in the report for filing). */
  const setKind = async (c: IncidentComment, kind: NoteKind | null) => {
    if (!incident) return;
    const before = { kind: c.kind ?? null, is_finding: c.is_finding };
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, kind, is_finding: kind === "finding" } : x)));
    const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/comments/${encodeURIComponent(c.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) {
      setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...before } : x)));
      toast.error(t("findingFailed"));
    }
  };

  /** Amend the title and description. The server checks them and the database writes the old and new wording to the Audit log (with a reason once closed). */
  const amendWording = async (fields: { title: string; description: string }, reason: string): Promise<boolean> => {
    if (!incident) return false;
    const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: fields.title, description: fields.description, ...(reason ? { amend_reason: reason } : {}) }),
    });
    if (!res.ok) {
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      toast.error(why || t("editFailed"));
      return false;
    }
    await load();
    return true;
  };

  /** Correct what a note says (a finding, say). The earlier wording stays in the note's history and in the Audit log. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const saveNote = async (c: IncidentComment) => {
    if (!incident || editBusy) return;
    const text = editText.trim();
    if (!text) return;
    if (text === c.body) return setEditingId(null);
    setEditBusy(true);
    const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/comments/${encodeURIComponent(c.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    setEditBusy(false);
    if (!res.ok) {
      const reason = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      return void toast.error(reason || t("editFailed"));
    }
    const { comment } = (await res.json()) as { comment?: Partial<IncidentComment> };
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...(comment ?? { body: text, edited_at: new Date().toISOString() }) } : x)));
    setEditingId(null);
  };

  // Voiding (raised by mistake) and deleting for good (Owner only, a voided incident, typing the reference).
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const isOwner = accountRole === "owner";
  const voidIncident = async () => {
    if (!incident) return;
    setVoidBusy(true);
    const res = await api(`/api/incidents/${encodeURIComponent(incident.id)}/void`, "POST", { reason: voidReason });
    setVoidBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setVoidOpen(false);
    setVoidReason("");
    toast.success(t("voided"));
    await Promise.all([load(), loadAudit()]);
  };
  const restoreIncident = async () => {
    if (!incident) return;
    const res = await api(`/api/incidents/${encodeURIComponent(incident.id)}/void`, "DELETE");
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("restored"));
    await Promise.all([load(), loadAudit()]);
  };
  const deleteIncident = async () => {
    if (!incident) return;
    setVoidBusy(true);
    const res = await api(`/api/incidents/${encodeURIComponent(incident.id)}`, "DELETE", { confirm: deleteConfirm });
    setVoidBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(t("deletedForGood"));
    setDeleteOpen(false);
    onBack();
  };

  /** Moving a reported incident to Triaged asks for the three things triage is for. */
  const changeStatus = (key: string) => {
    if (!incident) return;
    const chosen = statusOptions.find((o) => o.key === key);
    const base = (chosen?.base ?? key) as IncidentStatus;
    const statusKey = chosen && !chosen.builtin ? chosen.key : null;
    if (base === "triaged" && incident.status === "reported") {
      setPendingStatusKey(statusKey);
      setTriageOpen(true);
    } else if (base === "closed" && incident.status !== "closed") {
      // Closing asks how it ended: a closing note (optional unless the school requires one).
      setPendingStatusKey(statusKey);
      setCloseOpen(true);
    } else void patch({ status: base, status_key: statusKey });
  };
  const [closeOpen, setCloseOpen] = useState(false);
  const closeNotePosted = useRef(false);
  const confirmClose = async (note: string) => {
    if (!incident) return;
    // The note goes first so a school that requires one finds it there when the move is checked. If the move is then refused, the note is not written twice.
    if (note && !closeNotePosted.current) {
      const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: note, mentions: [], kind: "closing" }),
      });
      if (!res.ok) return void toast.error(t("close.noteFailed"));
      const saved = (await res.json().catch(() => null)) as { comment?: IncidentComment } | null;
      if (saved?.comment) setComments((prev) => (prev.some((c) => c.id === saved.comment!.id) ? prev : [...prev, saved.comment!]));
      closeNotePosted.current = true;
    }
    const ok = await patch({ status: "closed", status_key: pendingStatusKey });
    if (!ok) return;
    closeNotePosted.current = false;
    setCloseOpen(false);
  };
  const confirmTriage = async (r: TriageResult) => {
    if (!incident) return;
    const ok = await patch({ status: "triaged", status_key: pendingStatusKey, severity: r.severity, incident_lead_id: r.leadId });
    if (!ok) return;
    if (r.note) {
      const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: tTriage("notePrefix", { text: r.note }), mentions: [] }),
      });
      const saved = (await res.json().catch(() => null)) as { comment?: IncidentComment } | null;
      if (saved?.comment) setComments((prev) => (prev.some((c) => c.id === saved.comment!.id) ? prev : [...prev, saved.comment!]));
    }
    setTriageOpen(false);
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
  const escalate = async (level?: 2 | 3) => {
    if (!incident) return;
    setEscalating(true);
    try {
      const res = await fetch(`/api/incidents/${incident.id}/escalate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(level ? { level } : {}) });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(body?.error || t("escalateFailed"));
        return;
      }
      toast.success(t("escalated"));
      await Promise.all([load(), loadAudit()]);
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
      case "action": {
        const a = item.action;
        if (item.what === "done") return { who: null, text: tActivity("actionDone", { description: a.description }) };
        const bits = [a.owner_id ? `${tActivity("owner")} ${nameOf(a.owner_id)}` : null, a.due_date ? `${tActivity("due")} ${a.due_date}` : null].filter(Boolean);
        return { who: a.created_by ? nameOf(a.created_by) : null, text: tActivity("actionAdded", { description: a.description, detail: bits.length ? ` (${bits.join(", ")})` : "" }) };
      }
      case "escalation": {
        const how = item.event.reason === "manual" ? "escalateHowManual" : item.event.reason === "rule" ? "escalateHowRule" : "escalateHowTimer";
        // Who the escalation rules told, so the line answers "who knows about this now?" without opening the message log.
        const nextAt = escalations.map((x) => x.created_at).filter((at) => at > item.event.created_at).sort()[0] ?? null;
        const told = toldAtEscalation(item.event.created_at, nextAt, deliveries);
        // Only people who manage incidents have the message log loaded; for anyone else the line stays as it was rather than claim nobody was told.
        const toldText = !canManage ? "" : told.length > 0
          ? ` · ${tActivity("escalatedTold", { people: told.map((p) => `${p.name} (${roleLabel(p.roleKey)})${p.failed ? ` ${tActivity("escalatedNotSent")}` : ""}`).join(", ") })}`
          : ` · ${tActivity("escalatedNobody")}`;
        return { who: item.event.triggered_by ? nameOf(item.event.triggered_by) : null, text: `${tActivity("escalatedTo", { level: item.event.to_level, how: tActivity(how) })}${toldText}` };
      }
      case "evidence":
        return { who: item.entry.collected_by ? nameOf(item.entry.collected_by) : null, text: `${tActivity("custody", { description: item.entry.description })}${item.entry.file_hash ? ` · SHA-256 ${item.entry.file_hash.slice(0, 12)}…` : ""}` };
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
      case "root_cause_changed":
        return tActivity("rootCauseChanged", { text: event.to_value ? event.to_value : "–" });
      case "file_deleted":
        return tActivity("fileDeleted", { name: event.from_value ?? "" });
      case "voided":
        return tActivity("voidedEvent", { reason: event.to_value ?? "" });
      case "restored":
        return tActivity("restoredEvent");
      case "title_changed":
        return `${tActivity("titleChanged", { from: event.from_value ?? "", to: event.to_value ?? "" })}${event.reason ? ` · ${tActivity("amendReason", { reason: event.reason })}` : ""}`;
      case "description_changed": {
        const cut = (s: string | null) => ((s ?? "").length > 300 ? `${(s ?? "").slice(0, 300)}…` : (s ?? ""));
        const base = view === "audit" ? tActivity("descriptionChangedFull", { from: cut(event.from_value) || "–", to: cut(event.to_value) || "–" }) : tActivity("descriptionChanged");
        return `${base}${event.reason ? ` · ${tActivity("amendReason", { reason: event.reason })}` : ""}`;
      }
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
              <StatusLozenge status={incident.status} statusKey={incident.status_key} />
              <EscalationChip level={incident.escalation_level} />
              {incident.escalation_level > 1 ? <InfoTip text={tTips("level")} /> : null}
            </div>
            <IncidentWording
              title={incident.title}
              description={incident.description ?? null}
              descriptionNode={incident.description ? <LinkifiedText text={incident.description} className="text-sm whitespace-pre-wrap text-foreground" /> : null}
              closed={incident.status === "closed"}
              canEdit={canManage && !incident.voided_at}
              onSave={amendWording}
            />
          </div>
          {canManage ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {incident.escalation_level < 3 && incident.status !== "closed" ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={escalating} />}>
                      {escalating ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
                      {t("escalateNow")}
                      <ChevronDown className="size-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {incident.escalation_level < 2 ? <DropdownMenuItem onClick={() => void escalate(2)}>{t("escalateTo", { level: 2 })}</DropdownMenuItem> : null}
                      <DropdownMenuItem onClick={() => void escalate(3)}>{t("escalateTo", { level: 3 })}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <InfoTip text={tTips("escalate")} />
                </>
              ) : null}
              {!incident.voided_at ? (
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setVoidOpen(true)}>
                  {t("void")}
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

        {incident.voided_at ? (
          <div role="status" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
            <div className="min-w-0 flex-1">
              <b>{t("voidedBanner")}</b> {incident.void_reason ? `${t("voidedBecause")} ${incident.void_reason}` : ""}
            </div>
            {canManage ? <Button variant="outline" size="sm" onClick={() => void restoreIncident()}>{t("restore")}</Button> : null}
            {isOwner ? <Button size="sm" className="bg-destructive text-white hover:bg-destructive/90" onClick={() => setDeleteOpen(true)}>{t("deleteForGood")}</Button> : null}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Field label={t("fieldSeverity")} tip={tTips("severity")}>
            {canManage ? (
              <Select value={incident.severity} onValueChange={(v) => void patch({ severity: v ?? incident.severity })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue>{severityText(incident.severity, severityOptions)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {severityOptions.map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {severityText(s.slug, severityOptions)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <SeverityBadge severity={incident.severity} standardId={incident.standard_id} />
            )}
          </Field>
          <Field label={t("fieldStatus")} tip={tTips("status")}>
            {canManage ? (
              <Select value={incident.status_key && statusOptions.some((o) => o.key === incident.status_key) ? incident.status_key : incident.status} onValueChange={(v) => changeStatus(v ?? incident.status)}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue>{statusLabel(incident.status, incident.status_key)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(statusOptions.length > 0 ? statusOptions.filter((o) => o.active || o.key === incident.status_key) : INCIDENT_STATUSES.map((s) => ({ key: s as string, label: null as string | null, base: s as string, builtin: true, active: true }))).map((o) => (
                    <SelectItem key={o.key} value={o.key}>
                      {o.builtin ? (o.label ?? tStatus(o.base as IncidentStatus)) : `· ${o.label}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <StatusLozenge status={incident.status} statusKey={incident.status_key} />
            )}
          </Field>
          <Field label={t("fieldType")} tip={tTips("type")}>
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
          <Field label={t("fieldLead")} tip={tTips("lead")}>
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
              <InfoTip text={tTips("involves")} className="ml-1" />
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

      {/* Fluid: the Timeline takes what is left, the side panels grow a little with the screen, and on a wide screen they sit in two columns of their own. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_clamp(280px,28vw,380px)] 2xl:grid-cols-[minmax(0,1fr)_clamp(580px,40vw,780px)]">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            {canManage ? (
              <div className="flex rounded-lg border border-border bg-muted/40 p-0.5" role="tablist" aria-label={t("timelineTitle")}>
                {(["timeline", "summary", "audit"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={view === k}
                    onClick={() => setView(k)}
                    className={cn("rounded-md px-3 py-1 text-xs font-medium transition-colors", view === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    {k === "timeline" ? t("timelineTitle") : k === "summary" ? t("summaryTab") : t("auditTitle")}
                  </button>
                ))}
              </div>
            ) : (
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("timelineTitle")}</h2>
            )}
            <InfoTip text={view === "timeline" ? tTips("timeline") : view === "summary" ? t("summaryHelp") : tTips("audit")} />
          </div>
          {view !== "summary" ? <p className="mt-2 mb-3 text-xs text-muted-foreground">{view === "timeline" ? t("timelineHelp") : t("auditHelp")}</p> : null}
          {view === "summary" ? (
            <div className="mt-3 flex flex-col gap-3">
              <Textarea
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                placeholder={t("summaryPlaceholder")}
                rows={8}
                disabled={!canManage}
                className="resize-y bg-muted text-[13px]"
              />
              {canManage ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={summaryBusy}
                    onClick={async () => {
                      setSummaryBusy(true);
                      try {
                        const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/ai-summary`, { method: "POST" });
                        if (res.ok) {
                          const json = (await res.json()) as { summary: string };
                          setSummaryDraft(json.summary);
                        } else {
                          toast.error("Could not generate summary.");
                        }
                      } finally {
                        setSummaryBusy(false);
                      }
                    }}
                  >
                    {summaryBusy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
                    {summaryBusy ? t("summaryGenerating") : t("summaryGenerate")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={summaryBusy || summaryDraft.trim() === (incident?.root_cause ?? "").trim()}
                    onClick={() => void patch({ root_cause: summaryDraft.trim() || null })}
                  >
                    {t("summarySave")}
                  </Button>
                </div>
              ) : null}
              {comments.length > 0 ? (
                <div className="mt-2 border-t border-border pt-3">
                  <p className="mb-2 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{t("filterAll")} {t("kind.investigation")}s & {t("kind.finding")}s</p>
                  <ul className="flex flex-col gap-1.5">
                    {conclusionsOf(comments).investigation.concat(conclusionsOf(comments).findings).map((c) => (
                      <li key={c.id} className={cn("rounded-md px-2.5 py-1.5 text-[12.5px] whitespace-pre-wrap text-foreground", kindOf(c) === "finding" ? "bg-amber-500/10" : "bg-sky-500/10")}>
                        <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase", kindOf(c) === "finding" ? "bg-amber-500/20 text-amber-700 dark:text-amber-300" : "bg-sky-500/20 text-sky-700 dark:text-sky-300")}>{t(`kind.${kindOf(c)!}`)}</span>
                        {c.body}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {view !== "summary" && anyKinds ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("filterLabel")}>
              {(["all", ...NOTE_KINDS] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={noteFilter === k}
                  onClick={() => setNoteFilter(k)}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors", noteFilter === k ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  {k === "all" ? t("filterAll") : t(`kind.${k}`)}
                </button>
              ))}
            </div>
          ) : null}
          {view !== "summary" ? <div className="flex flex-col gap-3">
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("timelineEmpty")}</p>
            ) : (
              shown.map((item) =>
                item.kind === "comment" ? (
                  <div key={item.id} className="flex items-start gap-2.5">
                    <PersonAvatar name={item.comment.author_id ? nameOf(item.comment.author_id) : null} avatarUrl={profileOf(item.comment.author_id ?? undefined)?.avatar_url} />
                    <div className={cn("min-w-0 flex-1 rounded-lg px-3 py-2", KIND_STYLE[kindOf(item.comment) ?? "none"].box)}>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{item.comment.author_id ? nameOf(item.comment.author_id) : t("unknown")}</span>
                        {kindOf(item.comment) ? <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase", KIND_STYLE[kindOf(item.comment)!].badge)}>{t(`kind.${kindOf(item.comment)!}`)}</span> : null}
                        <span title={format(new Date(item.at), "PPpp")}>{view === "audit" ? format(new Date(item.at), "d MMM yyyy, HH:mm:ss") : formatDistanceToNow(new Date(item.at), { addSuffix: true })}</span>
                        {item.comment.edited_at ? <span className="italic" title={format(new Date(item.comment.edited_at), "PPpp")}>{t("edited")}</span> : null}
                        {canManage && view === "timeline" && editingId !== item.comment.id ? (
                          <span className="ml-auto flex items-center gap-3">
                            <button type="button" onClick={() => { setEditingId(item.comment.id); setEditText(item.comment.body); }} className="text-[11px] font-medium text-primary hover:underline">
                              {t("edit")}
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<button type="button" className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline" />}>
                                {kindOf(item.comment) ? t("markAsChange") : t("markAs")}
                                <ChevronDown className="size-3" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {NOTE_KINDS.filter((k) => k !== kindOf(item.comment)).map((k) => (
                                  <DropdownMenuItem key={k} onClick={() => void setKind(item.comment, k)}>{t(`kind.${k}`)}</DropdownMenuItem>
                                ))}
                                {kindOf(item.comment) ? <DropdownMenuItem onClick={() => void setKind(item.comment, null)}>{t("unmarkKind")}</DropdownMenuItem> : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        ) : null}
                      </div>
                      {editingId === item.comment.id ? (
                        <div className="mt-1 flex flex-col gap-2">
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            maxLength={10000}
                            rows={3}
                            autoFocus
                            aria-label={t("edit")}
                            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          />
                          <div className="flex items-center gap-2">
                            <Button size="sm" disabled={editBusy || !editText.trim()} onClick={() => void saveNote(item.comment)}>{t("editSave")}</Button>
                            <Button size="sm" variant="outline" disabled={editBusy} onClick={() => setEditingId(null)}>{t("cancel")}</Button>
                            <span className="text-[11px] text-muted-foreground">{t("editKept")}</span>
                          </div>
                        </div>
                      ) : (
                        <LinkifiedText text={item.comment.body} className="mt-0.5 text-[13px] whitespace-pre-wrap text-foreground" />
                      )}
                      {view === "audit" && (item.comment.previous_versions?.length ?? 0) > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-[12px] text-muted-foreground">
                          {[...(item.comment.previous_versions ?? [])].reverse().map((v, i) => (
                            <li key={i}>
                              <span className="font-medium">{t("earlierWording", { who: v.by ? nameOf(v.by) : t("unknown"), when: format(new Date(v.at), "d MMM yyyy, HH:mm:ss") })}</span>
                              <span className="whitespace-pre-wrap"> {v.body}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
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
                      · {view === "audit" ? format(new Date(item.at), "d MMM yyyy, HH:mm:ss") : formatDistanceToNow(new Date(item.at), { addSuffix: true })}
                    </span>
                  </div>
                ),
              )
            )}
          </div> : null}

          {view === "timeline" ? (
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
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <Paperclip className="size-3.5" />
              {t("evidenceTitle")}
              <InfoTip text={tTips("evidence")} />
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
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/incidents/${incident.id}/record`} className="rounded-xl border border-border bg-card px-4 py-3 text-xs font-medium text-primary hover:bg-muted/40">
                {tRecord("open")}
              </Link>
              <ShareLinkButton incidentId={incident.id} />
              <a
                href={`/api/incidents/${encodeURIComponent(incident.id)}/notification-docx`}
                download
                className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-xs font-medium text-primary hover:bg-muted/40"
              >
                <FileDown size={12} />
                Download notification letter
              </a>
            </div>
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

      <Dialog open={voidOpen} onOpenChange={(o) => !voidBusy && setVoidOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("voidTitle")}</DialogTitle>
            <DialogDescription>{t("voidHelp")}</DialogDescription>
          </DialogHeader>
          <Textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={3} maxLength={500} placeholder={t("voidReasonPlaceholder")} className="bg-muted" />
          <DialogFooter>
            <Button variant="outline" disabled={voidBusy} onClick={() => setVoidOpen(false)}>{t("cancel")}</Button>
            <Button disabled={voidBusy || voidReason.trim().length < 3} onClick={() => void voidIncident()}>{voidBusy ? <Loader2 className="size-4 animate-spin" /> : null}{t("voidConfirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(o) => !voidBusy && setDeleteOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteForGoodTitle")}</DialogTitle>
            <DialogDescription>{t("deleteForGoodHelp", { key: incidentKey(incident) })}</DialogDescription>
          </DialogHeader>
          <Input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder={incidentKey(incident)} aria-label={t("deleteTypeRef")} />
          <DialogFooter>
            <Button variant="outline" disabled={voidBusy} onClick={() => setDeleteOpen(false)}>{t("cancel")}</Button>
            <Button disabled={voidBusy || deleteConfirm.trim() !== incidentKey(incident)} className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void deleteIncident()}>
              {voidBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("deleteForGood")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {canManage ? (
        <TriageDialog
          open={triageOpen}
          onOpenChange={setTriageOpen}
          severity={incident.severity}
          severities={severityOptions}
          leadId={incident.incident_lead_id}
          members={members}
          onConfirm={confirmTriage}
        />
      ) : null}

      {canManage ? <CloseDialog open={closeOpen} onOpenChange={setCloseOpen} hasClosingNote={comments.some((c) => kindOf(c) === "closing")} onConfirm={confirmClose} /> : null}

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

function Field({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {tip ? <InfoTip text={tip} /> : null}
      </p>
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
