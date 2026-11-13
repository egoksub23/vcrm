"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ArrowLeft, Download, Loader2, Printer } from "lucide-react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { useAuth, useCapability } from "@/hooks/use-auth";
import { roleLabel } from "./message-log-panel";
import { api } from "@/components/incidents/setup/api";

interface Doc {
  reference: string;
  generated_at: string;
  incident: Record<string, unknown> & { title: string; description: string | null; category_name: string; severity_label: string; status: string; created_at: string; closed_at: string | null; root_cause: string | null; incident_flags: string[] | null; activity?: { name?: string; venue?: string; date?: string } | null; reporter_name?: string | null; source?: string | null; is_test?: boolean };
  people_named: { name: string; class_name: string | null; involvement: string; guardians: unknown[] | null }[];
  timeline: { event_type: string; from_value: string | null; to_value: string | null; created_at: string }[];
  comments: { body: string; created_at: string }[];
  required_steps: { title: string; role_key: string | null; party: string | null; due_at: string | null; status: string; completed_at: string | null }[];
  approvals: { role_key: string; decision: string | null; requested_at: string; decided_at: string | null; note: string | null }[];
  message_log: { role_key: string; recipient_name: string; address: string; reason: string; status: string; sent_at: string | null; acknowledged_at: string | null }[];
  files: { filename: string; mime_type: string; size_bytes: number; file_hash: string | null; created_at: string }[];
  return_to_play: { student_name: string; type: string; not_before: string; note: string | null; cleared_at: string | null }[] | null;
}

const when = (iso: string | null) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "–");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <h2 className="mb-2 border-b border-border pb-1 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** The incident record: one printable document with everything held about an incident. Print it, or save it as a PDF from the browser's print dialog. */
export function RecordView({ incidentId }: { incidentId: string }) {
  const t = useTranslations("IncidentPlatform.record");
  const { capabilitiesLoading } = useAuth();
  const allowed = useCapability("incidents.export");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void api<Doc>(`/api/incidents/${incidentId}/evidence`).then((res) => {
      if (!live) return;
      if (res.ok) setDoc(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [allowed, incidentId]);

  if (capabilitiesLoading) return null;
  if (!allowed) return <NoAccess />;
  if (error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!doc) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;
  const i = doc.incident;

  return (
    <article className="mx-auto flex max-w-[820px] flex-col gap-6 text-sm">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" size="sm" render={<Link href={`/incidents/${incidentId}`} />}><ArrowLeft />{t("back")}</Button>
        <Button size="sm" className="ml-auto" onClick={() => window.print()}><Printer />{t("print")}</Button>
        <Button variant="outline" size="sm" render={<a href={`/api/incidents/${incidentId}/evidence?download=1`} />}><Download />{t("json")}</Button>
      </div>

      <header>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">{t("title")}</p>
        <h1 className="text-xl font-semibold">{doc.reference}: {i.title}{i.is_test ? ` (${t("test")})` : ""}</h1>
        <p className="text-xs text-muted-foreground">{t("generated", { when: when(doc.generated_at) })}</p>
      </header>

      <Section title={t("summary")}>
        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t("category")}</dt><dd>{i.category_name}</dd>
          <dt className="text-muted-foreground">{t("severity")}</dt><dd>{i.severity_label}</dd>
          <dt className="text-muted-foreground">{t("status")}</dt><dd>{i.status}</dd>
          <dt className="text-muted-foreground">{t("raised")}</dt><dd>{when(i.created_at)}</dd>
          <dt className="text-muted-foreground">{t("closed")}</dt><dd>{when(i.closed_at)}</dd>
          {i.activity?.name ? (<><dt className="text-muted-foreground">{t("activity")}</dt><dd>{[i.activity.name, i.activity.venue, i.activity.date].filter(Boolean).join(" · ")}</dd></>) : null}
          {i.reporter_name ? (<><dt className="text-muted-foreground">{t("reportedBy")}</dt><dd>{i.reporter_name}{i.source === "coach_portal" ? ` (${t("viaPortal")})` : ""}</dd></>) : null}
          {(i.incident_flags ?? []).length > 0 ? (<><dt className="text-muted-foreground">{t("flags")}</dt><dd>{(i.incident_flags ?? []).join(", ")}</dd></>) : null}
        </dl>
        {i.description ? <p className="mt-2 whitespace-pre-wrap">{i.description}</p> : null}
        {i.root_cause ? <p className="mt-2"><strong>{t("rootCause")}:</strong> {i.root_cause}</p> : null}
      </Section>

      {doc.people_named.length > 0 ? (
        <Section title={t("people")}>
          <ul className="list-disc pl-5">{doc.people_named.map((p, n) => <li key={n}>{p.name}{p.class_name ? `, ${p.class_name}` : ""} ({p.involvement})</li>)}</ul>
        </Section>
      ) : null}

      {doc.return_to_play && doc.return_to_play.length > 0 ? (
        <Section title={t("returnToPlay")}>
          <ul className="list-disc pl-5">{doc.return_to_play.map((c, n) => <li key={n}>{c.student_name}: {c.type}, {t("notBefore")} {c.not_before}{c.cleared_at ? ` (${t("clearedEarly")})` : ""}{c.note ? `. ${c.note}` : ""}</li>)}</ul>
        </Section>
      ) : null}

      {doc.required_steps.length > 0 ? (
        <Section title={t("steps")}>
          <table className="w-full text-left"><tbody>{doc.required_steps.map((s, n) => (
            <tr key={n} className="border-b border-border last:border-0 align-top">
              <td className="py-1 pr-3">{s.title}</td>
              <td className="py-1 pr-3 text-muted-foreground">{s.role_key ? roleLabel(s.role_key) : s.party ?? ""}</td>
              <td className="py-1 pr-3 text-muted-foreground">{t("due")} {when(s.due_at)}</td>
              <td className="py-1">{s.status === "done" ? `${t("done")} ${when(s.completed_at)}` : s.status}</td>
            </tr>
          ))}</tbody></table>
        </Section>
      ) : null}

      {doc.approvals.length > 0 ? (
        <Section title={t("approvals")}>
          <ul className="list-disc pl-5">{doc.approvals.map((a, n) => <li key={n}>{roleLabel(a.role_key)}: {a.decision ?? t("waiting")} ({when(a.decided_at ?? a.requested_at)}){a.note ? `. ${a.note}` : ""}</li>)}</ul>
        </Section>
      ) : null}

      <Section title={t("timeline")}>
        <ul className="flex flex-col gap-1">
          {[...doc.timeline.map((e) => ({ at: e.created_at, text: `${e.event_type}${e.from_value || e.to_value ? `: ${e.from_value ?? ""} → ${e.to_value ?? ""}` : ""}` })), ...doc.comments.map((c) => ({ at: c.created_at, text: `${t("comment")}: ${c.body}` }))]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((e, n) => <li key={n}><span className="text-muted-foreground">{when(e.at)}</span> {e.text}</li>)}
        </ul>
      </Section>

      {doc.message_log.length > 0 ? (
        <Section title={t("messages")}>
          <ul className="list-disc pl-5">{doc.message_log.map((m, n) => <li key={n}>{roleLabel(m.role_key)}: {m.recipient_name} ({m.address}), {m.reason}, {m.status}{m.acknowledged_at ? `, ${t("acknowledged")} ${when(m.acknowledged_at)}` : ""}</li>)}</ul>
        </Section>
      ) : null}

      {doc.files.length > 0 ? (
        <Section title={t("files")}>
          <ul className="list-disc pl-5">{doc.files.map((f, n) => <li key={n}>{f.filename} ({Math.round(f.size_bytes / 1024)} KB){f.file_hash ? <span className="font-mono text-[10px] text-muted-foreground"> sha256 {f.file_hash.slice(0, 16)}…</span> : null}</li>)}</ul>
        </Section>
      ) : null}
    </article>
  );
}
