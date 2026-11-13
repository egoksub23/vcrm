// /incident-share/[token]: read-only public view of one incident. No login needed.
// Shows: reference, school, category, severity, status, date raised, and optional description.
// No names, no attachments, no medical detail.
import type { Metadata } from "next";

import { verifyShareToken } from "@/lib/incidents/platform/share-links";
import { createAdminPgDb } from "@/lib/postgres/db";
import { incidentKey } from "@/lib/incidents/types";

export const metadata: Metadata = { title: "Incident summary", robots: { index: false, follow: false } };

const STATUS_LABELS: Record<string, string> = {
  reported: "Reported",
  triaged: "Triaged",
  investigating: "Investigating",
  resolved: "Resolved",
  closed: "Closed",
  voided: "Voided",
};

function Badge({ label, variant }: { label: string; variant?: "warn" | "ok" | "default" }) {
  const cls =
    variant === "warn"
      ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200"
      : variant === "ok"
        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200"
        : "bg-muted text-muted-foreground";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export default async function IncidentSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const verified = verifyShareToken(token);
  if (!verified) return <Invalid />;

  const db = createAdminPgDb();
  const { data: inc } = await db
    .from("incidents")
    .select("id, account_id, incident_number, created_at, incident_type, severity, status, description, standard_id, is_test")
    .eq("id", verified.incidentId)
    .maybeSingle();
  if (!inc) return <Invalid />;
  const i = inc as { id: string; account_id: string; incident_number: number; created_at: string; incident_type: string; severity: string; status: string; description: string | null; standard_id: string | null; is_test: boolean };

  let categoryName = i.incident_type;
  let severityName = i.severity;

  if (i.standard_id) {
    const [cat, sev] = await Promise.all([
      db.from("incident_type_catalogue").select("name").eq("standard_id", i.standard_id).eq("code", i.incident_type).maybeSingle(),
      db.from("incident_severity_levels").select("label").eq("standard_id", i.standard_id).eq("slug", i.severity).maybeSingle(),
    ]);
    categoryName = (cat.data as { name: string } | null)?.name ?? categoryName;
    severityName = (sev.data as { label: string } | null)?.label ?? severityName;
  }

  const { data: acct } = await db.from("accounts").select("brand_name, name").eq("id", i.account_id).maybeSingle();
  const school = acct as { brand_name: string | null; name: string | null } | null;
  const schoolName = school?.brand_name || school?.name || null;
  const reference = incidentKey(i);
  const raisedAt = new Date(i.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 py-10">
      {i.is_test ? <Badge label="Test incident" variant="warn" /> : null}
      {schoolName ? <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{schoolName}</p> : null}
      <h1 className="text-xl font-semibold">Incident {reference}</h1>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Category</dt>
        <dd>{categoryName}</dd>
        <dt className="text-muted-foreground">Severity</dt>
        <dd>{severityName}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <Badge label={STATUS_LABELS[i.status] ?? i.status} variant={i.status === "closed" ? "ok" : "default"} />
        </dd>
        <dt className="text-muted-foreground">Raised</dt>
        <dd>{raisedAt}</dd>
      </dl>

      {i.description ? (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed">
          {i.description}
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-muted-foreground">
        This is a read-only summary shared with you by {schoolName ?? "the school"}. For privacy, it shows no names or medical details.
        This link expires {verified.expiresAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.
      </p>
    </main>
  );
}

function Invalid() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-10">
      <h1 className="text-xl font-semibold">This link is not valid</h1>
      <p className="text-sm text-muted-foreground">It may have been copied incompletely, or it has expired. Ask the school to send you a new link.</p>
    </main>
  );
}
