#!/usr/bin/env node
// A simulated coach portal. It calls Halo exactly as the real portal will (docs/incident-coach-portal.md), so the whole path can be tried before the real
// portal exists: ask for a report link, optionally file a sample report through the hosted page's own API, then read the Return to Play warnings.
//
//   node scripts/incident-sim-portal.mjs --base https://halo.example.edu.my --key ik_test_xxxxxxxx [--submit] [--origin https://coach.example.edu.my]
//
// Use a TEST key. A test report is marked TEST and tells only the school's admins. Nothing here prints the key, and the sample students are made up.

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const base = String(opt("base", process.env.HALO_BASE ?? "")).replace(/\/+$/, "");
const key = String(opt("key", process.env.HALO_INTAKE_KEY ?? ""));
const origin = opt("origin", null);
if (!base || !key) {
  console.error("Usage: node scripts/incident-sim-portal.mjs --base <halo address> --key <ik_test_...> [--submit] [--origin <portal address>]");
  process.exit(2);
}
if (key.startsWith("ik_live_") && !flag("allow-live")) {
  console.error("This is a LIVE key. A live report tells real people. Use a test key, or pass --allow-live if you really mean it.");
  process.exit(2);
}

const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed += 1;
};

const clickId = `sim-${Date.now()}`;
const launchBody = {
  form: "cca",
  coach: { id: "SIM-COACH", name: "Simulated Coach", email: "sim-coach@example.test" },
  activity: { id: "SIM-ACT", name: "Simulated football", venue: "Field 2", date: new Date().toISOString().slice(0, 10) },
  roster: [
    { student_id: "SIM-1", name: "Test Student A", class: "Test class", guardians: [{ name: "Test Guardian", email: "guardian@example.test" }] },
    { student_id: "SIM-2", name: "Test Student B", class: "Test class" },
  ],
  ...(origin ? { return_url: `${origin}/activities/SIM-ACT` } : {}),
};

async function call(method, path, body, headers = auth) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 1. Ask for a link.
const first = await call("POST", "/api/public/incident-intake/launch", launchBody, { ...auth, "Idempotency-Key": clickId });
check(first.status === 201 && typeof first.json.url === "string", "launch returns a link", `status ${first.status}`);
if (first.status !== 201) {
  console.error(JSON.stringify(first.json));
  process.exit(1);
}
check(first.json.url.startsWith(base), "the link is on Halo's address");

// 2. The same click again returns the same link.
const again = await call("POST", "/api/public/incident-intake/launch", launchBody, { ...auth, "Idempotency-Key": clickId });
check(again.json.url === first.json.url, "the same Idempotency-Key returns the same link");

// 3. A bad key is refused.
const bad = await call("POST", "/api/public/incident-intake/launch", launchBody, { Authorization: "Bearer ik_test_invalidinvalidinvalidinvalidinvalidinvalid1", "Content-Type": "application/json" });
check(bad.status === 401, "a wrong key is refused", `status ${bad.status}`);

// 4. A broken payload is explained.
const broken = await call("POST", "/api/public/incident-intake/launch", { ...launchBody, activity: {} });
check(broken.status === 400 && broken.json?.error?.code === "invalid_request", "a broken payload gets a plain reason", broken.json?.error?.field);

// 5. Open the link the way a browser would: the page must load without a cookie and may only be framed by the registered origin.
const page = await fetch(first.json.url, { redirect: "manual" });
check(page.status === 200, "the report page opens", `status ${page.status}`);
check(!page.headers.get("set-cookie"), "the report page sets no cookie");
const csp = page.headers.get("content-security-policy") ?? "";
check(csp.startsWith("frame-ancestors"), "the report page says who may frame it", csp);
check(!page.headers.get("x-frame-options"), "the report page has no X-Frame-Options (it would block the portal's frame)");

// 6. File a sample report through the same API the page uses.
if (flag("submit")) {
  const token = first.json.url.split("/report/")[1];
  const answers = { involved: { ids: ["SIM-1"], others: [] }, kind: "injury", what: "Simulated: twisted ankle during a drill", severity: "first_aid", body_part: "leg", head_injury: false };
  const sent = await call("POST", "/api/public/incident-report", { token, answers }, { "Content-Type": "application/json" });
  check(sent.status === 201 && typeof sent.json.reference === "string", "the report is filed", sent.json.reference ?? `status ${sent.status}`);
  const dup = await call("POST", "/api/public/incident-report", { token, answers }, { "Content-Type": "application/json" });
  check(dup.status === 200 && dup.json.duplicate === true, "sending it again does not file a second report");
  console.log(`      told: ${(sent.json.told ?? []).join(", ") || "(nobody: no rules are switched on yet)"}`);
}

// 7. Return to Play.
const clr = await call("GET", "/api/public/clearances?student_ids=SIM-1,SIM-2", null, { Authorization: `Bearer ${key}` });
check(clr.status === 200 && Array.isArray(clr.json.clearances), "clearances answers", `${clr.json.clearances?.length ?? 0} warning(s)`);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
console.log(`Open the test report: ${first.json.url}`);
process.exit(failed === 0 ? 0 : 1);
