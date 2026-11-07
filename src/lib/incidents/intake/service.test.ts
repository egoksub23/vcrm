import { describe, expect, it } from "vitest";

import { addPhoto, clearances, launch, loadReport, submit, SESSION_HOURS, MAX_PHOTOS, type ClearanceRow } from "./service";
import { CCA_FORM } from "./form-schema";
import { generateKey, hashKey, readSessionToken, type KeyMode } from "./keys";
import { ORIGIN, SECRET, T0, answers, groupOf, payload, school, setup, tokenOf } from "./testing";

describe("launch", () => {
  it("issues a link for a valid key, with the school taken from the key", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { group: groupOf("school-a"), authorization: `Bearer ${key}`, idempotencyKey: null, body: payload });
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
    const call = (idem: string | null) => launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: idem, body: payload });
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
      const out = await launch(deps, { group: groupOf("school-a"), authorization: auth, idempotencyKey: null, body: payload });
      expect(out.status, String(auth)).toBe(401);
    }
    expect(store.sessions).toHaveLength(0);
    expect(key).toBeTruthy();
  });

  it("refuses a key without the launch scope, a school that has incidents switched off, and a caller that is going too fast", async () => {
    const { store, deps } = setup();
    expect((await launch(deps, { group: groupOf("school-a"), authorization: store.addKey("school-a", "live", { scopes: ["clearances.read"] }).key, idempotencyKey: null, body: payload })).body).toMatchObject({ error: { code: "missing_scope" } });
    store.disabled.add("school-b");
    expect((await launch(deps, { group: groupOf("school-b"), authorization: store.addKey("school-b").key, idempotencyKey: null, body: payload })).body).toMatchObject({ error: { code: "not_enabled" } });
    const { key } = store.addKey("school-a");
    store.limited = true;
    expect((await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload })).status).toBe(429);
  });

  it("rejects a bad payload with a reason, and a school whose template cannot take the form", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const bad = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: { ...payload, activity: {} } });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: "invalid_request", field: "activity" } } });
    store.templates.set("school-a", { ...school, categoryCodes: ["SB", "DB"] });
    expect((await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload })).status).toBe(422);
  });

  it("refuses a return address outside the origins registered for the key", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: { ...payload, return_url: "https://evil.example/" } });
    expect(out).toMatchObject({ status: 400, body: { error: { field: "return_url" } } });
  });

  it("logs each call without the names of the children", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload });
    expect(store.calls.at(-1)).toMatchObject({ accountId: "school-a", route: "POST launch", status: 201, summary: "Football U15 (2 on roster)" });
    expect(JSON.stringify(store.calls)).not.toMatch(/Adam|Daniel|yusof/i);
  });
});

async function launched(opts: { mode?: KeyMode; account?: string } = {}) {
  const ctx = setup();
  const { key } = ctx.store.addKey(opts.account ?? "school-a", opts.mode ?? "live");
  const out = await launch(ctx.deps, { group: groupOf(opts.account ?? "school-a"), authorization: key, idempotencyKey: null, body: payload });
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
    const out = await clearances(deps, { group: groupOf("school-a"), authorization: a.key, studentIds: ["S-3321", "S-3322"] });
    expect(out).toEqual({ status: 200, body: { clearances: [{ student_id: "S-3321", type: "concussion", not_before: "2026-11-20", incident: "INC-2026-31" }] } });
  });

  it("needs the clearances.read scope", async () => {
    const { store, deps } = setup();
    const k = store.addKey("school-a", "live", { scopes: ["launch"] });
    expect((await clearances(deps, { group: groupOf("school-a"), authorization: k.key, studentIds: ["S-1"] })).status).toBe(403);
  });

  it("copes with no ids, and logs how many were asked, not who", async () => {
    const { store, deps } = setup();
    const a = store.addKey("school-a");
    expect(await clearances(deps, { group: groupOf("school-a"), authorization: a.key, studentIds: [] })).toEqual({ status: 200, body: { clearances: [] } });
    expect(store.calls.at(-1)?.summary).toBe("0 asked, 0 found");
    expect(hashKey(a.key)).toBeTruthy();
  });
});

describe("versioned forms", () => {
  const withExtra = (version: number, label: string) => {
    const schema = JSON.parse(JSON.stringify(CCA_FORM)) as typeof CCA_FORM;
    schema.steps[1].fields.push({ key: "venue_note", type: "text", label: { en: label }, required: true });
    return { version, schema };
  };

  it("uses the school's published form for new links and records the version on the link and the incident", async () => {
    const { store, deps } = setup();
    store.forms.set("school-a", [withExtra(1, "Where on the field?")]);
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload });
    const token = tokenOf(out.body.url as string);
    expect(store.sessions[0].form_version).toBe(1);
    const view = await loadReport(deps, token);
    expect(view.state === "open" && view.schema.steps[1].fields.some((f) => f.key === "venue_note")).toBe(true);

    const missing = await submit(deps, { token, answers });
    expect(missing.body).toMatchObject({ error: { code: "invalid_answers", fields: { venue_note: expect.any(String) } } });
    const ok = await submit(deps, { token, answers: { ...answers, venue_note: "Near the left goal" } });
    expect(ok.status).toBe(201);
    expect(store.incidents[0]).toMatchObject({ formVersion: 1 });
    expect(store.incidents[0].answers).toMatchObject({ venue_note: "Near the left goal" });
  });

  it("keeps a link on the version it was issued with when a newer one is published", async () => {
    const { store, deps } = setup();
    store.forms.set("school-a", [withExtra(1, "Where on the field?")]);
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload });
    const token = tokenOf(out.body.url as string);
    store.forms.set("school-a", [withExtra(1, "Where on the field?"), withExtra(2, "Which pitch?")]);
    const view = await loadReport(deps, token);
    expect(view.state === "open" && view.schema.steps[1].fields.at(-1)?.label.en).toBe("Where on the field?");
    // a new link gets the new version
    const next = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload });
    const v2 = await loadReport(deps, tokenOf(next.body.url as string));
    expect(v2.state === "open" && v2.schema.steps[1].fields.at(-1)?.label.en).toBe("Which pitch?");
  });

  it("falls back to the built-in form for a school that has published nothing, and drops answers the form never asked", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const out = await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload });
    expect(store.sessions[0].form_version).toBeNull();
    await submit(deps, { token: tokenOf(out.body.url as string), answers: { ...answers, venue_note: "x" } });
    expect(store.incidents[0].formVersion).toBeNull();
    expect(store.incidents[0].answers).not.toHaveProperty("venue_note");
  });

  it("refuses a form that files under a category the school's template does not have", async () => {
    const { store, deps } = setup();
    store.forms.set("school-a", [withExtra(1, "x")]);
    store.templates.set("school-a", { ...school, categoryCodes: ["SB"] });
    const { key } = store.addKey("school-a");
    expect((await launch(deps, { group: groupOf("school-a"), authorization: key, idempotencyKey: null, body: payload })).status).toBe(422);
  });
});

describe("one platform key, the school named by its Vircle Group ID", () => {
  const go = (deps: ReturnType<typeof setup>["deps"], key: string, group: string | null, extra: Record<string, unknown> = {}) =>
    launch(deps, { authorization: key, group, idempotencyKey: null, body: { ...payload, ...extra } });

  it("needs the Group ID on every call", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    for (const group of [null, "", "   ", "x".repeat(101)]) {
      const out = await go(deps, key, group);
      expect(out.status, String(group)).toBe(400);
      expect(out.body).toMatchObject({ error: { code: "group_required" } });
    }
  });
  it("refuses a Group ID the operator has not mapped, and one that is switched off", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    const unknown = await go(deps, key, "G-nobody");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: "unknown_group" } });
    store.addSchool("school-a", { enabled: false });
    expect((await go(deps, key, groupOf("school-a"))).status).toBe(404);
  });
  it("serves any mapped school with the same key, each in its own school and with its own frame origins", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    store.addSchool("school-b", { allowed_origins: ["https://other.example.edu.my"] });
    const a = await go(deps, key, groupOf("school-a"));
    const b = await go(deps, key, groupOf("school-b"), { return_url: "https://other.example.edu.my/activities/A-1187" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(store.sessions.map((s) => [s.account_id, s.group_id])).toEqual([["school-a", groupOf("school-a")], ["school-b", groupOf("school-b")]]);
    expect(readSessionToken(tokenOf(a.body.url as string), SECRET)?.origins).toEqual([ORIGIN]);
    expect(readSessionToken(tokenOf(b.body.url as string), SECRET)?.origins).toEqual(["https://other.example.edu.my"]);
    // school A's address is not good enough for school B's return link
    const wrong = await go(deps, key, groupOf("school-b"), { return_url: `${ORIGIN}/activities/A-1187` });
    expect(wrong.status).toBe(400);
  });
  it("matches a repeated tap within a school, so two schools can use the same idempotency string", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    store.addSchool("school-b");
    const call = (group: string) => launch(deps, { authorization: key, group, idempotencyKey: "tap-1", body: payload });
    const a1 = await call(groupOf("school-a"));
    const a2 = await call(groupOf("school-a"));
    const b1 = await call(groupOf("school-b"));
    expect(a2.body.url).toBe(a1.body.url);
    expect(b1.body.url).not.toBe(a1.body.url);
    expect(store.sessions).toHaveLength(2);
  });
  it("does not accept a key tied to one school, which is how keys worked before", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a", "live", { account_id: "school-a" });
    const out = await go(deps, key, groupOf("school-a"));
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ error: { code: "invalid_key" } });
  });
  it("limits each school separately, so one busy school cannot use up the key's allowance", async () => {
    const { store, deps } = setup();
    const seen: string[] = [];
    store.rateLimit = ((id: string) => (seen.push(id), true)) as typeof store.rateLimit;
    const { key } = store.addKey("school-a");
    store.addSchool("school-b");
    await go(deps, key, groupOf("school-a"));
    await go(deps, key, groupOf("school-b"));
    expect(new Set(seen).size).toBe(2);
  });
  it("ends a school's open links when the school is switched off or mapped to a different school, but not another school's", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    store.addSchool("school-b");
    const a = tokenOf((await go(deps, key, groupOf("school-a"))).body.url as string);
    const b = tokenOf((await go(deps, key, groupOf("school-b"))).body.url as string);
    expect((await loadReport(deps, a)).state).toBe("open");
    store.addSchool("school-a", { enabled: false });
    expect((await loadReport(deps, a)).state).toBe("invalid");
    expect((await loadReport(deps, b)).state).toBe("open");
    store.addSchool("school-a", { enabled: true, account_id: "school-b" });
    expect((await loadReport(deps, a)).state).toBe("invalid");
  });
  it("answers Return to Play for the named school only", async () => {
    const { store, deps } = setup();
    const { key } = store.addKey("school-a");
    store.addSchool("school-b");
    const row: ClearanceRow & { account_id: string } = { account_id: "school-b", external_student_id: "S-9", type: "injury", not_before: "2026-12-01", incident_reference: null };
    store.clearanceRows.push(row);
    const asA = await clearances(deps, { authorization: key, group: groupOf("school-a"), studentIds: ["S-9"] });
    const asB = await clearances(deps, { authorization: key, group: groupOf("school-b"), studentIds: ["S-9"] });
    expect(asA.body).toEqual({ clearances: [] });
    expect((asB.body.clearances as unknown[]).length).toBe(1);
  });
});
