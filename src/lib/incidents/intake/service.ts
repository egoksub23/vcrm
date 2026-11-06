// The coach-portal intake service: authenticate a key, issue a one-time report link, show the report, accept it, answer Return to Play questions.
// All database access is behind `IntakeStore`, so the rules (isolation, expiry, one report per link, test mode, idempotency) are tested in memory.
//
// Rules that matter:
//   * The school is found from the key, never from anything the caller sends.
//   * A link works for 2 hours, carries no cookie, and files at most one report; sending the same report again returns the same reference.
//   * A test key files reports marked TEST that notify only the school's admins.
//   * Nothing about a child ever goes into a URL or into an error message.

import { hashKey, keyFromHeader, modeOfKey, readSessionToken, signSessionToken, type KeyMode, type KeyScope } from "./keys";
import { CCA_FORM, deriveIncident, validateAnswers, type Answers, type FormSchema, type RosterEntry, type TemplateScale } from "./form-schema";
import { parseLaunch, type LaunchInput } from "./launch";

export const SESSION_HOURS = 2;
export const PHOTO_WINDOW_MINUTES = 30;
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export interface KeyRow {
  id: string;
  account_id: string;
  mode: KeyMode;
  scopes: string[];
  allowed_origins: string[];
  revoked_at: string | null;
}

export interface SessionRow {
  id: string;
  account_id: string;
  key_id: string;
  mode: KeyMode;
  form: string;
  coach: LaunchInput["coach"];
  activity: LaunchInput["activity"];
  roster: RosterEntry[];
  return_url: string | null;
  idempotency_key: string | null;
  expires_at: string;
  submitted_at: string | null;
  incident_id: string | null;
}

export interface NewIncident {
  accountId: string;
  mode: KeyMode;
  sessionId: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  flags: string[];
  coach: LaunchInput["coach"];
  activity: LaunchInput["activity"];
  involved: { studentId: string | null; name: string; className: string | null; guardians: NonNullable<RosterEntry["guardians"]> }[];
  answers: Answers;
}

export interface ClearanceRow {
  external_student_id: string;
  type: string;
  not_before: string;
  incident_reference: string | null;
}

export interface IntakeStore {
  findKeyByHash(hash: string): Promise<KeyRow | null>;
  touchKey(keyId: string, now: Date): Promise<void>;
  logCall(accountId: string, keyId: string | null, route: string, status: number, summary: string): Promise<void>;
  accountEnabled(accountId: string): Promise<boolean>;
  template(accountId: string): Promise<(TemplateScale & { standardId: string }) | null>;
  sessionByIdempotency(keyId: string, idem: string): Promise<SessionRow | null>;
  createSession(row: Omit<SessionRow, "submitted_at" | "incident_id">): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  getKey(id: string): Promise<KeyRow | null>;
  createIncident(input: NewIncident): Promise<{ id: string; reference: string }>;
  markSubmitted(sessionId: string, incidentId: string, now: Date): Promise<void>;
  incidentReference(incidentId: string): Promise<string | null>;
  toldRoles(incidentId: string): Promise<string[]>;
  clearances(accountId: string, studentIds: string[], today: string): Promise<ClearanceRow[]>;
  photoCount(incidentId: string): Promise<number>;
  savePhoto(args: { accountId: string; incidentId: string; filename: string; mime: string; bytes: Uint8Array }): Promise<void>;
  newId(): string;
  now(): Date;
  /** How many calls this key may make in a minute (checked by the caller's limiter). */
  rateLimit(keyId: string): boolean;
}

export interface ServiceDeps {
  store: IntakeStore;
  /** After a report is filed: run the notification rules. Never throws. */
  afterFiled: (incidentId: string) => Promise<void>;
  appUrl: () => string | null;
  secret?: string;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Reply => reply(status, { error: { code, message, ...extra } });

// ---- keys -------------------------------------------------------------------------------------------------------

type Auth = { ok: true; key: KeyRow } | { ok: false; reply: Reply };

/** Find the key a request carries, and refuse unknown, revoked or wrongly-scoped keys, a school that is switched off, and callers that are too fast. */
export async function authenticate(deps: ServiceDeps, header: string | null, scope: KeyScope, route: string): Promise<Auth> {
  const raw = keyFromHeader(header);
  if (!raw) return { ok: false, reply: err(401, "invalid_key", "Send the key as \"Authorization: Bearer ik_...\".") };
  const key = await deps.store.findKeyByHash(hashKey(raw));
  // The same answer for an unknown and a revoked key: nothing to learn by guessing.
  if (!key || key.revoked_at || key.mode !== modeOfKey(raw)) {
    return { ok: false, reply: err(401, "invalid_key", "This key is not valid.") };
  }
  if (!(await deps.store.accountEnabled(key.account_id))) {
    await deps.store.logCall(key.account_id, key.id, route, 403, "incidents switched off");
    return { ok: false, reply: err(403, "not_enabled", "Incident reporting is not switched on for this school.") };
  }
  if (!key.scopes.includes(scope)) {
    await deps.store.logCall(key.account_id, key.id, route, 403, `missing scope ${scope}`);
    return { ok: false, reply: err(403, "missing_scope", `This key cannot do that (it needs the "${scope}" scope).`) };
  }
  if (!deps.store.rateLimit(key.id)) {
    await deps.store.logCall(key.account_id, key.id, route, 429, "rate limited");
    return { ok: false, reply: err(429, "rate_limited", "Too many requests. Wait a moment and try again.") };
  }
  await deps.store.touchKey(key.id, deps.store.now());
  return { ok: true, key };
}

// ---- launch -----------------------------------------------------------------------------------------------------

/** POST /api/public/incident-intake/launch */
export async function launch(deps: ServiceDeps, args: { authorization: string | null; idempotencyKey: string | null; body: unknown }): Promise<Reply> {
  const auth = await authenticate(deps, args.authorization, "launch", "POST launch");
  if (!auth.ok) return auth.reply;
  const { key } = auth;
  const { store } = deps;

  const idem = args.idempotencyKey?.trim().slice(0, 200) || null;
  const parsed = parseLaunch(args.body, key.allowed_origins);
  if (!parsed.ok) {
    await store.logCall(key.account_id, key.id, "POST launch", 400, `invalid: ${parsed.field ?? "body"}`);
    return err(400, "invalid_request", parsed.error, parsed.field ? { field: parsed.field } : {});
  }

  const template = await store.template(key.account_id);
  const schema = formFor(parsed.value.form);
  if (!template || !schema || !supportsForm(schema, template)) {
    await store.logCall(key.account_id, key.id, "POST launch", 422, "template not supported");
    return err(422, "template_not_supported", "The school's incident template does not have the categories this report form files under. Switch the school to the School Incident Management template.");
  }

  const base = deps.appUrl();
  if (!base) return err(503, "not_configured", "Halo's public address is not configured on the server.");

  let session: SessionRow | null = idem ? await store.sessionByIdempotency(key.id, idem) : null;
  if (!session) {
    const now = store.now();
    session = await store.createSession({
      id: store.newId(),
      account_id: key.account_id,
      key_id: key.id,
      mode: key.mode,
      form: parsed.value.form,
      coach: parsed.value.coach,
      activity: parsed.value.activity,
      roster: parsed.value.roster,
      return_url: parsed.value.returnUrl,
      idempotency_key: idem,
      expires_at: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString(),
    });
  }
  const token = signSessionToken({ sessionId: session.id, origins: key.allowed_origins }, deps.secret);
  await store.logCall(key.account_id, key.id, "POST launch", 201, `${parsed.value.activity.name} (${parsed.value.roster.length} on roster)`);
  return reply(201, { url: `${base.replace(/\/+$/, "")}/report/${token}`, expires_at: session.expires_at, mode: key.mode });
}

export function formFor(id: string): FormSchema | null {
  return id === CCA_FORM.id ? CCA_FORM : null;
}

/** The form files reports under categories; the school's template must have them all. */
export function supportsForm(schema: FormSchema, template: TemplateScale): boolean {
  const codes = schema.steps.flatMap((s) => s.fields).flatMap((f) => (f.options ?? []).map((o) => o.effects?.category)).filter((c): c is string => Boolean(c));
  return codes.every((c) => template.categoryCodes.includes(c)) && template.severities.length > 0;
}

// ---- the report page --------------------------------------------------------------------------------------------

export type ReportView =
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "submitted"; reference: string; returnUrl: string | null }
  | {
      state: "open";
      schema: FormSchema;
      mode: KeyMode;
      activity: LaunchInput["activity"];
      coachName: string;
      /** Names and classes only: guardians' contact details never go to the browser. */
      roster: { student_id: string; name: string; class?: string }[];
      returnUrl: string | null;
      expiresAt: string;
    };

async function sessionFromToken(deps: ServiceDeps, token: string): Promise<{ session: SessionRow; key: KeyRow } | null> {
  const claims = readSessionToken(token, deps.secret);
  if (!claims) return null;
  const session = await deps.store.getSession(claims.sessionId);
  if (!session) return null;
  const key = await deps.store.getKey(session.key_id);
  // A key revoked after the link was issued ends the link too.
  if (!key || key.revoked_at || key.account_id !== session.account_id) return null;
  return { session, key };
}

export async function loadReport(deps: ServiceDeps, token: string): Promise<ReportView> {
  const found = await sessionFromToken(deps, token);
  if (!found) return { state: "invalid" };
  const { session } = found;
  if (session.submitted_at && session.incident_id) {
    const reference = (await deps.store.incidentReference(session.incident_id)) ?? "";
    return { state: "submitted", reference, returnUrl: session.return_url };
  }
  if (new Date(session.expires_at).getTime() < deps.store.now().getTime()) return { state: "expired" };
  const schema = formFor(session.form);
  if (!schema) return { state: "invalid" };
  return {
    state: "open",
    schema,
    mode: session.mode,
    activity: session.activity,
    coachName: session.coach.name,
    roster: session.roster.map((r) => ({ student_id: r.student_id, name: r.name, class: r.class })),
    returnUrl: session.return_url,
    expiresAt: session.expires_at,
  };
}

// ---- submit -----------------------------------------------------------------------------------------------------

/** POST /api/public/incident-report: the coach sends the report. The link is the credential. */
export async function submit(deps: ServiceDeps, args: { token: string; answers: unknown }): Promise<Reply> {
  const { store } = deps;
  const found = await sessionFromToken(deps, args.token);
  if (!found) return err(404, "invalid_link", "This link is not valid.");
  const { session, key } = found;
  if (!store.rateLimit(`submit:${session.id}`)) return err(429, "rate_limited", "Too many tries. Wait a moment and try again.");

  // Sending the same report again (a retry after a dropped connection) returns the reference it already has.
  if (session.submitted_at && session.incident_id) {
    const reference = (await store.incidentReference(session.incident_id)) ?? "";
    return reply(200, { reference, duplicate: true, told: await store.toldRoles(session.incident_id), return_url: session.return_url });
  }
  if (new Date(session.expires_at).getTime() < store.now().getTime()) {
    return err(410, "link_expired", "This link has expired. Go back to the coach portal and tap Report again.");
  }

  const schema = formFor(session.form);
  const template = await store.template(session.account_id);
  if (!schema || !template || !supportsForm(schema, template)) return err(422, "template_not_supported", "The school's incident template cannot take this report.");

  const answers = (typeof args.answers === "object" && args.answers !== null && !Array.isArray(args.answers) ? args.answers : {}) as Answers;
  const problems = validateAnswers(schema, answers, session.roster);
  if (Object.keys(problems).length > 0) return err(400, "invalid_answers", "Some answers need fixing.", { fields: problems });

  const derived = deriveIncident(schema, answers, session.roster, template);
  if (!derived.ok) return err(422, "cannot_file", derived.error);
  const d = derived.incident;

  const created = await store.createIncident({
    accountId: session.account_id,
    mode: session.mode,
    sessionId: session.id,
    title: `${session.activity.name}: ${d.kindLabel}`.slice(0, 200),
    description: d.description,
    category: d.category,
    severity: d.severity,
    flags: d.flags,
    coach: session.coach,
    activity: session.activity,
    involved: d.involved,
    answers: pickAnswers(answers),
  });
  await store.markSubmitted(session.id, created.id, store.now());
  await store.logCall(session.account_id, key.id, "POST report", 201, `${created.reference} (${session.mode})`);
  await deps.afterFiled(created.id);

  return reply(201, { reference: created.reference, duplicate: false, told: await store.toldRoles(created.id), return_url: session.return_url, mode: session.mode });
}

/** Keep only the answers the form asks for, so a crafted request cannot stuff extra data onto an incident. */
function pickAnswers(answers: Answers): Answers {
  const allowed = new Set(CCA_FORM.steps.flatMap((s) => s.fields.map((f) => f.key)));
  return Object.fromEntries(Object.entries(answers).filter(([k]) => allowed.has(k)));
}

// ---- photos -----------------------------------------------------------------------------------------------------

export function photoProblem(file: { size: number; type: string }): string | null {
  if (file.size <= 0) return "The file is empty.";
  if (file.size > MAX_PHOTO_BYTES) return "That file is too big (10 MB at most).";
  if (!PHOTO_TYPES.includes(file.type)) return "Only photos (JPEG, PNG, WebP, HEIC) and PDF files can be added.";
  return null;
}

/** POST /api/public/incident-report/photo: a photo for a report that has just been filed. Allowed for 30 minutes after sending. */
export async function addPhoto(deps: ServiceDeps, args: { token: string; filename: string; mime: string; bytes: Uint8Array }): Promise<Reply> {
  const { store } = deps;
  const found = await sessionFromToken(deps, args.token);
  if (!found) return err(404, "invalid_link", "This link is not valid.");
  const { session } = found;
  if (!session.submitted_at || !session.incident_id) return err(409, "not_filed", "Send the report first, then add photos.");
  if (store.now().getTime() - new Date(session.submitted_at).getTime() > PHOTO_WINDOW_MINUTES * 60_000) {
    return err(410, "photo_window_closed", "Photos can only be added for 30 minutes after sending. Ask the school office to attach it.");
  }
  const problem = photoProblem({ size: args.bytes.byteLength, type: args.mime });
  if (problem) return err(400, "invalid_file", problem);
  if ((await store.photoCount(session.incident_id)) >= MAX_PHOTOS) return err(409, "too_many_files", `At most ${MAX_PHOTOS} files per report.`);
  await store.savePhoto({ accountId: session.account_id, incidentId: session.incident_id, filename: args.filename, mime: args.mime, bytes: args.bytes });
  return reply(201, { ok: true });
}

// ---- Return to Play ---------------------------------------------------------------------------------------------

/** GET /api/public/clearances?student_ids=S-1,S-2 : who should not play yet. Warn only: nothing here blocks anything. */
export async function clearances(deps: ServiceDeps, args: { authorization: string | null; studentIds: string[] }): Promise<Reply> {
  const auth = await authenticate(deps, args.authorization, "clearances.read", "GET clearances");
  if (!auth.ok) return auth.reply;
  const ids = [...new Set(args.studentIds.map((s) => s.trim()).filter(Boolean))].slice(0, 200);
  const rows = ids.length ? await deps.store.clearances(auth.key.account_id, ids, deps.store.now().toISOString().slice(0, 10)) : [];
  await deps.store.logCall(auth.key.account_id, auth.key.id, "GET clearances", 200, `${ids.length} asked, ${rows.length} found`);
  return reply(200, {
    clearances: rows.map((r) => ({ student_id: r.external_student_id, type: r.type, not_before: r.not_before, incident: r.incident_reference })),
  });
}

// ---- test report (admin) ----------------------------------------------------------------------------------------

/**
 * "Send a test report": a link made by an admin, with made-up students and a test key, so the whole path (the phone page, the notices to admins, the
 * message log) can be tried without the coach portal. The key must be a test key: a test link never files a real report.
 */
export async function createTestSession(deps: ServiceDeps, key: KeyRow, coach: { name: string; email: string | null }, roster: RosterEntry[]): Promise<{ url: string; expiresAt: string } | { error: string }> {
  if (key.mode !== "test" || key.revoked_at) return { error: "Create a test key first. A test report must use a test key." };
  const base = deps.appUrl();
  if (!base) return { error: "Halo's public address is not configured on the server (NEXT_PUBLIC_SITE_URL)." };
  const template = await deps.store.template(key.account_id);
  const schema = formFor("cca");
  if (!template || !schema || !supportsForm(schema, template)) return { error: "The school's incident template does not have the categories this report form files under. Switch to the School Incident Management template." };
  const now = deps.store.now();
  const session = await deps.store.createSession({
    id: deps.store.newId(),
    account_id: key.account_id,
    key_id: key.id,
    mode: "test",
    form: "cca",
    coach: { id: "TEST-COACH", name: coach.name, email: coach.email, phone: null },
    activity: { id: "TEST-ACTIVITY", name: "Test activity", venue: "Test field", date: now.toISOString().slice(0, 10) },
    roster,
    return_url: null,
    idempotency_key: null,
    expires_at: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString(),
  });
  const token = signSessionToken({ sessionId: session.id, origins: key.allowed_origins }, deps.secret);
  return { url: `${base.replace(/\/+$/, "")}/report/${token}`, expiresAt: session.expires_at };
}
