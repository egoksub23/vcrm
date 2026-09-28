"use client";

import { useParams, useRouter } from "next/navigation";

import { IncidentDetail } from "@/components/incidents/incident-detail";

export default function IncidentPage() {
  const params = useParams();
  const router = useRouter();
  const incidentId = params.id as string;

  return (
    <div className="mx-auto max-w-[1100px]">
      <IncidentDetail key={incidentId} incidentId={incidentId} onBack={() => router.push("/incidents")} />
    </div>
  );
}
