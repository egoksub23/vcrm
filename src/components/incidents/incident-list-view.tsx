"use client";

import { useTranslations } from "next-intl";
import { formatDistanceToNowStrict } from "date-fns";

import { useAccountMembers } from "@/hooks/use-account-members";
import type { Incident } from "@/lib/incidents/types";
import { incidentKey } from "@/lib/incidents/types";
import { EscalationChip, SeverityBadge, StatusLozenge, TypeChip } from "./incident-visuals";

interface IncidentListViewProps {
  rows: Incident[];
  onOpen: (id: string) => void;
}

export function IncidentListView({ rows, onOpen }: IncidentListViewProps) {
  const t = useTranslations("Incidents.list");
  const { profileOf } = useAccountMembers();

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <th className="px-3 py-2 font-semibold">{t("colKey")}</th>
          <th className="px-3 py-2 font-semibold">{t("colTitle")}</th>
          <th className="px-3 py-2 font-semibold">{t("colType")}</th>
          <th className="px-3 py-2 font-semibold">{t("colSeverity")}</th>
          <th className="px-3 py-2 font-semibold">{t("colStatus")}</th>
          <th className="px-3 py-2 font-semibold">{t("colLead")}</th>
          <th className="px-3 py-2 font-semibold">{t("colAge")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const lead = row.incident_lead_id ? profileOf(row.incident_lead_id) : undefined;
          return (
            <tr
              key={row.id}
              onClick={() => onOpen(row.id)}
              className="cursor-pointer border-b border-border/60 last:border-b-0 hover:bg-muted/40"
            >
              <td className="px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground">{incidentKey(row)}</td>
              <td className="max-w-[320px] truncate px-3 py-2.5 font-medium text-foreground">{row.title}</td>
              <td className="px-3 py-2.5">
                <TypeChip code={row.incident_type} />
              </td>
              <td className="px-3 py-2.5">
                <SeverityBadge severity={row.severity} />
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <StatusLozenge status={row.status} />
                  <EscalationChip level={row.escalation_level} />
                </div>
              </td>
              <td className="px-3 py-2.5 text-[12.5px] text-muted-foreground">
                {lead?.full_name ?? t("unassigned")}
              </td>
              <td className="px-3 py-2.5 text-[12.5px] text-muted-foreground">
                {formatDistanceToNowStrict(new Date(row.created_at), { addSuffix: false })}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
