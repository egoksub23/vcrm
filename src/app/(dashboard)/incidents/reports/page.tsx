"use client";

import { Suspense } from "react";

import { ReportsHub } from "@/components/incidents/reports-hub";

export default function IncidentReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsHub />
    </Suspense>
  );
}
