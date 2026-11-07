// Shared in-memory pieces for the intake service's tests: a store that keeps everything in arrays, a small school, and a sample launch payload and answers.
import { generateKey, type KeyMode } from "./keys";
import { CCA_FORM } from "./form-schema";
import type { FormSchema } from "./form-schema";
import { builtInForm, type ClearanceRow, type IntakeStore, type NewIncident, type PlatformKeyRow, type ResolvedForm, type SchoolRow, type ServiceDeps, type SessionRow } from "./service";

export const SECRET = "test-secret";
/** The Vircle Group ID the tests give a school. */
export const groupOf = (accountId: string) => `G-${accountId}`;
export const T0 = new Date("2026-11-11T10:00:00Z");
export const ORIGIN = "https://coach.example.edu.my";

export class MemoryStore implements IntakeStore {
  clock = new Date(T0);
  keys: PlatformKeyRow[] = [];
  /** The Vircle Groups the operator has mapped to schools. */
  schools: SchoolRow[] = [];
  keyHashes = new Map<string, string>();
  sessions: SessionRow[] = [];
  incidents: (NewIncident & { id: string; reference: string })[] = [];
  calls: { accountId: string; route: string; status: number; summary: string }[] = [];
  disabled = new Set<string>();
  photos: { incidentId: string; filename: string }[] = [];
  clearanceRows: (ClearanceRow & { account_id: string })[] = [];
  limited = false;
  templates = new Map<string, { standardId: string; categoryCodes: string[]; severities: { slug: string; position: number }[] }>();
  told = ["head_of_sport", "school_nurse"];
  private n = 0;

  /** A platform key (it has no school). The school the call is for is the Vircle Group `groupOf(accountId)`, mapped here the first time it is needed. */
  addKey(accountId: string, mode: KeyMode = "live", over: Partial<PlatformKeyRow> = {}): { key: string; row: PlatformKeyRow; group: string } {
    const { key, hash } = generateKey(mode);
    const row: PlatformKeyRow = { id: `key-${++this.n}`, account_id: null, mode, scopes: ["launch", "clearances.read"], revoked_at: null, ...over };
    this.keys.push(row);
    this.keyHashes.set(hash, row.id);
    return { key, row, group: this.addSchool(accountId).group_id };
  }
  /** Map a school to its Vircle Group (once). */
  addSchool(accountId: string, over: Partial<SchoolRow> = {}): SchoolRow {
    const existing = this.schools.find((s) => s.account_id === accountId && s.group_id === (over.group_id ?? groupOf(accountId)));
    if (existing) return Object.assign(existing, over);
    const school: SchoolRow = { group_id: groupOf(accountId), group_name: `Vircle ${accountId}`, account_id: accountId, allowed_origins: [ORIGIN], enabled: true, ...over };
    this.schools.push(school);
    return school;
  }
  async findSchool(groupId: string) {
    return this.schools.find((s) => s.group_id === groupId) ?? null;
  }
  async findKeyByHash(hash: string) {
    const id = this.keyHashes.get(hash);
    return this.keys.find((k) => k.id === id) ?? null;
  }
  async getKey(id: string) {
    return this.keys.find((k) => k.id === id) ?? null;
  }
  async touchKey() {}
  async logCall(accountId: string, _k: string | null, route: string, status: number, summary: string) {
    this.calls.push({ accountId, route, status, summary });
  }
  async accountEnabled(accountId: string) {
    return !this.disabled.has(accountId);
  }
  async template(accountId: string) {
    return this.templates.get(accountId) ?? null;
  }
  async sessionByIdempotency(keyId: string, groupId: string, idem: string) {
    return this.sessions.find((s) => s.key_id === keyId && s.group_id === groupId && s.idempotency_key === idem) ?? null;
  }
  async createSession(row: Omit<SessionRow, "submitted_at" | "incident_id">) {
    const s: SessionRow = { ...row, submitted_at: null, incident_id: null };
    this.sessions.push(s);
    return s;
  }
  async getSession(id: string) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async createIncident(input: NewIncident) {
    const id = `inc-${this.incidents.length + 1}`;
    const reference = `INC-2026-${this.incidents.length + 1}`;
    this.incidents.push({ ...input, id, reference });
    return { id, reference };
  }
  async markSubmitted(sessionId: string, incidentId: string, now: Date) {
    const s = this.sessions.find((x) => x.id === sessionId)!;
    s.submitted_at = now.toISOString();
    s.incident_id = incidentId;
  }
  async incidentReference(incidentId: string) {
    return this.incidents.find((i) => i.id === incidentId)?.reference ?? null;
  }
  /** Published forms by account; an account without one uses the built-in form. Older versions stay readable for links already issued. */
  forms = new Map<string, { version: number; schema: FormSchema }[]>();
  async formFor(accountId: string, formKey: string, version: number | null | undefined): Promise<ResolvedForm | null> {
    const list = this.forms.get(accountId) ?? [];
    if (version != null) {
      const hit = list.find((f) => f.version === version);
      if (hit) return hit;
    } else if (list.length > 0) {
      return list[list.length - 1];
    }
    return formKey === CCA_FORM.id ? builtInForm(formKey) : null;
  }
  async toldRoles() {
    return this.told;
  }
  async clearances(accountId: string, ids: string[]) {
    return this.clearanceRows.filter((c) => c.account_id === accountId && ids.includes(c.external_student_id));
  }
  async photoCount(incidentId: string) {
    return this.photos.filter((p) => p.incidentId === incidentId).length;
  }
  async savePhoto(a: { incidentId: string; filename: string }) {
    this.photos.push({ incidentId: a.incidentId, filename: a.filename });
  }
  newId() {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
  }
  now() {
    return new Date(this.clock);
  }
  rateLimit() {
    return !this.limited;
  }
}

export const school = { standardId: "std", categoryCodes: ["CCA", "NMS", "PRD", "OTH"], severities: [{ slug: "critical", position: 0 }, { slug: "high", position: 1 }, { slug: "medium", position: 2 }, { slug: "low", position: 3 }] };

export function setup() {
  const store = new MemoryStore();
  store.templates.set("school-a", school);
  store.templates.set("school-b", school);
  const filed: string[] = [];
  const deps: ServiceDeps = { store, afterFiled: async (id) => void filed.push(id), appUrl: () => "https://halo.test", secret: SECRET };
  return { store, deps, filed };
}

export const payload = {
  coach: { id: "C-204", name: "Rahim Ismail", email: "rahim@school.test" },
  activity: { id: "A-1187", name: "Football U15", venue: "Field 2", date: "2026-11-11" },
  roster: [
    { student_id: "S-1", name: "Adam bin Yusof", class: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test" }] },
    { student_id: "S-2", name: "Daniel Lee", class: "9 Amanah" },
  ],
  return_url: `${ORIGIN}/activities/A-1187`,
};
export const answers = { involved: { ids: ["S-1"], others: [] }, kind: "injury", what: "Twisted ankle", severity: "first_aid", body_part: "leg", head_injury: false };
export const tokenOf = (url: string) => url.split("/report/")[1];

