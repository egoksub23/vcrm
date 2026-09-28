"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import { useAccountMembers } from "@/hooks/use-account-members";
import { INCIDENT_STATUSES } from "@/lib/incidents/constants";
import type { IncidentStatus } from "@/lib/incidents/constants";
import type { Incident } from "@/lib/incidents/types";
import { incidentKey } from "@/lib/incidents/types";
import { EscalationChip, SEVERITY_EDGE, SeverityBadge, TypeChip } from "./incident-visuals";

interface IncidentBoardProps {
  rows: Incident[];
  canManage: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, status: IncidentStatus) => void;
}

function severityRank(s: Incident["severity"]): number {
  return { P1: 0, P2: 1, P3: 2, P4: 3 }[s];
}

function Card({ row, dragging = false }: { row: Incident; dragging?: boolean }) {
  const { profileOf } = useAccountMembers();
  const lead = row.incident_lead_id ? profileOf(row.incident_lead_id) : undefined;
  return (
    <div
      className={cn(
        "rounded-md border border-l-[3px] border-border bg-card p-2.5 text-[13px] shadow-xs",
        SEVERITY_EDGE[row.severity],
        dragging && "rotate-1 shadow-lg",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{incidentKey(row)}</span>
        <div className="flex items-center gap-1">
          <EscalationChip level={row.escalation_level} />
          <SeverityBadge severity={row.severity} />
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 font-medium text-foreground">{row.title}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <TypeChip code={row.incident_type} className="min-w-0" />
        {lead ? (
          <span className="shrink-0 truncate text-[11px] text-muted-foreground">{lead.full_name}</span>
        ) : null}
      </div>
    </div>
  );
}

function DraggableCard({ row, canManage, onOpen }: { row: Incident; canManage: boolean; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled: !canManage,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(row.id)}
      className={cn("cursor-pointer touch-none", isDragging && "opacity-30")}
    >
      <Card row={row} />
    </div>
  );
}

function Column({
  status,
  rows,
  canManage,
  onOpen,
}: {
  status: IncidentStatus;
  rows: Incident[];
  canManage: boolean;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("Incidents.common.status");
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const sorted = useMemo(
    () => [...rows].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.created_at.localeCompare(a.created_at)),
    [rows],
  );
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t(status)}</h3>
        <span className="text-xs text-muted-foreground">{rows.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[120px] flex-1 flex-col gap-2 rounded-lg border border-dashed border-transparent p-1.5 transition-colors",
          isOver && "border-primary/40 bg-primary/5",
        )}
      >
        {sorted.map((row) => (
          <DraggableCard key={row.id} row={row} canManage={canManage} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export function IncidentBoard({ rows, canManage, onOpen, onMove }: IncidentBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byStatus = useMemo(() => {
    const out: Record<IncidentStatus, Incident[]> = {
      reported: [],
      triaged: [],
      contained: [],
      investigating: [],
      recovered: [],
      closed: [],
    };
    for (const r of rows) out[r.status].push(r);
    return out;
  }, [rows]);

  const activeRow = activeId ? rows.find((r) => r.id === activeId) : null;

  const handleDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const overId = e.over?.id;
    if (!overId) return;
    const row = rows.find((r) => r.id === e.active.id);
    const nextStatus = String(overId) as IncidentStatus;
    if (!row || row.status === nextStatus || !INCIDENT_STATUSES.includes(nextStatus)) return;
    onMove(row.id, nextStatus);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {INCIDENT_STATUSES.map((status) => (
          <Column key={status} status={status} rows={byStatus[status]} canManage={canManage} onOpen={onOpen} />
        ))}
      </div>
      <DragOverlay>{activeRow ? <Card row={activeRow} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
