"use client";

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
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useCapability } from "@/hooks/use-can";
import { attachFileToIncident } from "@/lib/incidents/attachment-actions";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
} from "@/lib/incidents/constants";
import type { IncidentSeverity, IncidentStatus } from "@/lib/incidents/constants";
import { incidentKey } from "@/lib/incidents/types";
import type {
  Incident,
  IncidentAction,
  IncidentActivity,
  IncidentAttachment,
  IncidentComment,
  IncidentNotificationSent,
} from "@/lib/incidents/types";
import { PersonAvatar } from "@/components/tickets/ticket-visuals";
import { linkifySegments } from "@/lib/sembang/linkify";
import { EscalationChip, SeverityBadge, StatusLozenge } from "./incident-visuals";
import { GenerateDocumentDialog } from "./generate-document-dialog";

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

type TimelineItem =
  | { kind: "comment"; id: string; at: string; comment: IncidentComment }
  | { kind: "activity"; id: string; at: string; event: IncidentActivity };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function IncidentDetail({ incidentId, onBack }: { incidentId: string; onBack: () => void }) {
  const t = useTranslations("Incidents.detail");
  const tActivity = useTranslations("Incidents.detail.activity");
  const { user } = useAuth();
  const { members, nameOf, profileOf } = useAccountMembers();
  const canManage = useCapability("incidents.manage");

  const [incident, setIncident] = useState<Incident | null>(null);
  const [comments, setComments] = useState<IncidentComment[]>([]);
  const [activity, setActivity] = useState<IncidentActivity[]>([]);
  const [attachments, setAttachments] = useState<IncidentAttachment[]>([]);
  const [notificationsSent, setNotificationsSent] = useState<IncidentNotificationSent[]>([]);
  const [actions, setActions] = useState<IncidentAction[]>([]);
  const [loading, setLoading] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [inc, com, act, att, ns, ac] = await Promise.all([
      supabase.from("incidents").select("*").eq("id", incidentId).maybeSingle(),
      supabase.from("incident_comments").select("*").eq("incident_id", incidentId).order("created_at"),
      supabase.from("incident_activity").select("*").eq("incident_id", incidentId).order("created_at"),
      supabase.from("incident_attachments").select("*").eq("incident_id", incidentId).order("created_at"),
      supabase.from("incident_notifications_sent").select("*").eq("incident_id", incidentId).order("sent_at", { ascending: false }),
      supabase.from("incident_actions").select("*").eq("incident_id", incidentId).order("created_at"),
    ]);
    setIncident((inc.data as Incident) ?? null);
    setComments((com.data as IncidentComment[]) ?? []);
    setActivity((act.data as IncidentActivity[]) ?? []);
    setAttachments((att.data as IncidentAttachment[]) ?? []);
    setNotificationsSent((ns.data as IncidentNotificationSent[]) ?? []);
    setActions((ac.data as IncidentAction[]) ?? []);
    setLoading(false);
  }, [incidentId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`incident-detail-${incidentId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "incidents", filter: `id=eq.${incidentId}` }, (payload) => {
        setIncident((prev) => (prev ? { ...prev, ...(payload.new as Incident) } : prev));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_comments", filter: `incident_id=eq.${incidentId}` }, (payload) => {
        setComments((prev) => (prev.some((c) => c.id === (payload.new as IncidentComment).id) ? prev : [...prev, payload.new as IncidentComment]));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_activity", filter: `incident_id=eq.${incidentId}` }, (payload) => {
        setActivity((prev) => (prev.some((a) => a.id === (payload.new as IncidentActivity).id) ? prev : [...prev, payload.new as IncidentActivity]));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_attachments", filter: `incident_id=eq.${incidentId}` }, (payload) => {
        setAttachments((prev) => (prev.some((a) => a.id === (payload.new as IncidentAttachment).id) ? prev : [...prev, payload.new as IncidentAttachment]));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [incidentId]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map((c) => ({ kind: "comment" as const, id: c.id, at: c.created_at, comment: c })),
      ...activity.map((a) => ({ kind: "activity" as const, id: a.id, at: a.created_at, event: a })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [comments, activity]);

  const patch = async (fields: Partial<Incident>) => {
    if (!incident) return;
    const prev = incident;
    setIncident({ ...incident, ...fields });
    const { error } = await createClient().from("incidents").update(fields).eq("id", incident.id);
    if (error) {
      setIncident(prev);
      toast.error(t("updateFailed"));
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
    if (!incident || !user || !draft.trim()) return;
    setPosting(true);
    const { error } = await createClient().from("incident_comments").insert({
      incident_id: incident.id,
      author_id: user.id,
      body: draft.trim(),
      mentions,
    });
    setPosting(false);
    if (error) {
      toast.error(t("commentFailed"));
      return;
    }
    setDraft("");
    setMentions([]);
  };

  const handleFiles = async (files: File[]) => {
    if (!incident || !user) return;
    setUploading(true);
    let failed = 0;
    for (const file of files) {
      try {
        await attachFileToIncident(incident, file, user.id);
      } catch {
        failed += 1;
      }
    }
    setUploading(false);
    if (failed > 0) toast.error(t("attachmentsFailed", { count: failed }));
  };

  const [documentDialogOpen, setDocumentDialogOpen] = useState(false);

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
              <Button variant="outline" size="sm" onClick={() => setDocumentDialogOpen(true)}>
                <FileOutput className="size-3.5" />
                {t("documents.generateDocument")}
              </Button>
            </div>
          ) : null}
        </div>

        {incident.description ? (
          <LinkifiedText text={incident.description} className="mt-3 text-sm whitespace-pre-wrap text-foreground" />
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Field label={t("fieldSeverity")}>
            {canManage ? (
              <Select value={incident.severity} onValueChange={(v) => void patch({ severity: v as IncidentSeverity })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <SeverityBadge severity={incident.severity} />
            )}
          </Field>
          <Field label={t("fieldStatus")}>
            {canManage ? (
              <Select value={incident.status} onValueChange={(v) => void patch({ status: v as IncidentStatus })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
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
              <Select value={incident.incident_type} onValueChange={(v) => void patch({ incident_type: v as never })}>
                <SelectTrigger className="h-8 w-full bg-muted text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_TYPES.map((ty) => (
                    <SelectItem key={ty.code} value={ty.code}>
                      {ty.code} — {ty.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs text-muted-foreground">{incident.incident_type}</span>
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
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("timelineTitle")}</h2>
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
                    <span>{activityText(item.event)}</span>
                    <span className="text-muted-foreground/70" title={format(new Date(item.at), "PPpp")}>
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
              <ul className="flex flex-col gap-1.5">
                {attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted"
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                      <span className="shrink-0 text-muted-foreground">{formatBytes(a.size_bytes)}</span>
                    </a>
                  </li>
                ))}
              </ul>
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
      </div>

      {canManage ? (
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
    if (!user || !description.trim()) return;
    setBusy(true);
    const { data, error } = await createClient()
      .from("incident_actions")
      .insert({
        incident_id: incidentId,
        description: description.trim(),
        owner_id: ownerId,
        due_date: dueDate || null,
        created_by: user.id,
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(t("addFailed"));
      return;
    }
    onAdded(data as IncidentAction);
    setAdding(false);
    setDescription("");
    setOwnerId(null);
    setDueDate("");
  };

  const toggleDone = async (row: IncidentAction) => {
    const nextStatus = row.status === "done" ? "open" : "done";
    const { data, error } = await createClient()
      .from("incident_actions")
      .update({ status: nextStatus, closed_at: nextStatus === "done" ? new Date().toISOString() : null })
      .eq("id", row.id)
      .select("*")
      .single();
    if (error || !data) {
      toast.error(t("updateFailed"));
      return;
    }
    onChanged(data as IncidentAction);
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
    if (!user) return;
    setBusy(true);
    const { data, error } = await createClient()
      .from("incident_notifications_sent")
      .insert({
        incident_id: incidentId,
        recipient_party: party,
        reference: reference.trim() || null,
        sent_at: new Date().toISOString(),
        recorded_by: user.id,
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(t("addFailed"));
      return;
    }
    onAdded(data as IncidentNotificationSent);
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
