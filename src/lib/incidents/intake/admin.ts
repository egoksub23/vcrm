// What the admin screen for the coach portal sends and shows: creating a key, the hand-off guide the admin copies for the portal's developer.
// Pure, so each rule has a test.

import { parseOrigins, type KeyMode } from "./keys";
import { validateWebhookUrl } from "@/lib/incidents/webhooks/core";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface KeyCreate {
  mode: KeyMode;
  label: string;
  allowedOrigins: string[];
}

export function parseKeyCreate(body: unknown): Parsed<KeyCreate> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the key's details." };
  const b = body as Record<string, unknown>;
  if (b.mode !== "live" && b.mode !== "test") return { ok: false, error: "Choose a live key or a test key." };
  const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 80) : b.mode === "test" ? "Test key" : "Coach portal";
  const raw = b.allowed_origins === undefined ? [] : b.allowed_origins;
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) return { ok: false, error: "Allowed addresses must be a list." };
  const origins = parseOrigins(raw as string[]);
  if (!origins.ok) return { ok: false, error: origins.error };
  return { ok: true, value: { mode: b.mode, label, allowedOrigins: origins.origins } };
}

export function parseKeyPatch(body: unknown): Parsed<{ label?: string; allowedOrigins?: string[]; revoke?: boolean; webhookUrl?: string | null }> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the changes." };
  const b = body as Record<string, unknown>;
  const out: { label?: string; allowedOrigins?: string[]; revoke?: boolean; webhookUrl?: string | null } = {};
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
  if (b.allowed_origins !== undefined) {
    if (!Array.isArray(b.allowed_origins) || b.allowed_origins.some((o) => typeof o !== "string")) return { ok: false, error: "Allowed addresses must be a list." };
    const origins = parseOrigins(b.allowed_origins as string[]);
    if (!origins.ok) return { ok: false, error: origins.error };
    out.allowedOrigins = origins.origins;
  }
  if (b.revoke !== undefined) {
    if (b.revoke !== true) return { ok: false, error: "revoke can only be true." };
    out.revoke = true;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "Nothing to change." };
  return { ok: true, value: out };
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
    `Key:           ${key}   (given to you separately; keep it on your server, never in the page or the app)`,
    "",
    "1. Create a report link",
    `POST ${base}/api/public/incident-intake/launch`,
    "Authorization: Bearer <key>",
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
    "Errors: { \"error\": { \"code\": \"...\", \"message\": \"...\", \"field\": \"...\" } }. 400 invalid_request (read the field), 401 invalid_key, 403 missing_scope or not_enabled,",
    "422 template_not_supported, 429 rate_limited (wait and retry), 5xx try again.",
    "Guardians are optional. coach.email, coach.phone, activity.venue and return_url are optional. return_url must be on an allowed address (below).",
    "",
    "2. Open the link for the coach",
    "The link works for 2 hours, files one report, needs no cookies and no sign-in. Open it in a new tab, a web view, or an iframe:",
    "<iframe src=\"{url}\" allow=\"camera\" title=\"Report an incident\" style=\"width:100%;border:0\"></iframe>",
    "Halo only allows framing from the addresses registered for your key, currently:",
    ...(args.origins.length ? args.origins.map((o) => `  ${o}`) : ["  (none yet: ask the school admin to add your portal's address in Halo, under Incidents > Setup > Coach portal)"]),
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
    "200 OK  ->  { \"clearances\": [ { \"student_id\": \"S-3321\", \"type\": \"concussion\", \"not_before\": \"2026-11-20\", \"incident\": \"INC-2026-31\" } ] }",
    "Show a warning beside the student. Do not stop the student being added to an activity.",
    "",
    "5. Events pushed to your portal (optional, not needed to go live)",
    "If the school gives your key an events address (https, a public host name), Halo posts a signed message there when a report is filed through your links and when a",
    "return-to-play date is set or cleared. They carry a reference and codes, never names.",
    "POST <your address>   X-Halo-Event: incident.created | clearance.updated   X-Halo-Delivery: <id, the same on every retry>   X-Halo-Timestamp: <unix seconds>",
    "X-Halo-Signature: sha256=<hex HMAC-SHA256 of \"<timestamp>.<raw body>\" using the signing secret the school can show you>",
    "Check the signature and that the timestamp is within five minutes, then answer 2xx. Any other answer is retried (1, 5, 15, 60, 240 minutes), except 4xx other than 408/429 and redirects.",
    "{ \"id\": \"...\", \"event\": \"incident.created\", \"created_at\": \"...\", \"data\": { \"reference\": \"INC-2026-31\", \"category\": \"CCA\", \"severity\": \"high\", \"flags\": [\"injury\"], \"activity_id\": \"A-1187\", \"mode\": \"live\" } }",
    "{ \"id\": \"...\", \"event\": \"clearance.updated\", \"created_at\": \"...\", \"data\": { \"student_id\": \"S-3321\", \"type\": \"concussion\", \"not_before\": \"2026-11-20\", \"incident\": \"INC-2026-31\", \"cleared\": false } }",
    "",
    "Testing",
    "Use the TEST key first. A test report is marked TEST everywhere and notifies only the school's admins. Switch to the live key when the school has signed off.",
    "",
    "Rules",
    "HTTPS only. Keep the key on your server. The key can be rotated or revoked by the school at any time. Calls are rate limited per key. Photos: up to 5 per report, 10 MB each.",
    "Do not log or store the roster beyond what you already hold, and never put a student's name or id in a web address you build.",
  ].join("\n");
}
