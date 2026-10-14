import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireCapability: vi.fn() }));

vi.mock("@/lib/auth/account", () => ({
  requireCapability: h.requireCapability,
  toErrorResponse: (err: unknown) =>
    Response.json(
      { error: err instanceof Error ? err.message : "x" },
      { status: (err as { status?: number }).status ?? 500 },
    ),
}));

import { GET } from "./route";

const UAT = "https://v2-uat.vircle.net/app-user-details-b";

beforeEach(() => {
  h.requireCapability.mockReset();
  h.requireCapability.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/account/back-office-link", () => {
  it("is for members who can open the Inbox (menu.inbox) and checks it before anything else", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    await GET();
    expect(h.requireCapability).toHaveBeenCalledTimes(1);
    expect(h.requireCapability).toHaveBeenCalledWith("menu.inbox");
    // the source asks for exactly that capability (the route-surface and capability-parity tests read the source the same way)
    const src = readFileSync(join(process.cwd(), "src", "app", "api", "account", "back-office-link", "route.ts"), "utf8");
    expect(src).toMatch(/requireCapability\(\s*"menu\.inbox"\s*\)/);
  });

  it("returns the address and embed false when only the address is set, and is never cached", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    vi.stubEnv("BACK_OFFICE_EMBED", "");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ baseUrl: UAT, embed: false });
  });

  it("strips a query and a fragment from the configured address", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", `${UAT}?q=x#y`);
    expect((await (await GET()).json()).baseUrl).toBe(UAT);
  });

  it("reports embed true for true or 1", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    for (const on of ["true", "1"]) {
      vi.stubEnv("BACK_OFFICE_EMBED", on);
      expect(await (await GET()).json()).toEqual({ baseUrl: UAT, embed: true });
    }
  });

  it("returns nulls when the address is unset, and no embed", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", "");
    vi.stubEnv("BACK_OFFICE_EMBED", "true");
    expect(await (await GET()).json()).toEqual({ baseUrl: null, embed: false });
  });

  it("returns nulls for an address that is not https or not a URL", async () => {
    for (const bad of ["http://v2-uat.vircle.net/x", "not a url", "https://user:pw@v2-uat.vircle.net/x"]) {
      vi.stubEnv("BACK_OFFICE_USER_URL", bad);
      vi.stubEnv("BACK_OFFICE_EMBED", "true");
      expect(await (await GET()).json(), bad).toEqual({ baseUrl: null, embed: false });
    }
  });

  it("reads the environment on every call, so a change needs no rebuild", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", "");
    expect((await (await GET()).json()).baseUrl).toBeNull();
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    expect((await (await GET()).json()).baseUrl).toBe(UAT);
  });

  it("answers only baseUrl and embed (nothing else leaves the server)", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    expect(Object.keys(await (await GET()).json()).sort()).toEqual(["baseUrl", "embed"]);
  });

  it("turns a signed-out or forbidden caller away, without reading the settings into the answer", async () => {
    vi.stubEnv("BACK_OFFICE_USER_URL", UAT);
    h.requireCapability.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const unauth = await GET();
    expect(unauth.status).toBe(401);
    expect(JSON.stringify(await unauth.json())).not.toContain("vircle.net");

    h.requireCapability.mockRejectedValueOnce(Object.assign(new Error("This action requires the 'menu.inbox' permission"), { status: 403 }));
    const forbidden = await GET();
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(await forbidden.json())).not.toContain("vircle.net");
  });
});
