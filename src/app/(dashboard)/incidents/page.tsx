"use client";

import { Suspense } from "react";

import { IncidentDashboard } from "@/components/incidents/incident-dashboard";

export default function IncidentsPage() {
  return (
    <Suspense fallback={null}>
      <IncidentDashboard />
    </Suspense>
  );
}
