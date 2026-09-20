import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Every Jira route, one by one: the capability gate runs FIRST (before the
// body is read and before any database or Jira access), each route asks for
// the capability the design assigns to it, and no route can hand a token out.

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  requireAnyCapability: vi.fn(),
  dbTouched: vi.fn(),
}));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  requireAnyCapability: h.requireAnyCapability,
  toErrorResponse: (err: unknown) =>
    Response.json({ error: err instanceof Error ? err.message : "x" }, { status: (err as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => {
    h.dbTouched();
    throw new Error("the database must not be touched before the capability check");
  },
}));

import { GET as connectGET } from "./connect/route";
import { GET as connectionGET, PATCH as connectionPATCH, DELETE as connectionDELETE } from "./connection/route";
import { GET as sitesGET, POST as sitesPOST } from "./sites/route";
import { GET as metadataGET } from "./metadata/route";
import { GET as searchGET } from "./issues/search/route";
import { POST as createPOST } from "./create/route";
import { POST as linksPOST } from "./links/route";
import { DELETE as linkDELETE } from "./links/[id]/route";
import { POST as syncPOST } from "./links/[id]/sync/route";
import { GET as transitionsGET } from "./links/[id]/transitions/route";
import { POST as transitionPOST } from "./links/[id]/transition/route";
import { POST as commentPOST } from "./links/[id]/comment/route";
import { POST as sharePOST } from "./comments/share/route";
import { GET as usersGET, PUT as usersPUT, POST as usersPOST } from "./users/route";
import { GET as userSearchGET } from "./users/search/route";
import { GET as diagGET, POST as diagPOST } from "./diagnostics/route";
import { POST as attachSendPOST } from "./attachments/send/route";
import { GET as fieldsGET } from "./fields/route";
import { PUT as fieldMapPUT, DELETE as fieldMapDELETE } from "./field-mappings/route";
import { GET as bulkGET, POST as bulkPOST } from "./bulk/route";
import { __resetRateLimitForTests } from "@/lib/rate-limit";
import { CONNECTION_COLUMNS } from "@/lib/jira/types";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const url = (p: string) => new Request(`http://localhost/api/integrations/jira${p}`, { method: "POST", body: "{}" });
const params = { params: Promise.resolve({ id: ID }) };

const denied = (cap: string) => Object.assign(new Error(`This action requires the '${cap}' permission`), { status: 403 });

interface Case {
  name: string;
  cap: string | string[];
  any?: boolean;
  call: () => Promise<Response>;
}

const CASES: Case[] = [
  { name: "GET connect", cap: "jira.connect", call: () => connectGET(url("/connect")) },
  { name: "GET connection", cap: "jira.connect", call: () => connectionGET(url("/connection")) },
  { name: "PATCH connection", cap: "jira.connect", call: () => connectionPATCH(url("/connection")) },
  { name: "DELETE connection", cap: "jira.connect", call: () => connectionDELETE(url("/connection")) },
  { name: "GET sites", cap: "jira.connect", call: () => sitesGET(url("/sites?pending=x")) },
  { name: "POST sites", cap: "jira.connect", call: () => sitesPOST(url("/sites")) },
  { name: "GET metadata", cap: "jira.link", call: () => metadataGET(url("/metadata?kind=projects")) },
  { name: "GET issues/search", cap: "jira.link", call: () => searchGET(url("/issues/search?q=x")) },
  { name: "POST create", cap: "jira.link", call: () => createPOST(url("/create")) },
  { name: "POST links", cap: "jira.link", call: () => linksPOST(url("/links")) },
  { name: "DELETE links/[id]", cap: "jira.link", call: () => linkDELETE(url("/links/x"), params) },
  { name: "POST links/[id]/sync", cap: "jira.link", call: () => syncPOST(url("/links/x/sync"), params) },
  { name: "GET links/[id]/transitions", cap: "jira.link", call: () => transitionsGET(url("/links/x/transitions"), params) },
  { name: "POST links/[id]/transition", cap: "jira.link", call: () => transitionPOST(url("/links/x/transition"), params) },
  { name: "POST links/[id]/comment", cap: "jira.share-comments", call: () => commentPOST(url("/links/x/comment"), params) },
  { name: "POST comments/share", cap: "jira.share-comments", call: () => sharePOST(url("/comments/share")) },
  { name: "GET users", cap: ["jira.connect", "jira.link"], any: true, call: () => usersGET(url("/users")) },
  { name: "PUT users", cap: ["jira.connect", "jira.link"], any: true, call: () => usersPUT(url("/users")) },
  { name: "POST users", cap: ["jira.connect"], any: true, call: () => usersPOST(url("/users")) },
  { name: "GET users/search", cap: "jira.link", call: () => userSearchGET(url("/users/search?q=ab")) },
  { name: "GET diagnostics", cap: "jira.connect", call: () => diagGET() },
  { name: "POST diagnostics", cap: "jira.connect", call: () => diagPOST(url("/diagnostics")) },
  // 0.45.0
  { name: "POST attachments/send", cap: "jira.link", call: () => attachSendPOST(url("/attachments/send")) },
  { name: "GET fields", cap: "jira.connect", call: () => fieldsGET(url("/fields?project=ENG")) },
  { name: "PUT field-mappings", cap: "jira.connect", call: () => fieldMapPUT(url("/field-mappings")) },
  { name: "DELETE field-mappings", cap: "jira.connect", call: () => fieldMapDELETE(url("/field-mappings?id=x")) },
  { name: "GET bulk", cap: "jira.link", call: () => bulkGET(url("/bulk?batch=x")) },
  { name: "POST bulk", cap: "jira.link", call: () => bulkPOST(url("/bulk")) },
];

beforeEach(() => {
  h.requireCapability.mockReset();
  h.requireAnyCapability.mockReset();
  h.dbTouched.mockReset();
  __resetRateLimitForTests();
});

describe("capability gates", () => {
  for (const c of CASES) {
    it(`${c.name} is refused without ${Array.isArray(c.cap) ? c.cap.join(" / ") : c.cap}, before anything else happens`, async () => {
      const fn = c.any ? h.requireAnyCapability : h.requireCapability;
      fn.mockRejectedValue(denied(Array.isArray(c.cap) ? c.cap.join("' or '") : c.cap));
      const res = await c.call();
      expect(res.status).toBe(403);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toEqual(c.cap);
      // neither the database nor Jira was reached
      expect(h.dbTouched).not.toHaveBeenCalled();
    });

    it(`${c.name} answers 401 for a signed-out caller`, async () => {
      const fn = c.any ? h.requireAnyCapability : h.requireCapability;
      fn.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
      expect((await c.call()).status).toBe(401);
      expect(h.dbTouched).not.toHaveBeenCalled();
    });
  }
});

// ------------------------------------------------------------------
// Source-level guarantees
// ------------------------------------------------------------------

const ROOT = join(process.cwd(), "src", "app", "api", "integrations", "jira");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}
const FILES = routeFiles(ROOT).map((file) => ({ file, key: relative(ROOT, file).split(sep).join("/").replace(/\/route\.ts$/, ""), src: readFileSync(file, "utf8") }));

// The two public endpoints authenticate differently (see their headers); the callback
// authenticates by the signed one-time state AND then requires jira.connect.
const PUBLIC_ROUTES = new Set(["webhook/[token]", "cron"]);

describe("every route file", () => {
  it("finds the route files", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(19);
  });

  it("checks a capability in every exported handler, before it reads the request body or the params", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (PUBLIC_ROUTES.has(f.key) || f.key === "callback") continue;
      const handlers = [...f.src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
      expect(handlers.length, f.key).toBeGreaterThan(0);
      for (const m of handlers) {
        const start = m.index ?? 0;
        const next = f.src.indexOf("export async function", start + 10);
        const body = f.src.slice(start, next === -1 ? undefined : next);
        const gate = body.search(/require(Any)?Capability\(/);
        const firstUse = body.search(/request\.json\(|await params|request\.text\(|loadJiraContext\(|supabaseAdmin\(|jiraStore\(/);
        if (gate === -1 || (firstUse !== -1 && firstUse < gate)) bad.push(`${f.key} ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the callback still requires jira.connect after checking the signed state", () => {
    const cb = FILES.find((f) => f.key === "callback")!;
    expect(cb.src).toContain('requireCapability("jira.connect")');
    expect(cb.src.indexOf("verifyOAuthState(")).toBeLessThan(cb.src.indexOf('requireCapability("jira.connect")'));
  });

  it("the public endpoints are the receiver and the cron only, and the cron checks its shared secret in constant time", () => {
    const cron = FILES.find((f) => f.key === "cron")!;
    expect(cron.src).toContain("x-cron-secret");
    expect(cron.src).toContain("timingSafeEqual");
    expect(cron.src).toContain("AUTOMATION_CRON_SECRET");
    expect(FILES.filter((f) => !/require(Any)?Capability\(/.test(f.src)).map((f) => f.key).sort()).toEqual(["cron", "webhook/[token]"]);
  });

  it("uses only Next route exports (a stray export breaks the production build)", () => {
    const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "dynamic", "runtime", "revalidate", "maxDuration"]);
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.src.matchAll(/^export (?:async )?(?:function|const|type|interface|class|let)\s+([A-Za-z_]+)/gm)) {
        if (!allowed.has(m[1])) bad.push(`${f.key}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("no route ever exposes a token", () => {
  it("no route file names a token column, the secrets table or a decrypt call", () => {
    const offenders = FILES.filter((f) => /access_token_enc|refresh_token_enc|jira_connection_secrets|decrypt\(|webhook_token|refreshToken|accessToken/.test(f.src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))).map((f) => f.key);
    // the callback and the site picker hand the sign-in's tokens between library calls but never return one
    expect(offenders.sort()).toEqual(["callback", "sites"]);
  });

  it("no response body of those two (or the receiver) carries a token: they only ever return ids, names, flags", () => {
    for (const key of ["callback", "sites", "webhook/[token]"]) {
      const src = FILES.find((f) => f.key === key)!.src;
      const responses = [...src.matchAll(/NextResponse\.(?:json|redirect)\(([^;]*)\)/g)].map((m) => m[1]).join("\n");
      expect(responses, key).not.toMatch(/token|secret|password/i);
    }
  });

  it("the connection columns the app reads have no secret in them", () => {
    expect(CONNECTION_COLUMNS).not.toMatch(/token(?!_expires)|secret|refresh|_enc|password/i);
    expect(CONNECTION_COLUMNS.split(", ")).toContain("token_expires_at"); // only an expiry TIME, useful for diagnostics
  });

  it("the diagnostics route does not return the webhook address or its token", () => {
    const src = FILES.find((f) => f.key === "diagnostics")!.src;
    expect(src).not.toMatch(/webhook_token|api\/integrations\/jira\/webhook/);
  });
});
