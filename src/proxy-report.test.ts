import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The coach's report page is framed by the coach portal, so the proxy must (1) allow framing only from the origins signed into the link, (2) never set
// a cookie on it, and (3) not need a session. Everything else keeps its existing behaviour.

const authMock = vi.fn(async () => null as unknown);
vi.mock("@/auth", () => ({ auth: () => authMock() }));

import { proxy } from "./proxy";
import { signSessionToken } from "@/lib/incidents/intake/keys";

const req = (path: string) => new NextRequest(`https://halo.test${path}`);

beforeEach(() => {
  process.env.INCIDENT_INTAKE_SECRET = "proxy-test-secret";
  authMock.mockClear();
});

describe("proxy: the coach report", () => {
  it("lets only the registered origins frame a valid link", async () => {
    const token = signSessionToken({ sessionId: "11111111-2222-3333-4444-555555555555", origins: ["https://coach.example.edu.my"] });
    const res = await proxy(req(`/report/${token}`));
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors https://coach.example.edu.my");
  });

  it("lets nobody frame a link with no registered origins, a forged link, or junk", async () => {
    const bare = signSessionToken({ sessionId: "11111111-2222-3333-4444-555555555555", origins: [] });
    expect((await proxy(req(`/report/${bare}`))).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const forged = `${Buffer.from(JSON.stringify({ s: "11111111-2222-3333-4444-555555555555", o: ["https://evil.example"] })).toString("base64url")}.${"a".repeat(32)}`;
    expect((await proxy(req(`/report/${forged}`))).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect((await proxy(req("/report/junk"))).headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  it("sets no cookie and does not look up a session", async () => {
    const res = await proxy(req("/report/junk"));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("does the same for the one-tap acknowledge page, without framing rules", async () => {
    const res = await proxy(req("/incident-ack/abc"));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("still handles other pages as before (session read, cookie cleared when signed out)", async () => {
    const res = await proxy(req("/incidents"));
    expect(authMock).toHaveBeenCalled();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").toContain("sb-access-token");
  });
});
