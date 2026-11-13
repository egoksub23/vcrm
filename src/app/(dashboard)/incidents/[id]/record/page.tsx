"use client";

import { useParams } from "next/navigation";

import { RecordView } from "@/components/incidents/record-view";

export default function IncidentRecordPage() {
  const params = useParams();
  return <RecordView incidentId={params.id as string} />;
}
