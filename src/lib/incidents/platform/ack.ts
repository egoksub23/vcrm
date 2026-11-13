// Acknowledging a notice. One acknowledgement from anyone stops the reminder chain for the incident, because the question the school asks is
// "has a responsible person seen this?", not "has everyone".

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { verifyAckToken } from "./engine";

export interface AckView {
  deliveryId: string;
  incidentId: string;
  reference: string;
  categoryName: string;
  severityName: string;
  alreadyAcknowledged: boolean;
  schoolName: string | null;
}

/** What the public acknowledge page may show: the reference, category and severity. No names, no description. Null for a bad or unknown token. */
export async function loadAckView(token: string, db: PgDb = createAdminPgDb()): Promise<AckView | null> {
  const deliveryId = verifyAckToken(token);
  if (!deliveryId) return null;
  const { data: d } = await db.from("incident_deliveries").select("id, incident_id, account_id, ask_ack, acknowledged_at").eq("id", deliveryId).maybeSingle();
  const delivery = d as { id: string; incident_id: string; account_id: string; ask_ack: boolean; acknowledged_at: string | null } | null;
  if (!delivery || !delivery.ask_ack) return null;
  const { data: i } = await db.from("incidents").select("incident_number, created_at, incident_type, severity, standard_id").eq("id", delivery.incident_id).maybeSingle();
  const inc = i as { incident_number: number; created_at: string; incident_type: string; severity: string; standard_id: string | null } | null;
  if (!inc) return null;

  let categoryName = inc.incident_type;
  let severityName = inc.severity;
  if (inc.standard_id) {
    const [type, sev] = await Promise.all([
      db.from("incident_type_catalogue").select("name").eq("standard_id", inc.standard_id).eq("code", inc.incident_type).maybeSingle(),
      db.from("incident_severity_levels").select("label").eq("standard_id", inc.standard_id).eq("slug", inc.severity).maybeSingle(),
    ]);
    categoryName = (type.data as { name: string } | null)?.name ?? categoryName;
    severityName = (sev.data as { label: string } | null)?.label ?? severityName;
  }
  const { data: a } = await db.from("accounts").select("brand_name, name").eq("id", delivery.account_id).maybeSingle();
  const acct = a as { brand_name: string | null; name: string | null } | null;
  return {
    deliveryId: delivery.id,
    incidentId: delivery.incident_id,
    reference: `INC-${new Date(inc.created_at).getFullYear()}-${inc.incident_number}`,
    categoryName,
    severityName,
    alreadyAcknowledged: delivery.acknowledged_at !== null,
    schoolName: acct?.brand_name || acct?.name || null,
  };
}

/** Mark one delivery acknowledged (idempotent). Returns false for an unknown or non-acknowledge delivery. */
export async function acknowledgeByToken(token: string, db: PgDb = createAdminPgDb()): Promise<boolean> {
  const deliveryId = verifyAckToken(token);
  if (!deliveryId) return false;
  const { data } = await db
    .from("incident_deliveries")
    .select("id, ask_ack, acknowledged_at")
    .eq("id", deliveryId)
    .maybeSingle();
  const row = data as { id: string; ask_ack: boolean; acknowledged_at: string | null } | null;
  if (!row || !row.ask_ack) return false;
  if (row.acknowledged_at) return true;
  const { error } = await db
    .from("incident_deliveries")
    .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
    .eq("id", deliveryId)
    .is("acknowledged_at", null);
  return !error;
}

/** A signed-in manager acknowledges an incident in Halo: every notice still waiting for an acknowledgement on it counts as acknowledged by them. */
export async function acknowledgeInApp(incidentId: string, accountId: string, userId: string, db: PgDb = createAdminPgDb()): Promise<number> {
  const { data } = await db
    .from("incident_deliveries")
    .update({ status: "acknowledged", acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
    .eq("incident_id", incidentId)
    .eq("account_id", accountId)
    .eq("ask_ack", true)
    .is("acknowledged_at", null)
    .select("id");
  return ((data ?? []) as unknown[]).length;
}
