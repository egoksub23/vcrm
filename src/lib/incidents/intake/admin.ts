// What the operator console's coach-portal card sends and shows: creating the platform key, mapping a Vircle Group to a school, the hand-off guide the
// operator copies for the portal's developer.
// Pure, so each rule has a test.

import { parseOrigins, type KeyMode } from "./keys";
import { validateWebhookUrl } from "@/lib/incidents/webhooks/core";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface KeyCreate {
  mode: KeyMode;
  label: string;
}

/** The platform key: live or test, with a name. Which addresses may frame the report is a school's setting (see parseSchool), not the key's. */
export function parseKeyCreate(body: unknown): Parsed<KeyCreate> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the key's details." };
  const b = body as Record<string, unknown>;
  if (b.mode !== "live" && b.mode !== "test") return { ok: false, error: "Choose a live key or a test key." };
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 80) : b.mode === "test" ? "Test key" : "Coach portal";
  return { ok: true, value: { mode: b.mode, label } };
}

export function parseKeyPatch(body: unknown): Parsed<{ label?: string; revoke?: boolean; webhookUrl?: string | null }> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the changes." };
  const b = body as Record<string, unknown>;
  const out: { label?: string; revoke?: boolean; webhookUrl?: string | null } = {};
  if (b.webhook_url !== undefined) {
    if (b.webhook_url === null || b.webhook_url === "") out.webhookUrl = null;
    else if (typeof b.webhook_url !== "string") return { ok: false, error: "The events address must be text." };
    else {
      const checked = validateWebhookUrl(b.webhook_url);
      if (!checked.ok) return { ok: false, error: checked.error };
      out.webhookUrl = checked.url;
    }
  }
  if (b.label !== undefined) {
    if (typeof b.label !== "string" || !b.label.trim()) return { ok: false, error: "Give the key a name." };
    out.label = b.label.trim().slice(0, 80);
  }
  if (b.revoke !== undefined) {
    if (b.revoke !== true) return { ok: false, error: "revoke can only be true." };
    out.revoke = true;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
}

export interface SchoolInput {
  groupId: string;
  groupName: string;
  accountId: string;
  allowedOrigins: string[];
  enabled: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Vircle Group mapped to a Halo school: the portal's id and name for it, the school, the addresses allowed to frame its report page, and on or off. */
export function parseSchool(body: unknown): Parsed<SchoolInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the school's details." };
  const b = body as Record<string, unknown>;
  const groupId = typeof b.group_id === "string" ? b.group_id.trim() : "";
  if (!groupId || groupId.length > 100) return { ok: false, error: "Enter the Vircle Group ID (up to 100 characters)." };
  const groupName = typeof b.group_name === "string" ? b.group_name.trim() : "";
  if (!groupName || groupName.length > 200) return { ok: false, error: "Enter the Vircle Group Name (up to 200 characters)." };
  if (typeof b.account_id !== "string" || !UUID.test(b.account_id)) return { ok: false, error: "Choose the Halo school this group belongs to." };
  const raw = b.allowed_origins === undefined ? [] : b.allowed_origins;
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) return { ok: false, error: "Allowed addresses must be a list." };
  const origins = parseOrigins(raw as string[]);
  if (!origins.ok) return { ok: false, error: origins.error };
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { ok: false, error: "Say whether the school is switched on or off." };
  return { ok: true, value: { groupId, groupName, accountId: b.account_id, allowedOrigins: origins.origins, enabled: b.enabled !== false } };
}

/** The sample roster for "Send a test report": made-up names, so no real child is ever used for a test. */
export const TEST_ROSTER = [
  { student_id: "TEST-1", name: "Test Student A", class: "Test class" },
  { student_id: "TEST-2", name: "Test Student B", class: "Test class" },
];

/**
 * The page an admin copies and sends to whoever builds the coach portal. It never contains a key (keys are shown once, at creation); it says where to
 * put it. `address` is Halo's public address for this deployment, or null when it has not been set.
 */
export function buildHandoffGuide(args: { address: string | null; keyPrefix: string | null; origins: readonly string[] }): string {
  const base = args.address ? args.address.replace(/\/+$/, "") : "https://<halo-address>";
  const key = args.keyPrefix ? `${args.keyPrefix}…` : "ik_live_xxxxxxxx";
  const origin = args.origins[0] ?? "https://<your-portal-address>";
  return [
    "HALO INCIDENT REPORTING: HAND-OFF FOR THE COACH PORTAL",
    "",
    "What you build",
    "A \"Report incident\" button in the coach portal. When a coach taps it, the portal's SERVER asks Halo for a one-time link, then opens that link for the coach",
    "(in a new tab, an iframe or a web view). The student list is sent server to server, so student names never appear in a web address.",
    "",
    `Halo address:  ${base}   (use the url Halo returns; never build the link yourself)`,
    `Key:           ${key}   (one key for the whole platform, given to you separately; keep it on your server, never in the page or the app)`,
    "School:        every call names the school by its Vircle Group ID in the X-Vircle-Group-Id header. The Halo administrator maps each Vircle Group to its school once,",
    "               at launch (Group ID, Group Name, and the web addresses your portal runs on). A Group that is not mapped, or is switched off, is refused.",
    "",
    "1. Create a report link",
    `POST ${base}/api/public/incident-intake/launch`,
    "Authorization: Bearer <key>",
    "X-Vircle-Group-Id: <the school's Vircle Group ID>",
    "Idempotency-Key: <your own id for this tap, so a retry returns the same link>",
    "Content-Type: application/json",
    "",
    "{",
    "  \"form\": \"cca\",",
    "  \"coach\":    { \"id\": \"C-204\", \"name\": \"Rahim Ismail\", \"email\": \"rahim@school.test\", \"phone\": \"+60120000001\" },",
    "  \"activity\": { \"id\": \"A-1187\", \"name\": \"Football U15\", \"venue\": \"Field 2\", \"date\": \"2026-11-11\" },",
    "  \"roster\": [",
    "    { \"student_id\": \"S-3321\", \"name\": \"Adam bin Yusof\", \"class\": \"9 Amanah\",",
    "      \"guardians\": [ { \"name\": \"Yusof Ali\", \"email\": \"yusof@mail.test\", \"phone\": \"+60121110000\" } ] }",
    "  ],",
    `  "return_url": "${origin}/activities/A-1187"`,
    "}",
    "",
    "201 Created  ->  { \"url\": \"<link>\", \"expires_at\": \"...\", \"mode\": \"live\" }",
    "Errors: { \"error\": { \"code\": \"...\", \"message\": \"...\", \"field\": \"...\" } }. 400 invalid_request (read the field) or group_required, 401 invalid_key, 404 unknown_group,",
    "403 missing_scope or not_enabled,",
    "422 template_not_supported, 429 rate_limited (wait and retry), 5xx try again.",
    "coach.id, coach.name and coach.email are required (the report is addressed to this coach). Guardians, coach.phone, activity.venue and return_url are optional. return_url must be on an allowed address (below).",
    "",
    "2. Open the link for the coach",
    "The link works for 2 hours, files one report, needs no cookies and no sign-in. Open it in a new tab, a web view, or an iframe:",
    "<iframe src=\"{url}\" allow=\"camera\" title=\"Report an incident\" style=\"width:100%;border:0\"></iframe>",
    "Halo only allows framing from the addresses the Halo administrator registered for that Vircle Group, for example:",
    ...(args.origins.length ? args.origins.map((o) => `  ${o}`) : ["  (none yet: ask the Halo administrator to add your portal's address for the Vircle Group)"]),
    "",
    "3. Listen for the page's messages (window.postMessage, always check event.origin is Halo's address)",
    "{ \"source\": \"halo-incident\", \"type\": \"ready\" }",
    "{ \"source\": \"halo-incident\", \"type\": \"resize\", \"height\": 640 }          set the frame's height to this so the page never needs a second scrollbar",
    "{ \"source\": \"halo-incident\", \"type\": \"submitted\", \"reference\": \"INC-2026-31\" }   close the frame or return the coach to the activity",
    "{ \"source\": \"halo-incident\", \"type\": \"error\", \"code\": \"link_expired\" }       call launch again and reopen",
    "Web views: turn on JavaScript and DOM storage; allow the file chooser and the camera (Android: handle onShowFileChooser; iOS: add a camera usage description).",
    "If the camera is not available the photo button falls back to the phone's file picker.",
    "",
    "4. Show a Return to Play warning (optional, never block anyone)",
    `GET ${base}/api/public/clearances?student_ids=S-3321,S-3322`,
    "Authorization: Bearer <key>",
    "X-Vircle-Group-Id: <the school's Vircle Group ID>",
    "200 OK  ->  { \"clearances\": [ { \"student_id\": \"S-3321\", \"type\": \"concussion\", \"not_before\": \"2026-11-20\", \"incident\": \"INC-2026-31\" } ] }",
    "Show a warning beside the student. Do not stop the student being added to an activity.",
    "",
    "5. Events pushed to your portal (optional, not needed to go live)",
    "If the Halo administrator gives your key an events address (https, a public host name), Halo posts a signed message there when a report is filed through your links",
    "and when a return-to-play date is set or cleared. Each carries data.group_id (the Vircle Group ID) so you know which school it is for, plus a reference and codes, never names.",
    "POST <your address>   X-Halo-Event: incident.created | clearance.updated   X-Halo-Delivery: <id, the same on every retry>   X-Halo-Timestamp: <unix seconds>",
    "X-Halo-Signature: sha256=<hex HMAC-SHA256 of \"<timestamp>.<raw body>\" using the signing secret the school can show you>",
    "Check the signature and that the timestamp is within five minutes, then answer 2xx. Any other answer is retried (1, 5, 15, 60, 240 minutes), except 4xx other than 408/429 and redirects.",
    "{ \"id\": \"...\", \"event\": \"incident.created\", \"created_at\": \"...\", \"data\": { \"group_id\": \"G-12\", \"reference\": \"INC-2026-31\", \"category\": \"CCA\", \"severity\": \"high\", \"flags\": [\"injury\"], \"activity_id\": \"A-1187\", \"mode\": \"live\" } }",
    "{ \"id\": \"...\", \"event\": \"clearance.updated\", \"created_at\": \"...\", \"data\": { \"group_id\": \"G-12\", \"student_id\": \"S-3321\", \"type\": \"concussion\", \"not_before\": \"2026-11-20\", \"incident\": \"INC-2026-31\", \"cleared\": false } }",
    "",
    "Testing",
    "Use the TEST key first. A test report is marked TEST everywhere and notifies only the school's admins. Switch to the live key when the school has signed off.",
    "",
    "Rules",
    "HTTPS only. Keep the key on your server. The key can be rotated or revoked by the Halo administrator at any time. Calls are rate limited per school. Photos: up to 5 per report, 10 MB each.",
    "Do not log or store the roster beyond what you already hold, and never put a student's name or id in a web address you build.",
  ].join("\n");
}
