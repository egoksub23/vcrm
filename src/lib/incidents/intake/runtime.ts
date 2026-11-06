// Wires the intake service to the real database, the notification engine and the site address. The routes call this and nothing else.

import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { PgIntakeStore } from "./pg-intake-store";
import type { ServiceDeps } from "./service";

export function intakeDeps(): ServiceDeps {
  return {
    store: new PgIntakeStore(),
    afterFiled: async (incidentId) => {
      await processIncidentEvent(incidentId, "raised");
    },
    appUrl: () => process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
  };
}

/** A caller's address for rate limiting (behind the reverse proxy: the first X-Forwarded-For entry). */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
