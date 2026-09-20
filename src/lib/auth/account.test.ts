import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const { getCurrentAccount, UnauthorizedError, ForbiddenError } = await import(
  "./account"
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentAccount", () => {
  it("resolves context via a plain accounts lookup, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "owner" },
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([["user_id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "admin" },
          error: null,
        },
        accounts: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: { account_id: null, account_role: null }, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: { account_id: "acct-1", account_role: "viewer" },
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });
});

// ------------------------------------------------------------
// requireCapability / requireAnyCapability / assertCapability
// (migration 079). The caller's capabilities are the role default plus
// the account's `role_capabilities` overrides, read once per context.
// ------------------------------------------------------------
type OverrideResult = { data: unknown; error: unknown };

function makeCapabilityClient(opts: {
  role: "owner" | "admin" | "agent" | "viewer";
  overrides?: OverrideResult;
}) {
  const overridesQueries: [string, unknown][][] = [];

  const from = (table: string) => {
    const eqArgs: [string, unknown][] = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle: () =>
        Promise.resolve(
          table === "profiles"
            ? {
                data: { account_id: "acct-1", account_role: opts.role },
                error: null,
              }
            : { data: { id: "acct-1", name: "Acme" }, error: null },
        ),
      then: (resolve: (v: OverrideResult) => unknown) => {
        overridesQueries.push(eqArgs);
        return resolve(opts.overrides ?? { data: [], error: null });
      },
    };
    return builder;
  };

  return {
    overridesQueries,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
      },
      from,
    },
  };
}

const {
  requireCapability,
  requireAnyCapability,
  assertCapability,
  loadCapabilities,
} = await import("./account");

describe("requireCapability", () => {
  it("allows a role that holds the capability by default", async () => {
    const { client } = makeCapabilityClient({ role: "agent" });
    createClient.mockReturnValue(client);
    const ctx = await requireCapability("messages.send");
    expect(ctx).toMatchObject({ userId: "user-1", accountId: "acct-1", role: "agent" });
    expect(ctx.capabilities.has("messages.send")).toBe(true);
    expect(ctx.capabilities.has("tags.manage")).toBe(false);
  });

  it("denies with a 403 that names the capability", async () => {
    const { client } = makeCapabilityClient({ role: "viewer" });
    createClient.mockReturnValue(client);
    const err = await requireCapability("messages.send").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("messages.send");
  });

  it("denies an unknown capability key, even for the owner", async () => {
    const { client } = makeCapabilityClient({ role: "owner" });
    createClient.mockReturnValue(client);
    const err = await requireCapability("not.a.capability").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain("not.a.capability");
  });

  it("gives the owner every capability without reading overrides", async () => {
    const { client, overridesQueries } = makeCapabilityClient({ role: "owner" });
    createClient.mockReturnValue(client);
    const ctx = await requireCapability("roles.manage");
    expect(ctx.capabilities.has("api.manage")).toBe(true);
    expect(overridesQueries).toHaveLength(0);
  });

  it("lets an override revoke a default", async () => {
    const { client, overridesQueries } = makeCapabilityClient({
      role: "admin",
      overrides: {
        data: [{ capability: "channels.manage", granted: false }],
        error: null,
      },
    });
    createClient.mockReturnValue(client);
    await expect(requireCapability("channels.manage")).rejects.toThrow(
      "channels.manage",
    );
    // ...while the rest of the admin defaults are untouched.
    createClient.mockReturnValue(client);
    await expect(requireCapability("tags.manage")).resolves.toBeDefined();
    // Scoped to this account and this role.
    expect(overridesQueries[0]).toEqual([
      ["account_id", "acct-1"],
      ["role", "admin"],
    ]);
  });

  it("lets an override grant a capability the role lacks (above its minimum role)", async () => {
    const { client } = makeCapabilityClient({
      role: "agent",
      overrides: {
        data: [{ capability: "channels.manage", granted: true }],
        error: null,
      },
    });
    createClient.mockReturnValue(client);
    await expect(requireCapability("channels.manage")).resolves.toBeDefined();
  });

  it("fails closed when the overrides cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeCapabilityClient({
      role: "admin",
      overrides: { data: null, error: { code: "XX000", message: "boom" } },
    });
    createClient.mockReturnValue(client);
    const err = await requireCapability("tags.manage").catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe("Could not load permissions");
  });

  it("falls back to the defaults when the table does not exist yet", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const { client } = makeCapabilityClient({
        role: "agent",
        overrides: { data: null, error: { code, message: "no table" } },
      });
      createClient.mockReturnValue(client);
      await expect(requireCapability("messages.send")).resolves.toBeDefined();
      createClient.mockReturnValue(client);
      await expect(requireCapability("tags.manage")).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it("reads the overrides once per context", async () => {
    const { client, overridesQueries } = makeCapabilityClient({ role: "agent" });
    createClient.mockReturnValue(client);
    const ctx = await requireCapability("messages.send");
    expect(overridesQueries).toHaveLength(1);
    await loadCapabilities(ctx);
    await loadCapabilities(ctx);
    expect(overridesQueries).toHaveLength(1);
  });
});

describe("requireAnyCapability", () => {
  it("passes when any one capability is held", async () => {
    const { client } = makeCapabilityClient({ role: "agent" });
    createClient.mockReturnValue(client);
    const ctx = await requireAnyCapability(["knowledge.publish", "knowledge.draft"]);
    expect(ctx.capabilities.has("knowledge.draft")).toBe(true);
    expect(ctx.capabilities.has("knowledge.publish")).toBe(false);
  });

  it("denies when none is held and names them all", async () => {
    const { client } = makeCapabilityClient({ role: "viewer" });
    createClient.mockReturnValue(client);
    const err = await requireAnyCapability([
      "knowledge.publish",
      "knowledge.draft",
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toContain("knowledge.publish");
    expect(err.message).toContain("knowledge.draft");
  });

  it("ignores unknown keys", async () => {
    const { client } = makeCapabilityClient({ role: "admin" });
    createClient.mockReturnValue(client);
    await expect(requireAnyCapability(["nope"])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("assertCapability", () => {
  it("throws for a capability the context lacks and passes for one it holds", async () => {
    const { client } = makeCapabilityClient({ role: "agent" });
    createClient.mockReturnValue(client);
    const ctx = await requireCapability("comments.moderate");
    expect(() => assertCapability(ctx, "comments.moderate")).not.toThrow();
    expect(() => assertCapability(ctx, "comments.delete")).toThrow(
      "comments.delete",
    );
    expect(() => assertCapability(ctx, "unknown.key")).toThrow(ForbiddenError);
  });
});
