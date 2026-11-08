import { describe, expect, it } from "vitest";

import { CCA_FORM, deriveIncident, severityForBand, validateAnswers, visibleFields, type RosterEntry } from "./form-schema";
import { frameAncestors, generateKey, hashKey, isOrigin, keyFromHeader, modeOfKey, parseOrigins, readSessionToken, signSessionToken, urlOnAllowedOrigin } from "./keys";
import { parseLaunch } from "./launch";

const SID = "11111111-2222-3333-4444-555555555555";

describe("keys", () => {
  it("generates a live or test key, shows a short prefix, and stores only the hash", () => {
    const live = generateKey("live");
    expect(live.key).toMatch(/^ik_live_[A-Za-z0-9_-]{43}$/);
    expect(live.prefix).toBe(live.key.slice(0, 12));
    expect(live.hash).toBe(hashKey(live.key));
    expect(live.hash).not.toContain(live.key.slice(12));
    expect(modeOfKey(generateKey("test").key)).toBe("test");
    expect(generateKey("live").key).not.toBe(generateKey("live").key);
  });

  it("reads a key from a Bearer header or a bare key, and nothing else", () => {
    const { key } = generateKey("live");
    expect(keyFromHeader(`Bearer ${key}`)).toBe(key);
    expect(keyFromHeader(key)).toBe(key);
    expect(keyFromHeader(`bearer   ${key}  `)).toBe(key);
    expect(keyFromHeader("Bearer sk_live_nope")).toBeNull();
    expect(keyFromHeader("Bearer ik_live_short")).toBeNull();
    expect(keyFromHeader(null)).toBeNull();
  });
});

describe("report-link tokens", () => {
  it("round-trips the session and the frame origins, and gives the same link for the same claims", () => {
    const claims = { sessionId: SID, origins: ["https://coach.example.edu.my"] };
    const token = signSessionToken(claims, "secret");
    expect(readSessionToken(token, "secret")).toEqual(claims);
    expect(signSessionToken(claims, "secret")).toBe(token);
  });

  it("rejects a token signed with another secret, an edited token, junk, and any token when no secret is set", () => {
    const token = signSessionToken({ sessionId: SID, origins: [] }, "secret");
    expect(readSessionToken(token, "other")).toBeNull();
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ s: SID, o: ["https://evil.example"] })).toString("base64url");
    expect(readSessionToken(`${forged}.${mac}`, "secret")).toBeNull();
    expect(readSessionToken(`${payload}.${"x".repeat(32)}`, "secret")).toBeNull();
    expect(readSessionToken("not-a-token", "secret")).toBeNull();
    expect(readSessionToken(signSessionToken({ sessionId: SID, origins: [] }, ""), "")).toBeNull();
  });

  it("drops origins that are not origins and refuses a session id that is not a uuid", () => {
    expect(readSessionToken(signSessionToken({ sessionId: "../../etc", origins: [] }, "s"), "s")).toBeNull();
    const t = signSessionToken({ sessionId: SID, origins: ["https://ok.example", "javascript:alert(1)"] }, "s");
    expect(readSessionToken(t, "s")?.origins).toEqual(["https://ok.example"]);
  });
});

describe("allowed origins", () => {
  it("accepts https origins (and http only for localhost)", () => {
    expect(isOrigin("https://coach.example.edu.my")).toBe(true);
    expect(isOrigin("https://coach.example.edu.my:8443")).toBe(true);
    expect(isOrigin("http://localhost:3000")).toBe(true);
    expect(isOrigin("http://coach.example.edu.my")).toBe(false);
    expect(isOrigin("https://coach.example.edu.my/path")).toBe(false);
    expect(isOrigin("coach.example.edu.my")).toBe(false);
  });
  it("tidies a typed list and says which entry is wrong", () => {
    expect(parseOrigins([" https://a.example/ ", "https://a.example", ""])).toEqual({ ok: true, origins: ["https://a.example"] });
    expect(parseOrigins(["https://a.example/x"])).toMatchObject({ ok: false });
    expect(parseOrigins(Array.from({ length: 11 }, (_, i) => `https://h${i}.example`))).toMatchObject({ ok: false });
  });
  it("builds frame-ancestors: only the registered origins, or nobody", () => {
    expect(frameAncestors(["https://a.example", "https://b.example"])).toBe("frame-ancestors https://a.example https://b.example");
    expect(frameAncestors([])).toBe("frame-ancestors 'none'");
  });
  it("checks a return address against the allowed origins", () => {
    expect(urlOnAllowedOrigin("https://a.example/activities/1", ["https://a.example"])).toBe(true);
    expect(urlOnAllowedOrigin("https://evil.example/", ["https://a.example"])).toBe(false);
    expect(urlOnAllowedOrigin("not a url", ["https://a.example"])).toBe(false);
  });
});

const roster: RosterEntry[] = [
  { student_id: "S-1", name: "Adam bin Yusof", class: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test" }] },
  { student_id: "S-2", name: "Daniel Lee", class: "9 Amanah" },
];
const scale = {
  categoryCodes: ["CCA", "NMS", "PRD", "OTH"],
  severities: [
    { slug: "critical", position: 0 },
    { slug: "high", position: 1 },
    { slug: "medium", position: 2 },
    { slug: "low", position: 3 },
  ],
};
const good = { involved: { ids: ["S-1"], others: [] }, kind: "injury", what: "Twisted ankle during a passing drill", severity: "first_aid", body_part: "leg", head_injury: false };

describe("the coach form", () => {
  it("shows the injury questions only for an injury", () => {
    const how = CCA_FORM.steps[2];
    expect(visibleFields(how, { kind: "injury" }).map((f) => f.key)).toEqual(["severity", "body_part", "head_injury", "photo"]);
    expect(visibleFields(how, { kind: "damage" }).map((f) => f.key)).toEqual(["severity", "photo"]);
  });

  it("accepts a complete report", () => {
    expect(validateAnswers(CCA_FORM, good, roster)).toEqual({});
  });

  it("asks for what is missing, in plain words", () => {
    expect(validateAnswers(CCA_FORM, {}, roster)).toEqual({ involved: "Choose at least one person.", kind: "Choose one.", what: "This is needed.", severity: "Choose one." });
  });

  it("refuses someone who is not on this activity's list, an unknown choice, and an over-long text", () => {
    expect(validateAnswers(CCA_FORM, { ...good, involved: { ids: ["S-99"], others: [] } }, roster).involved).toMatch(/not on this activity/);
    expect(validateAnswers(CCA_FORM, { ...good, severity: "catastrophic" }, roster).severity).toMatch(/not available/);
    expect(validateAnswers(CCA_FORM, { ...good, what: "x".repeat(1001) }, roster).what).toMatch(/too long/);
    expect(validateAnswers(CCA_FORM, { ...good, head_injury: "yes" }, roster).head_injury).toBeDefined();
  });

  it("does not ask about a field that is hidden, even if the answer was sent", () => {
    expect(validateAnswers(CCA_FORM, { ...good, kind: "damage", body_part: "banana" }, roster)).toEqual({});
  });
});

describe("severityForBand", () => {
  it("spreads four bands over a four-level scale", () => {
    expect(["minor", "first_aid", "cannot_continue", "hospital"].map((b) => severityForBand(b as never, scale.severities))).toEqual(["low", "medium", "high", "critical"]);
  });
  it("spreads them over a shorter scale and copes with an empty one", () => {
    const three = scale.severities.slice(0, 3);
    expect(["minor", "first_aid", "cannot_continue", "hospital"].map((b) => severityForBand(b as never, three))).toEqual(["medium", "high", "high", "critical"]);
    expect(severityForBand("minor", [])).toBeNull();
  });
});

describe("deriveIncident", () => {
  it("files an injury with its flags, the school's severity and the people named, with their guardians", () => {
    const out = deriveIncident(CCA_FORM, good, roster, scale);
    expect(out).toMatchObject({ ok: true, incident: { category: "CCA", severity: "medium", flags: ["injury", "child_involved"], description: "Twisted ankle during a passing drill", kindLabel: "Injury" } });
    if (out.ok) expect(out.incident.involved).toEqual([{ studentId: "S-1", name: "Adam bin Yusof", className: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test" }] }]);
  });

  it("treats a knock to the head as a concussion and raises the severity to at least 'could not continue'", () => {
    const out = deriveIncident(CCA_FORM, { ...good, severity: "minor", head_injury: true }, roster, scale);
    expect(out).toMatchObject({ ok: true, incident: { severity: "high", flags: ["injury", "child_involved", "concussion"] } });
  });

  it("keeps the more serious band when the coach already said hospital", () => {
    const out = deriveIncident(CCA_FORM, { ...good, severity: "hospital", head_injury: true }, roster, scale);
    expect(out).toMatchObject({ ok: true, incident: { severity: "critical" } });
  });

  it("files property damage without child flags, and names a visitor typed by hand", () => {
    const out = deriveIncident(CCA_FORM, { involved: { ids: [], others: ["  Mr Visitor "] }, kind: "damage", what: "Goal post broken", severity: "minor" }, roster, scale);
    expect(out).toMatchObject({ ok: true, incident: { category: "PRD", flags: ["property_damage"], severity: "low" } });
    if (out.ok) expect(out.incident.involved).toEqual([{ studentId: null, name: "Mr Visitor", className: null, guardians: [] }]);
  });

  it("refuses, with the reason, when the school's template has no such category", () => {
    const out = deriveIncident(CCA_FORM, good, roster, { ...scale, categoryCodes: ["SB", "DB"] });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('no category "CCA"') });
  });
});

describe("parseLaunch", () => {
  const origins = ["https://coach.example.edu.my"];
  const body = {
    form: "cca",
    coach: { id: "C-204", name: "Rahim Ismail", email: "rahim@school.test", phone: "+60120000001" },
    activity: { id: "A-1187", name: "Football U15", venue: "Field 2", date: "2026-11-11" },
    roster: [{ student_id: "S-3321", name: "Adam bin Yusof", class: "9 Amanah", guardians: [{ name: "Yusof Ali", email: "yusof@mail.test", phone: "+60121110000" }] }],
    return_url: "https://coach.example.edu.my/activities/A-1187",
  };

  it("accepts the documented payload", () => {
    const out = parseLaunch(body, origins);
    expect(out).toMatchObject({ ok: true, value: { form: "cca", coach: { id: "C-204" }, activity: { name: "Football U15", date: "2026-11-11" }, returnUrl: body.return_url } });
  });

  it("accepts a minimal payload: the coach's name and email, no guardians, an empty roster, no return address", () => {
    const out = parseLaunch({ coach: { id: "c", name: "Coach", email: "coach@school.test" }, activity: { id: "a", name: "Chess" }, roster: [] }, origins);
    expect(out).toMatchObject({ ok: true, value: { form: "cca", roster: [], returnUrl: null, coach: { name: "Coach", email: "coach@school.test", phone: null } } });
  });

  it("needs the coach's name and email, and says which one is missing", () => {
    const base = { activity: { id: "a", name: "Chess" }, roster: [] };
    expect(parseLaunch({ ...base, coach: { id: "c", email: "coach@school.test" } }, origins)).toMatchObject({ ok: false, field: "coach" });
    for (const email of [undefined, null, "", "   "]) {
      expect(parseLaunch({ ...base, coach: { id: "c", name: "Coach", email } }, origins), String(email)).toMatchObject({ ok: false, field: "coach.email", error: "\"coach.email\" is required." });
    }
    expect(parseLaunch({ ...base, coach: { id: "c", name: "Coach", email: "nope" } }, origins)).toMatchObject({ ok: false, field: "coach.email" });
  });

  it("explains what is wrong without echoing the roster", () => {
    expect(parseLaunch(null, origins)).toMatchObject({ ok: false });
    expect(parseLaunch({ ...body, coach: { id: "c" } }, origins)).toMatchObject({ ok: false, field: "coach" });
    expect(parseLaunch({ ...body, form: "other" }, origins)).toMatchObject({ ok: false, field: "form" });
    expect(parseLaunch({ ...body, activity: { ...body.activity, date: "11 Nov" } }, origins)).toMatchObject({ ok: false, field: "activity.date" });
    expect(parseLaunch({ ...body, roster: "S-1" }, origins)).toMatchObject({ ok: false, field: "roster" });
    const dup = parseLaunch({ ...body, roster: [body.roster[0], body.roster[0]] }, origins);
    expect(dup).toMatchObject({ ok: false, field: "roster" });
    if (!dup.ok) expect(dup.error).not.toContain("Adam");
  });

  it("limits the roster size and the guardians per student", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ student_id: `S-${i}`, name: `N${i}` }));
    expect(parseLaunch({ ...body, roster: many }, origins)).toMatchObject({ ok: false, field: "roster" });
    const g = Array.from({ length: 5 }, () => ({ email: "g@mail.test" }));
    expect(parseLaunch({ ...body, roster: [{ student_id: "S-1", name: "A", guardians: g }] }, origins)).toMatchObject({ ok: false });
  });

  it("only lets the return address be on an allowed origin", () => {
    expect(parseLaunch({ ...body, return_url: "https://evil.example/" }, origins)).toMatchObject({ ok: false, field: "return_url" });
    expect(parseLaunch({ ...body, return_url: "https://coach.example.edu.my/x" }, [])).toMatchObject({ ok: false, field: "return_url" });
  });

  it("rejects an invalid email for the coach or a guardian", () => {
    expect(parseLaunch({ ...body, coach: { ...body.coach, email: "nope" } }, origins)).toMatchObject({ ok: false, field: "coach.email" });
    expect(parseLaunch({ ...body, roster: [{ student_id: "S-1", name: "A", guardians: [{ email: "nope" }] }] }, origins)).toMatchObject({ ok: false });
  });
});
