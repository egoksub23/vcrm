// The warnings about a certificate that is about to end: which warning applies on which day, that each goes out once,
// who is told, and what is left alone (a certificate Halo made, one that is no longer in use, a workspace with Doc Sign off).

import { beforeEach, describe, expect, it } from "vitest";

import { EXPIRY_THRESHOLDS, expiryThreshold, runCertificateWatch, shouldWarn, warningText } from "./certificate-watch";
import { runAll } from "./jobs";
import { FakeDb } from "./fake-db";

const DAY = 24 * 3600 * 1000;
const ACCT = "11111111-1111-4111-8111-111111111111";
const OWNER = "u-owner";
const ADMIN = "u-admin";
const AGENT = "u-agent";
let NOW = new Date("2026-10-06T08:00:00Z");

const after = (days: number, extraMs = 0) => new Date(NOW.getTime() + days * DAY + extraMs);

describe("expiryThreshold", () => {
  it("picks the warning that applies: 30, 14 or 7 days before, and 0 once it has ended", () => {
    const at = (days: number, ms = 0) => expiryThreshold(after(days, ms), NOW);
    expect(at(60)).toBeNull();
    expect(at(31)).toBeNull();
    expect(at(30, 1000)).toBeNull(); // a moment over 30 days still counts as 31 days away
    expect(at(30)).toBe(30);
    expect(at(20)).toBe(30);
    expect(at(14)).toBe(14);
    expect(at(8)).toBe(14);
    expect(at(7)).toBe(7);
    expect(at(1)).toBe(7);
    expect(at(0, 1000)).toBe(7);
    expect(at(0)).toBe(0);
    expect(at(-3)).toBe(0);
    expect(EXPIRY_THRESHOLDS).toEqual([30, 14, 7]);
  });

  it("calls the last day 'ends in 7' territory only until the moment it ends", () => {
    expect(expiryThreshold(new Date(NOW.getTime() + 1), NOW)).toBe(7);
    expect(expiryThreshold(new Date(NOW.getTime()), NOW)).toBe(0);
  });
});

describe("shouldWarn", () => {
  it("warns when there is a warning that is a step nearer than the last one sent", () => {
    expect(shouldWarn(null, null)).toBe(false);
    expect(shouldWarn(30, null)).toBe(true);
    expect(shouldWarn(30, 30)).toBe(false);
    expect(shouldWarn(14, 30)).toBe(true);
    expect(shouldWarn(30, 14)).toBe(false);
    expect(shouldWarn(0, 7)).toBe(true);
    expect(shouldWarn(0, 0)).toBe(false);
    expect(shouldWarn(7, undefined)).toBe(true);
  });
});

describe("warningText", () => {
  it("says what ends, when, and what to do", () => {
    const soon = warningText(14, new Date("2026-10-20T00:00:00Z"), "Kedai Runcit Ali Sdn Bhd, MY");
    expect(soon.title).toBe("Sealing certificate ends in 14 days");
    expect(soon.body).toContain("2026-10-20");
    expect(soon.body).toContain("Kedai Runcit Ali Sdn Bhd");
    expect(soon.body).toContain("Settings > Secure Sign > Sealing certificate");
    const gone = warningText(0, new Date("2026-10-01T00:00:00Z"), null);
    expect(gone.title).toBe("Sealing certificate has expired");
    expect(gone.body).toContain("wait, unsealed");
  });
});

let db: FakeDb;
function run() {
  return runCertificateWatch({ admin: db.client(), origin: "https://halo.test", deps: {} as never, now: () => NOW });
}

function cert(over: Record<string, unknown> = {}) {
  db.seed("sign_certificates", [{ id: "c1", account_id: ACCT, name: "Uploaded: Kedai", subject: "Kedai Runcit Ali Sdn Bhd, MY", valid_until: after(20).toISOString(), is_default: true, source: "uploaded", expiry_notified_days: null, p12_enc: "x", passphrase_enc: "y", ...over }]);
}
const notes = () => db.rows("notifications");
const marker = () => db.rows("sign_certificates")[0].expiry_notified_days;

beforeEach(() => {
  NOW = new Date("2026-10-06T08:00:00Z");
  db = new FakeDb();
  db.seed("profiles", [
    { user_id: OWNER, account_id: ACCT, account_role: "owner" },
    { user_id: ADMIN, account_id: ACCT, account_role: "admin" },
    { user_id: AGENT, account_id: ACCT, account_role: "agent" },
  ]);
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features: { sign: true }, limits: {} }]);
});

describe("runCertificateWatch", () => {
  it("tells the owner and admins, not the agents, and only once for each warning", async () => {
    cert({ valid_until: after(29).toISOString() });
    expect(await run()).toEqual({ checked: 1, notified: 1 });
    expect(notes().map((n) => n.user_id).sort()).toEqual([ADMIN, OWNER]);
    expect(notes()[0]).toMatchObject({ account_id: ACCT, type: "sign_certificate_expiring", title: "Sealing certificate ends in 30 days" });
    expect(marker()).toBe(30);
    // every later run in the same window says nothing more
    expect(await run()).toEqual({ checked: 1, notified: 0 });
    NOW = after(10);
    expect(await run()).toEqual({ checked: 1, notified: 0 }); // 19 days left: still the 30-day warning
    expect(notes()).toHaveLength(2);
  });

  it("goes on to 14 days, 7 days and the day it ends, one notification each", async () => {
    cert({ valid_until: after(20).toISOString(), expiry_notified_days: 30 });
    const validUntil = new Date(db.rows("sign_certificates")[0].valid_until as string);
    const titles: string[] = [];
    for (const [at, expected] of [
      [validUntil.getTime() - 15 * DAY, 0],
      [validUntil.getTime() - 13 * DAY, 2],
      [validUntil.getTime() - 12 * DAY, 2],
      [validUntil.getTime() - 6 * DAY, 4],
      [validUntil.getTime() - 5 * DAY, 4],
      [validUntil.getTime() + DAY, 6],
      [validUntil.getTime() + 20 * DAY, 6],
    ] as const) {
      NOW = new Date(at);
      await run();
      expect(notes().length, `at ${new Date(at).toISOString()}`).toBe(expected);
      titles.push(...notes().slice(titles.length).map((n) => String(n.title)));
    }
    expect(titles).toEqual(["Sealing certificate ends in 14 days", "Sealing certificate ends in 14 days", "Sealing certificate ends in 7 days", "Sealing certificate ends in 7 days", "Sealing certificate has expired", "Sealing certificate has expired"]);
    expect(marker()).toBe(0);
  });

  it("starts at the nearest warning when the job was not running earlier (no run of old warnings)", async () => {
    cert({ valid_until: after(5).toISOString() });
    await run();
    expect(notes().map((n) => n.title)).toEqual(["Sealing certificate ends in 7 days", "Sealing certificate ends in 7 days"]);
    expect(marker()).toBe(7);
  });

  it("says nothing about a certificate that is far from ending, one Halo made, or one that is no longer the default", async () => {
    cert({ id: "far", valid_until: after(90).toISOString() });
    cert({ id: "halo", valid_until: after(3).toISOString(), source: "generated" });
    cert({ id: "old", valid_until: after(3).toISOString(), is_default: false });
    expect(await run()).toEqual({ checked: 0, notified: 0 });
    expect(notes()).toHaveLength(0);
  });

  it("stays quiet for a workspace whose Secure Sign is off or suspended", async () => {
    db.tables.account_platform = [{ account_id: ACCT, status: "active", features: { sign: false }, limits: {} }];
    cert({ valid_until: after(3).toISOString() });
    expect(await run()).toEqual({ checked: 1, notified: 0 });
    expect(notes()).toHaveLength(0);
    expect(marker()).toBeNull();
  });

  it("lets only one of two runs at the same moment send the warning", async () => {
    cert({ valid_until: after(3).toISOString() });
    const both = await Promise.all([run(), run()]);
    expect(both.reduce((n, r) => n + r.notified, 0)).toBe(1);
    expect(notes()).toHaveLength(2);
  });

  it("gives the warning back when it could not be delivered, so the next run tries again", async () => {
    cert({ valid_until: after(3).toISOString() });
    db.failNext.notifications = "insert failed";
    expect(await run()).toEqual({ checked: 1, notified: 0 });
    expect(marker()).toBeNull();
    expect(await run()).toEqual({ checked: 1, notified: 1 });
    expect(marker()).toBe(7);
  });

  it("does not warn at all when nobody holds the capability, and does not keep trying", async () => {
    db.tables.profiles = [{ user_id: AGENT, account_id: ACCT, account_role: "agent" }];
    cert({ valid_until: after(3).toISOString() });
    expect(await run()).toEqual({ checked: 1, notified: 0 });
    expect(notes()).toHaveLength(0);
    expect(marker()).toBe(7);
  });

  it("runs as part of the Secure Sign job", async () => {
    db.rpcHandlers.sign_claim_sealing = async () => ({ data: [], error: null });
    db.rpcHandlers.sign_expire_due = async () => ({ data: [], error: null });
    db.rpcHandlers.sign_bulk_claim = async () => ({ data: [], error: null });
    cert({ valid_until: after(3).toISOString() });
    const out = await runAll({ admin: db.client(), origin: "https://halo.test", deps: {} as never, now: () => NOW });
    expect(out.certs_notified).toBe(1);
    expect(notes()).toHaveLength(2);
  });
});
