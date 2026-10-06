import { beforeEach, describe, expect, it } from "vitest";

import { A4, makePdf } from "../pdf/fixtures";
import type { PlacedField } from "../pdf/types";
import type { SignCtx } from "../service/context";
import { SignError } from "../service/errors";
import { FakeDb } from "../service/fake-db";
import type { SignRole } from "../types";
import { addonAllowed, installAddon, listAddonCards } from "./install";
import { ADDON_REGISTRY, getAddon, type AddonManifest, type AddonRegistry } from "./index";
import { merchantAddon } from "./merchant";

const ACCT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function setup(features: Record<string, boolean> = { sign: true, sign_merchant: true }) {
  const db = new FakeDb();
  const ctx: SignCtx = {
    admin: db.client(),
    accountId: ACCT,
    userId: USER,
    origin: "https://halo.test",
    deps: { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "x" }), sendWhatsApp: async () => {} },
    now: () => new Date("2026-10-06T08:00:00Z"),
  };
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features, limits: {} }]);
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  return { db, ctx };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("the registry", () => {
  it("ships the merchant add-on, gated by the sign_merchant flag, with no template files yet", () => {
    expect(Object.keys(ADDON_REGISTRY)).toEqual(["merchant"]);
    const m = getAddon("merchant")!;
    expect(m.requires).toBe("sign_merchant");
    expect(m.category).toMatchObject({ key: "merchant_agreements", name: "Merchant agreements" });
    expect(m.templates).toEqual([]);
    expect(m.key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });

  it("does not look up inherited object keys", () => {
    expect(getAddon("constructor")).toBeNull();
    expect(getAddon("__proto__")).toBeNull();
  });
});

describe("installing the merchant add-on", () => {
  it("creates the category marked with the add-on and records the installed version", async () => {
    const result = await installAddon(t.ctx, "merchant");
    expect(result).toMatchObject({ key: "merchant", version: "1.0", previousVersion: null, category: { key: "merchant_agreements", outcome: "created" }, templates: { created: [], skipped: [] } });
    const cats = t.db.rows("sign_categories");
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ account_id: ACCT, key: "merchant_agreements", name: "Merchant agreements", addon_key: "merchant", archived: false, code_required: false, sign_in_order: false, expiry_days: null });
    const rec = t.db.rows("sign_addons");
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ account_id: ACCT, addon_key: "merchant", installed_version: "1.0", status: "installed", installed_by: USER });
  });

  it("is safe to repeat: nothing is added twice", async () => {
    await installAddon(t.ctx, "merchant");
    const again = await installAddon(t.ctx, "merchant");
    expect(again).toMatchObject({ previousVersion: "1.0", category: { outcome: "existing" } });
    expect(t.db.rows("sign_categories")).toHaveLength(1);
    expect(t.db.rows("sign_addons")).toHaveLength(1);
  });

  it("adopts the starting category the workspace already has, without touching what it changed", async () => {
    t.db.seed("sign_categories", [{ id: "c1", account_id: ACCT, key: "merchant_agreements", name: "Our merchants", expiry_days: 30, reminder_days: [5], code_required: true, sign_in_order: true, addon_key: null, archived: false, position: 1 }]);
    const r = await installAddon(t.ctx, "merchant");
    expect(r.category.outcome).toBe("adopted");
    expect(t.db.rows("sign_categories")).toHaveLength(1);
    expect(t.db.rows("sign_categories")[0]).toMatchObject({ name: "Our merchants", expiry_days: 30, reminder_days: [5], code_required: true, sign_in_order: true, addon_key: "merchant" });
  });

  it("brings an archived category back and says so", async () => {
    t.db.seed("sign_categories", [{ id: "c1", account_id: ACCT, key: "merchant_agreements", name: "Merchant agreements", addon_key: "merchant", archived: true, position: 1 }]);
    const r = await installAddon(t.ctx, "merchant");
    expect(r.category.outcome).toBe("restored");
    expect(t.db.rows("sign_categories")[0].archived).toBe(false);
  });

  it("puts a new category after the others", async () => {
    t.db.seed("sign_categories", [
      { id: "a", account_id: ACCT, key: "nda", name: "NDA", archived: false, position: 2 },
      { id: "b", account_id: ACCT, key: "sales", name: "Sales", archived: false, position: 4 },
    ]);
    const custom: AddonRegistry = { x: { ...merchantAddon, key: "x", category: { ...merchantAddon.category, key: "x_cat", name: "X" } } };
    await installAddon(t.ctx, "x", { registry: custom });
    expect(t.db.rows("sign_categories").find((c) => c.key === "x_cat")?.position).toBe(5);
  });

  it("does not touch another workspace's rows", async () => {
    t.db.seed("sign_categories", [{ id: "o", account_id: "99999999-9999-4999-8999-999999999999", key: "merchant_agreements", name: "Theirs", addon_key: null, archived: false, position: 1 }]);
    await installAddon(t.ctx, "merchant");
    expect(t.db.rows("sign_categories")).toHaveLength(2);
    expect(t.db.rows("sign_categories").find((c) => c.account_id !== ACCT)).toMatchObject({ name: "Theirs", addon_key: null });
  });
});

describe("who may install", () => {
  it("refuses with a clear code when the operator has not switched the add-on on", async () => {
    t = setup({ sign: true, sign_merchant: false });
    await expect(installAddon(t.ctx, "merchant")).rejects.toMatchObject({ code: "addon_not_available", status: 403 });
    expect(t.db.rows("sign_categories")).toHaveLength(0);
    expect(t.db.rows("sign_addons")).toHaveLength(0);
  });

  it("refuses when Doc Sign itself is off, even if the add-on flag is on", async () => {
    t = setup({ sign: false, sign_merchant: true });
    await expect(installAddon(t.ctx, "merchant")).rejects.toMatchObject({ code: "addon_not_available" });
  });

  it("refuses a workspace the operator has suspended or that has no platform row", async () => {
    t.db.tables.account_platform = [{ account_id: ACCT, status: "suspended", features: { sign: true, sign_merchant: true }, limits: {} }];
    expect(await addonAllowed(t.ctx, merchantAddon)).toBe(false);
    t.db.tables.account_platform = [];
    expect(await addonAllowed(t.ctx, merchantAddon)).toBe(false);
  });

  it("answers 404 for an add-on that does not exist", async () => {
    const err = await installAddon(t.ctx, "nope").catch((e) => e);
    expect(err).toBeInstanceOf(SignError);
    expect(err).toMatchObject({ code: "addon_not_found", status: 404 });
  });
});

// ---- an add-on that does carry a template (the machinery the later work package will use) -----------

const roles: SignRole[] = [{ key: "merchant", label: "Merchant", kind: "signer", color: 0 }];
const fields: PlacedField[] = [{ key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true }];

const withTemplate = (): AddonRegistry => {
  const manifest: AddonManifest = {
    ...merchantAddon,
    key: "pack",
    requires: "sign",
    templates: [{ name: "Merchant Application", description: "From the pack", source: "merchant-application.pdf", roles, fields, defaults: { expiry_days: 10 }, tags: ["merchant"] }],
  };
  return { pack: manifest };
};

describe("installing a template", () => {
  it("creates it as a draft with its layout, marked as the add-on's and not customised", async () => {
    const registry = withTemplate();
    const pdf = await makePdf([{ ...A4 }]);
    const r = await installAddon(t.ctx, "pack", { registry, readSource: async () => pdf });
    expect(r.templates).toEqual({ created: ["Merchant Application"], skipped: [] });
    const tpl = t.db.rows("sign_templates");
    expect(tpl).toHaveLength(1);
    expect(tpl[0]).toMatchObject({ name: "Merchant Application", status: "draft", addon_key: "pack", addon_version: "1.0", customised: false, tags: ["merchant"], description: "From the pack" });
    expect(tpl[0].category_id).toBe(t.db.rows("sign_categories")[0].id);
    const current = t.db.rows("sign_template_versions").find((v) => v.id === tpl[0].current_version_id)!;
    expect(current.fields).toEqual(fields);
    expect(current.roles).toEqual(roles);
    expect(current.defaults).toMatchObject({ expiry_days: 10 });
  });

  it("never overwrites or duplicates a template the workspace already has or has edited", async () => {
    const registry = withTemplate();
    const pdf = await makePdf([{ ...A4 }]);
    await installAddon(t.ctx, "pack", { registry, readSource: async () => pdf });
    // the workspace edits it
    t.db.rows("sign_templates")[0].customised = true;
    t.db.rows("sign_templates")[0].description = "Our own words";
    const again = await installAddon(t.ctx, "pack", { registry, readSource: async () => pdf });
    expect(again.templates).toEqual({ created: [], skipped: ["Merchant Application"] });
    expect(t.db.rows("sign_templates")).toHaveLength(1);
    expect(t.db.rows("sign_templates")[0]).toMatchObject({ customised: true, description: "Our own words" });
  });

  it("records nothing and says why when a source file is missing, so a second try can finish the job", async () => {
    const registry = withTemplate();
    await expect(
      installAddon(t.ctx, "pack", {
        registry,
        readSource: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toMatchObject({ code: "addon_source_missing" });
    expect(t.db.rows("sign_addons")).toHaveLength(0);
    expect(t.db.rows("sign_templates")).toHaveLength(0);
    const pdf = await makePdf([{ ...A4 }]);
    await installAddon(t.ctx, "pack", { registry, readSource: async () => pdf });
    expect(t.db.rows("sign_addons")).toHaveLength(1);
    expect(t.db.rows("sign_templates")).toHaveLength(1);
  });
});

describe("the catalogue", () => {
  it("shows the add-on as available and not installed, then installed", async () => {
    let cards = await listAddonCards(t.ctx);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ key: "merchant", version: "1.0", available: true, installed: null, updateAvailable: false, category: { key: "merchant_agreements", name: "Merchant agreements" }, templates: { installable: 0, announced: 0 } });
    await installAddon(t.ctx, "merchant");
    cards = await listAddonCards(t.ctx);
    expect(cards[0].installed).toMatchObject({ version: "1.0" });
    expect(cards[0].updateAvailable).toBe(false);
  });

  it("shows it as not available when the operator has not allowed it", async () => {
    t = setup({ sign: true, sign_merchant: false });
    expect((await listAddonCards(t.ctx))[0].available).toBe(false);
  });

  it("flags a newer manifest version as an update (applying it comes later)", async () => {
    t.db.seed("sign_addons", [{ account_id: ACCT, addon_key: "merchant", installed_version: "0.9", installed_at: "2026-09-01T00:00:00Z", status: "installed" }]);
    expect((await listAddonCards(t.ctx))[0]).toMatchObject({ installed: { version: "0.9" }, updateAvailable: true });
  });

  it("does not show a removed add-on as installed", async () => {
    t.db.seed("sign_addons", [{ account_id: ACCT, addon_key: "merchant", installed_version: "1.0", installed_at: "2026-09-01T00:00:00Z", status: "removed" }]);
    expect((await listAddonCards(t.ctx))[0].installed).toBeNull();
  });
});
