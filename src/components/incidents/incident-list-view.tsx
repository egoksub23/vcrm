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
  selected?: ReadonlySet<string>;
  onSelectChange?: (next: Set<string>) => void;
}

export function IncidentListView({ rows, onOpen, selected, onSelectChange }: IncidentListViewProps) {
  const t = useTranslations("Incidents.list");
  const { profileOf } = useAccountMembers();

  const selectable = !!onSelectChange;
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(r.id));
  const someSelected = selectable && !allSelected && rows.some((r) => selected?.has(r.id));

  const toggleAll = () => {
    if (!onSelectChange) return;
    if (allSelected) {
      const next = new Set(selected);
      rows.forEach((r) => next.delete(r.id));
      onSelectChange(next);
    } else {
      const next = new Set(selected);
      rows.forEach((r) => next.add(r.id));
      onSelectChange(next);
    }
  };

  const toggleOne = (id: string) => {
    if (!onSelectChange) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectChange(next);
  };

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {selectable ? (
            <th className="w-10 px-3 py-2">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected; }}
                onChange={toggleAll}
                className="size-3.5 accent-primary"
                aria-label={t("selectAll")}
              />
            </th>
          ) : null}
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
          const isSelected = selected?.has(row.id) ?? false;
          return (
            <tr
              key={row.id}
              onClick={() => { if (!selectable) onOpen(row.id); }}
              className={`border-b border-border/60 last:border-b-0 hover:bg-muted/40 ${selectable ? "" : "cursor-pointer"} ${isSelected ? "bg-primary/5" : ""}`}
            >
              {selectable ? (
                <td className="w-10 px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(row.id)}
                    className="size-3.5 accent-primary"
                    aria-label={incidentKey(row)}
                  />
                </td>
              ) : null}
              <td
                className="px-3 py-2.5 font-mono text-[12.5px] text-muted-foreground cursor-pointer"
                onClick={() => onOpen(row.id)}
              >
                {incidentKey(row)}
              </td>
              <td
                className="max-w-[320px] truncate px-3 py-2.5 font-medium text-foreground cursor-pointer"
                onClick={() => onOpen(row.id)}
              >
                {row.title}
              </td>
              <td className="px-3 py-2.5">
                <TypeChip code={row.incident_type} standardId={row.standard_id} />
              </td>
              <td className="px-3 py-2.5">
                <SeverityBadge severity={row.severity} standardId={row.standard_id} />
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <StatusLozenge status={row.status} statusKey={row.status_key} />
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
