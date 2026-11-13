// Wires the intake service to the real database, the notification engine and the site address. The routes call this and nothing else.

import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { createAdminPgDb } from "@/lib/postgres/db";
import { deliverSchoolWebhookEvent } from "@/lib/incidents/platform/school-webhooks";
import { incidentKey } from "@/lib/incidents/types";
import { PgIntakeStore } from "./pg-intake-store";
import { enqueueIncidentCreated } from "@/lib/incidents/webhooks/pg-webhook-store";
import type { ServiceDeps } from "./service";

export function intakeDeps(): ServiceDeps {
  return {
    store: new PgIntakeStore(),
    afterFiled: async (incidentId) => {
      await processIncidentEvent(incidentId, "raised");
      await enqueueIncidentCreated(incidentId);
      // School-level webhook (Phase 3.6) — fire-and-forget, never blocks filing.
      void (async () => {
        const db = createAdminPgDb();
        const { data } = await db.from("incidents").select("account_id, incident_number, created_at, incident_type, severity, status").eq("id", incidentId).maybeSingle();
        if (!data) return;
        const inc = data as { account_id: string; incident_number: number; created_at: string; incident_type: string; severity: string; status: string };
        deliverSchoolWebhookEvent(inc.account_id, "incident.filed", { incident_id: incidentId, reference: incidentKey(inc), category: inc.incident_type, severity: inc.severity, status: inc.status });
      })();
    },
    appUrl: () => process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
  };
}

/** A caller's address for rate limiting (behind the reverse proxy: the first X-Forwarded-For entry). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
