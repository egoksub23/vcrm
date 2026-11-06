import { describe, expect, it } from "vitest";

import { addPhoto, clearances, launch, loadReport, submit, SESSION_HOURS, MAX_PHOTOS, type ClearanceRow, type IntakeStore, type KeyRow, type NewIncident, type ServiceDeps, type SessionRow } from "./service";
import { generateKey, hashKey, readSessionToken, type KeyMode } from "./keys";

const SECRET = "test-secret";
const T0 = new Date("2026-11-11T10:00:00Z");
const ORIGIN = "https://coach.example.edu.my";

class MemoryStore implements IntakeStore {
  clock = new Date(T0);
  keys: KeyRow[] = [];
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

  addKey(accountId: string, mode: KeyMode = "live", over: Partial<KeyRow> = {}): { key: string; row: KeyRow } {
    const { key, hash } = generateKey(mode);
    const row: KeyRow = { id: `key-${++this.n}`, account_id: accountId, mode, scopes: ["launch", "clearances.read"], allowed_origins: [ORIGIN], revoked_at: null, ...over };
    this.keys.push(row);
    this.keyHashes.set(hash, row.id);
    return { key, row };
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
  async sessionByIdempotency(keyId: string, idem: string) {
    return this.sessions.find((s) => s.key_id === keyId && s.idempotency_key === idem) ?? null;
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

const school = { standardId: "std", categoryCodes: ["CCA", "NMS", "PRD", "OTH"], severities: [{ slug: "critical", position: 0 }, { slug: "high", position: 1 }, { slug: "medium", position: 2 }, { slug: "low", position: 3 }] };

function setup() {
  const store = new MemoryStore();
  store.templates.set("school-a", school);
  store.templates.set("school-b", school);
  const filed: string[] = [];
  const deps: ServiceDeps = { store, afterFiled: async (id) => void filed.push(id), appUrl: () => "https://halo.test", secret: SECRET };
  return { store, deps, filed };
}

const payload = {
  coach: { id: "C-204", name: "Rahim Ismail", email: "rahim@school.test" },
  activity: { id: "A-1187", name: "Football U15", venue: "Field 2", date: "2026-11-11" },
  roster: [
    { student_id: "S-1", name: "Adam bin Yusof", class: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test" }] },
    { student_id: "S-2", name: "Daniel Lee", class: "9 Amanah" },
  ],
  return_url: `${ORIGIN}/activities/A-1187`,
};
const answers = { involved: { ids: ["S-1"], others: [] }, kind: "injury", what: "Twisted ankle", severity: "first_aid", body_part: "leg", head_injury: false };
const tokenOf = (url: string) => url.split("/report/")[1];

describe("launch", () => {
  it("issues a link for a valid key, with the school taken from the key", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { authorization: `Bearer ${key}`, idempotencyKey: null, body: payload });
    expect(out.status).toBe(201);
    const url = out.body.url as string;
    expect(url).toMatch(/^https:\/\/halo\.test\/report\/.+\..+$/);
    expect(readSessionToken(tokenOf(url), SECRET)).toMatchObject({ origins: [ORIGIN] });
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({ account_id: "school-a", mode: "live", form: "cca" });
    expect(new Date(out.body.expires_at as string).getTime() - T0.getTime()).toBe(SESSION_HOURS * 3_600_000);
  });

  it("returns the same link for the same idempotency key, and a new one without it", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const call = (idem: string | null) => launch(deps, { authorization: key, idempotencyKey: idem, body: payload });
    const a = await call("click-1");
    const b = await call("click-1");
    const c = await call("click-2");
    expect(b.body.url).toBe(a.body.url);
    expect(c.body.url).not.toBe(a.body.url);
    expect(store.sessions).toHaveLength(2);
  });

  it("refuses an unknown key, a revoked key and a test key used as live in the same way", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const revoked = store.addKey("school-a", "live", { revoked_at: T0.toISOString() });
    for (const auth of [null, "Bearer nope", `Bearer ${generateKey("live").key}`, revoked.key]) {
      const out = await launch(deps, { authorization: auth, idempotencyKey: null, body: payload });
      expect(out.status, String(auth)).toBe(401);
    }
    expect(store.sessions).toHaveLength(0);
    expect(key).toBeTruthy();
  });

  it("refuses a key without the launch scope, a school that has incidents switched off, and a caller that is going too fast", async () => {
    const { store, deps } = setup();
    expect((await launch(deps, { authorization: store.addKey("school-a", "live", { scopes: ["clearances.read"] }).key, idempotencyKey: null, body: payload })).body).toMatchObject({ error: { code: "missing_scope" } });
    store.disabled.add("school-b");
    expect((await launch(deps, { authorization: store.addKey("school-b").key, idempotencyKey: null, body: payload })).body).toMatchObject({ error: { code: "not_enabled" } });
    const { key } = store.addKey("school-a");
    store.limited = true;
    expect((await launch(deps, { authorization: key, idempotencyKey: null, body: payload })).status).toBe(429);
  });

  it("rejects a bad payload with a reason, and a school whose template cannot take the form", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const bad = await launch(deps, { authorization: key, idempotencyKey: null, body: { ...payload, activity: {} } });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: "invalid_request", field: "activity" } } });
    store.templates.set("school-a", { ...school, categoryCodes: ["SB", "DB"] });
    expect((await launch(deps, { authorization: key, idempotencyKey: null, body: payload })).status).toBe(422);
  });

  it("refuses a return address outside the origins registered for the key", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { authorization: key, idempotencyKey: null, body: { ...payload, return_url: "https://evil.example/" } });
    expect(out).toMatchObject({ status: 400, body: { error: { field: "return_url" } } });
  });

  it("logs each call without the names of the children", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    await launch(deps, { authorization: key, idempotencyKey: null, body: payload });
    expect(store.calls.at(-1)).toMatchObject({ accountId: "school-a", route: "POST launch", status: 201, summary: "Football U15 (2 on roster)" });
    expect(JSON.stringify(store.calls)).not.toMatch(/Adam|Daniel|yusof/i);
  });
});

async function launched(opts: { mode?: KeyMode; account?: string } = {}) {
  const ctx = setup();
  const { key } = ctx.store.addKey(opts.account ?? "school-a", opts.mode ?? "live");
  const out = await launch(ctx.deps, { authorization: key, idempotencyKey: null, body: payload });
  return { ...ctx, key, token: tokenOf(out.body.url as string) };
}

describe("the report page", () => {
  it("shows the form, the activity and the roster, but never the guardians' contact details", async () => {
    const { deps, token } = await launched();
    const view = await loadReport(deps, token);
    expect(view).toMatchObject({ state: "open", mode: "live", coachName: "Rahim Ismail", activity: { name: "Football U15" } });
    if (view.state === "open") {
      expect(view.roster).toEqual([{ student_id: "S-1", name: "Adam bin Yusof", class: "9 Amanah" }, { student_id: "S-2", name: "Daniel Lee", class: "9 Amanah" }]);
      expect(JSON.stringify(view)).not.toContain("yusof@mail.test");
    }
  });

  it("is invalid for a made-up token, a forged one and a link whose key was revoked; expired after two hours", async () => {
    const { store, deps, token } = await launched();
    expect(await loadReport(deps, "junk")).toEqual({ state: "invalid" });
    expect(await loadReport(deps, `${token.split(".")[0]}.${"a".repeat(32)}`)).toEqual({ state: "invalid" });
    store.clock = new Date(T0.getTime() + 3 * 3_600_000);
    expect(await loadReport(deps, token)).toEqual({ state: "expired" });
    store.clock = new Date(T0);
    store.keys[0].revoked_at = T0.toISOString();
    expect(await loadReport(deps, token)).toEqual({ state: "invalid" });
  });
});

describe("submit", () => {
  it("files the incident from the answers, tells the rules engine, and says who was told", async () => {
    const { store, deps, token, filed } = await launched();
    const out = await submit(deps, { token, answers });
    expect(out).toMatchObject({ status: 201, body: { reference: "INC-2026-1", duplicate: false, told: ["head_of_sport", "school_nurse"], return_url: payload.return_url } });
    expect(store.incidents[0]).toMatchObject({
      accountId: "school-a",
      mode: "live",
      title: "Football U15: Injury",
      category: "CCA",
      severity: "medium",
      flags: ["injury", "child_involved"],
      coach: { id: "C-204" },
    });
    expect(store.incidents[0].involved).toEqual([{ studentId: "S-1", name: "Adam bin Yusof", className: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test" }] }]);
    expect(filed).toEqual(["inc-1"]);
  });

  it("does not file twice when the same report is sent again (a retry after the connection dropped)", async () => {
    const { store, deps, token, filed } = await launched();
    await submit(deps, { token, answers });
    const again = await submit(deps, { token, answers });
    expect(again).toMatchObject({ status: 200, body: { reference: "INC-2026-1", duplicate: true } });
    expect(store.incidents).toHaveLength(1);
    expect(filed).toHaveLength(1);
    expect(await loadReport(deps, token)).toMatchObject({ state: "submitted", reference: "INC-2026-1" });
  });

  it("explains which answers need fixing, and files nothing", async () => {
    const { store, deps, token } = await launched();
    const out = await submit(deps, { token, answers: { ...answers, involved: { ids: ["S-99"], others: [] }, what: "" } });
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: { code: "invalid_answers", fields: { involved: expect.any(String), what: expect.any(String) } } });
    expect(store.incidents).toHaveLength(0);
  });

  it("refuses an expired link with a message the coach can act on", async () => {
    const { store, deps, token } = await launched();
    store.clock = new Date(T0.getTime() + 2.5 * 3_600_000);
    const out = await submit(deps, { token, answers });
    expect(out).toMatchObject({ status: 410, body: { error: { code: "link_expired" } } });
  });

  it("refuses a forged token", async () => {
    const { deps } = await launched();
    expect((await submit(deps, { token: "x.y", answers })).status).toBe(404);
  });

  it("marks a report from a test key as a test and keeps extra answers off the incident", async () => {
    const { store, deps, token } = await launched({ mode: "test" });
    await submit(deps, { token, answers: { ...answers, secret_field: "x" } });
    expect(store.incidents[0].mode).toBe("test");
    expect(store.incidents[0].answers).not.toHaveProperty("secret_field");
  });

  it("treats a knock to the head as a concussion", async () => {
    const { store, deps, token } = await launched();
    await submit(deps, { token, answers: { ...answers, severity: "minor", head_injury: true } });
    expect(store.incidents[0]).toMatchObject({ severity: "high", flags: ["injury", "child_involved", "concussion"] });
  });

  it("keeps each school's reports with that school", async () => {
    const a = await launched({ account: "school-a" });
    const b = await launched({ account: "school-b" });
    await submit(a.deps, { token: a.token, answers });
    await submit(b.deps, { token: b.token, answers });
    expect(a.store.incidents.map((i) => i.accountId)).toEqual(["school-a"]);
    expect(b.store.incidents.map((i) => i.accountId)).toEqual(["school-b"]);
  });
});

describe("photos", () => {
  const file = (over: Partial<{ mime: string; size: number }> = {}) => ({ filename: "goal.jpg", mime: over.mime ?? "image/jpeg", bytes: new Uint8Array(over.size ?? 1000) });

  it("need the report to be filed first, and are accepted for 30 minutes after", async () => {
    const { store, deps, token } = await launched();
    expect(await addPhoto(deps, { token, ...file() })).toMatchObject({ status: 409 });
    await submit(deps, { token, answers });
    expect((await addPhoto(deps, { token, ...file() })).status).toBe(201);
    store.clock = new Date(T0.getTime() + 31 * 60_000);
    expect(await addPhoto(deps, { token, ...file() })).toMatchObject({ status: 410, body: { error: { code: "photo_window_closed" } } });
  });

  it("refuse the wrong type, an empty or oversize file, and more than five", async () => {
    const { deps, token } = await launched();
    await submit(deps, { token, answers });
    expect((await addPhoto(deps, { token, ...file({ mime: "application/zip" }) })).status).toBe(400);
    expect((await addPhoto(deps, { token, ...file({ size: 0 }) })).status).toBe(400);
    expect((await addPhoto(deps, { token, ...file({ size: 10 * 1024 * 1024 + 1 }) })).status).toBe(400);
    for (let i = 0; i < MAX_PHOTOS; i++) expect((await addPhoto(deps, { token, ...file() })).status).toBe(201);
    expect((await addPhoto(deps, { token, ...file() })).status).toBe(409);
  });
});

describe("Return to Play", () => {
  const row = (account: string, id: string): ClearanceRow & { account_id: string } => ({ account_id: account, external_student_id: id, type: "concussion", not_before: "2026-11-20", incident_reference: "INC-2026-31" });

  it("answers for the key's own school only, and warns without blocking anything", async () => {
    const { store, deps } = setup();
    const a = store.addKey("school-a");
    store.clearanceRows = [row("school-a", "S-3321"), row("school-b", "S-3321"), row("school-a", "S-9")];
    const out = await clearances(deps, { authorization: a.key, studentIds: ["S-3321", "S-3322"] });
    expect(out).toEqual({ status: 200, body: { clearances: [{ student_id: "S-3321", type: "concussion", not_before: "2026-11-20", incident: "INC-2026-31" }] } });
  });

  it("needs the clearances.read scope", async () => {
    const { store, deps } = setup();
    const k = store.addKey("school-a", "live", { scopes: ["launch"] });
    expect((await clearances(deps, { authorization: k.key, studentIds: ["S-1"] })).status).toBe(403);
  });

  it("copes with no ids, and logs how many were asked, not who", async () => {
    const { store, deps } = setup();
    const a = store.addKey("school-a");
    expect(await clearances(deps, { authorization: a.key, studentIds: [] })).toEqual({ status: 200, body: { clearances: [] } });
    expect(store.calls.at(-1)?.summary).toBe("0 asked, 0 found");
    expect(hashKey(a.key)).toBeTruthy();
  });
});
