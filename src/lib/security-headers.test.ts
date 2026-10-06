import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

// The response headers (next.config.ts). Where the same header is set by more than one matching rule, the last one wins, so
// the order matters: the rule for Doc Sign's public registration pages (/r/<slug>) must come last, must be the only place the
// Cloudflare Turnstile address is allowed, and must stop that page being cached (every visit carries its own signed token).

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  const headers = (nextConfig as { headers?: () => Promise<Rule[]> }).headers;
  expect(headers).toBeTypeOf("function");
  return headers!();
}

const csp = (rule: Rule) => rule.headers.find((h) => h.key === "Content-Security-Policy-Report-Only")?.value ?? "";

describe("response headers", () => {
  it("lists the registration pages' own rule last, so it wins for the headers it sets", async () => {
    const all = await rules();
    const last = all[all.length - 1];
    expect(last.source).toBe("/r/:slug*");
    expect(last.headers.find((h) => h.key === "Cache-Control")?.value).toBe("private, no-store");
  });

  it("lets only the registration pages reach Cloudflare Turnstile", async () => {
    const all = await rules();
    const withTurnstile = all.filter((r) => csp(r).includes("challenges.cloudflare.com"));
    expect(withTurnstile.map((r) => r.source)).toEqual(["/r/:slug*"]);
    const own = csp(withTurnstile[0]);
    expect(own).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(own).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
    expect(own).toMatch(/connect-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    // everything else about the policy is the same as everywhere
    const everywhere = csp(all.find((r) => r.source === "/:path*")!);
    expect(own.replace(/ https:\/\/challenges\.cloudflare\.com/g, "").replace("; frame-src", "").replace(/frame-src;?/, "")).toBe(everywhere);
    expect(everywhere).not.toContain("frame-src");
    expect(everywhere).toContain("frame-ancestors 'none'");
    expect(own).toContain("frame-ancestors 'none'");
    expect(own).toContain("form-action 'self'");
  });

  it("keeps the baseline policy as it was for every other route", async () => {
    const base = csp((await rules()).find((r) => r.source === "/:path*")!);
    for (const directive of ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "connect-src 'self' https://*.supabase.co wss://*.supabase.co", "worker-src 'self' blob:", "base-uri 'self'", "form-action 'self'"]) {
      expect(base).toContain(directive);
    }
  });
});
