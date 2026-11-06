"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { HeartPulse } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CLEARANCE_TYPES, describeNotBefore } from "@/lib/incidents/platform/clearance";
import { api } from "@/components/incidents/setup/api";

interface Student {
  external_student_id: string;
  name: string;
  class_name: string | null;
}
interface Existing {
  id: string;
  external_student_id: string;
  not_before: string;
  type: string;
  cleared_at: string | null;
}

const field = "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** On an incident: set the first day each named student may play. Shown to people who hold incidents.medical, and only when students from the portal are named. */
export function ClearancePanel({ incidentId }: { incidentId: string }) {
  const t = useTranslations("IncidentPlatform.clearancePanel");
  const tType = useTranslations("IncidentPlatform.clearances");
  const [students, setStudents] = useState<Student[] | null>(null);
  const [existing, setExisting] = useState<Existing[]>([]);

  const load = useCallback(async () => {
    const res = await api<{ students: Student[]; clearances: Existing[] }>(`/api/incidents/clearances?incident=${incidentId}`);
    if (res.ok) {
      setStudents(res.data.students);
      setExisting(res.data.clearances);
    }
  }, [incidentId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of server data
    void load();
  }, [load]);

  if (!students || students.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <HeartPulse className="size-3.5" />
        {t("title")}
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">{t("help")}</p>
      <ul className="flex flex-col gap-3">
        {students.map((s) => (
          <StudentRow key={s.external_student_id} incidentId={incidentId} student={s} current={existing.find((e) => e.external_student_id === s.external_student_id && !e.cleared_at)} onSaved={load} tType={(k) => tType(k)} />
        ))}
      </ul>
    </div>
  );
}

function StudentRow({ incidentId, student, current, onSaved, tType }: { incidentId: string; student: Student; current?: Existing; onSaved: () => Promise<void>; tType: (key: string) => string }) {
  const t = useTranslations("IncidentPlatform.clearancePanel");
  const [date, setDate] = useState(current?.not_before ?? "");
  const [type, setType] = useState(current?.type ?? "injury");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const res = await api("/api/incidents/clearances", "POST", { incident_id: incidentId, student_id: student.external_student_id, type, not_before: date });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(t("saved"));
    await onSaved();
  };

  return (
    <li className="text-sm">
      <p className="font-medium">
        {student.name}
        {student.class_name ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{student.class_name}</span> : null}
      </p>
      {current ? <p className="text-xs text-muted-foreground">{t("current", { date: describeNotBefore(current.not_before).replace("not before ", "") })}</p> : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("date")}
          <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("type")}
          <select className={field} value={type} onChange={(e) => setType(e.target.value)}>
            {CLEARANCE_TYPES.map((c) => <option key={c} value={c}>{tType(`type_${c}`)}</option>)}
          </select>
        </label>
        <Button size="sm" onClick={() => void save()} disabled={busy || !date}>{t("save")}</Button>
      </div>
    </li>
  );
}
