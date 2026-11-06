"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ClipboardList } from "lucide-react";

import { api } from "@/components/incidents/setup/api";

interface Data {
  available: boolean;
  source?: string;
  formVersion?: number | null;
  reporter?: { name: string | null; email: string | null; phone: string | null };
  activity?: { name?: string; venue?: string; date?: string } | null;
  lines?: { key: string; label: string; value: string }[];
  people?: { name: string; class_name: string | null; involvement: string; has_guardian_contact: boolean }[];
}

/** For a report that came from the coach portal: who reported it, the activity, the people named, and the coach's answers. Nothing shows for a report raised inside Halo. */
export function ReportAnswersPanel({ incidentId }: { incidentId: string }) {
  const t = useTranslations("IncidentPlatform.answers");
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    let live = true;
    void api<Data>(`/api/incidents/${incidentId}/answers`).then((res) => {
      if (live && res.ok) setData(res.data);
    });
    return () => {
      live = false;
    };
  }, [incidentId]);

  if (!data?.available) return null;
  const a = data.activity;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <ClipboardList className="size-3.5" />
        {t("title")}
        <span className="ml-auto font-medium normal-case">{data.formVersion ? t("version", { version: data.formVersion }) : t("builtIn")}</span>
      </h3>
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-xs">
        {data.reporter?.name ? (<><dt className="text-muted-foreground">{t("reportedBy")}</dt><dd>{data.reporter.name}{data.reporter.email ? ` · ${data.reporter.email}` : ""}</dd></>) : null}
        {a?.name ? (<><dt className="text-muted-foreground">{t("activity")}</dt><dd>{[a.name, a.venue, a.date].filter(Boolean).join(" · ")}</dd></>) : null}
        {(data.people ?? []).length > 0 ? (
          <>
            <dt className="text-muted-foreground">{t("people")}</dt>
            <dd>
              <ul className="flex flex-col gap-0.5">
                {(data.people ?? []).map((p, i) => (
                  <li key={i}>{p.name}{p.class_name ? `, ${p.class_name}` : ""}<span className="text-muted-foreground"> · {t(`involvement.${p.involvement}`)}{p.has_guardian_contact ? ` · ${t("parentReachable")}` : ""}</span></li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {(data.lines ?? []).map((l) => (
          <div key={l.key} className="contents">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="whitespace-pre-wrap">{l.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
