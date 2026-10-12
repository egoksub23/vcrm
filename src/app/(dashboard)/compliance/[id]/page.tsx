"use client";

import { useParams } from "next/navigation";

import { RequestDetailScreen } from "@/components/compliance/request-detail";

// One compliance request. The id is only a way to ask the server: every read checks the workspace and the permission again.
export default function ComplianceRequestPage() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";
  return <RequestDetailScreen key={id} id={id} />;
}
