// /incident-approval/[token]: approve or reject a workflow step from an email link. No login required.
// The signed token encodes the approval id and decision (a=approved, r=rejected).
import type { Metadata } from "next";

import { verifyApprovalToken } from "@/lib/incidents/platform/engine";
import { ApprovalForm } from "./approval-form";

export const metadata: Metadata = { title: "Incident approval", robots: { index: false, follow: false } };

type Ctx = { params: Promise<{ token: string }> };

export default async function IncidentApprovalPage({ params }: Ctx) {
  const { token } = await params;
  const parsed = verifyApprovalToken(token);

  if (!parsed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-10">
        <h1 className="text-xl font-semibold">This link is not valid</h1>
        <p className="text-sm text-muted-foreground">
          It may have been copied incompletely, or the approval has already been dealt with. Sign in to Halo to manage it there.
        </p>
      </main>
    );
  }

  // Load context from the API (server-side fetch keeps this simple and consistent with the client path).
  let view: {
    approvalId: string;
    decision: "a" | "r";
    reference: string;
    roleName: string;
    forStatus: string | null;
    alreadyDecided: boolean;
    schoolName: string | null;
  } | null = null;

  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "";
    const res = await fetch(`${base}/api/public/incident-approval?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (res.ok) view = await res.json();
  } catch {
    // fall through to the error state below
  }

  if (!view) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-10">
        <h1 className="text-xl font-semibold">This link is not valid</h1>
        <p className="text-sm text-muted-foreground">
          It may have been copied incompletely. Sign in to Halo to manage approvals there.
        </p>
      </main>
    );
  }

  const decisionLabel = view.decision === "a" ? "Approve" : "Reject";
  const statusLabel = view.forStatus ? ` to move to "${view.forStatus}"` : "";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-10">
      {view.schoolName ? (
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{view.schoolName}</p>
      ) : null}
      <h1 className="text-xl font-semibold">
        {decisionLabel} — incident {view.reference}
      </h1>
      {view.roleName ? (
        <p className="text-sm text-muted-foreground">
          Requested of: <strong>{view.roleName}</strong>
          {statusLabel}
        </p>
      ) : null}
      <ApprovalForm token={token} decision={view.decision} alreadyDecided={view.alreadyDecided} />
      <p className="text-xs leading-relaxed text-muted-foreground">
        For privacy this page shows no names or medical detail. Sign in to Halo to see the full incident.
      </p>
    </main>
  );
}
