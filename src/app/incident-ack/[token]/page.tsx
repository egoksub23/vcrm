// /incident-ack/[token]: the page behind "I have seen this" in an incident notice. No login. It shows only the reference, category and severity
// (never names or medical detail), and one button. A bad link is a plain "not valid" page that says nothing about whether an incident exists.
import type { Metadata } from "next";

import { AckButton } from "./ack-button";
import { loadAckView } from "@/lib/incidents/platform/ack";

export const metadata: Metadata = { title: "Incident notice", robots: { index: false, follow: false } };

export default async function IncidentAckPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadAckView(token);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-10">
      {view ? (
        <>
          {view.schoolName ? <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{view.schoolName}</p> : null}
          <h1 className="text-xl font-semibold">Incident {view.reference}</h1>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Category</dt>
            <dd>{view.categoryName}</dd>
            <dt className="text-muted-foreground">Severity</dt>
            <dd>{view.severityName}</dd>
          </dl>
          <AckButton token={token} initiallyDone={view.alreadyAcknowledged} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            For privacy this page shows no names or medical detail. Sign in to Halo to see the incident.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold">This link is not valid</h1>
          <p className="text-sm text-muted-foreground">It may have been copied incompletely. Use the link in the original message, or sign in to Halo.</p>
        </>
      )}
    </main>
  );
}
