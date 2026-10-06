import { beforeEach, describe, expect, it } from "vitest";

import { stripListOptions } from "../forms/lists";
import type { FormDefinition } from "../forms/types";
import type { SignCtx } from "../service/context";
import { FakeDb } from "../service/fake-db";
import { withSystemLists } from "./fixtures";
import { canonicalJson, contentFingerprint, equalsAny } from "./fingerprint";
import { ADDON_REGISTRY, changesSince, type AddonManifest, type AddonRegistry } from "./index";
import { installAddon, listAddonCards } from "./install";
import { merchantAddon } from "./merchant";
import { MERCHANT_FORM, MERCHANT_FORM_V1, MERCHANT_ROLES, merchantForm } from "./merchant/form";
import { MERCHANT_PLACEMENTS } from "./merchant/layout";
import { copyName, updateAddon } from "./update";

const ACCT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";

/** Add-on 1.1 as it was shipped: the same template with the form that has every option typed in, and nothing earlier in its history. */
const V11: AddonRegistry = {
  merchant: {
    ...merchantAddon,
    version: "1.1",
    changes: [],
    history: [],
    templates: [{ ...merchantAddon.templates[0], form: MERCHANT_FORM_V1 }],
  },
};

function setup(features: Record<string, boolean> = { sign: true, sign_merchant: true }) {
  const db = new FakeDb();
  const ctx: SignCtx = {
    admin: db.client(),
    accountId: ACCT,
    userId: USER,
    origin: "https://halo.test",
    deps: { emailConfigured: () => true, sendEmail: async () => {}, loadIdentity: async () => ({ fromName: "x" }), sendWhatsApp: async () => {} },
    now: () => new Date("2026-10-08T08:00:00Z"),
  };
  db.seed("account_platform", [{ account_id: ACCT, status: "active", features, limits: {} }]);
  db.seed("sign_settings", [{ id: "s1", account_id: ACCT, default_expiry_days: 14, reminder_days: [3, 7], default_language: "en", consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null }]);
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  withSystemLists(db, ACCT);
  return { db, ctx };
}

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

/** A workspace that installed 1.1 and has not touched anything. */
async function onVersion11() {
  await installAddon(t.ctx, "merchant", { registry: V11 });
  return t.db.rows("sign_templates")[0];
}
const versionsOf = (templateId: unknown) => t.db.rows("sign_template_versions").filter((v) => v.template_id === templateId);
const currentOf = (tpl: Record<string, unknown>) => t.db.rows("sign_template_versions").find((v) => v.id === tpl.current_version_id)!;

describe("the content fingerprint", () => {
  it("does not depend on key order, undefined members, or the options a list copied into a field", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }] }, b: 1 }));
    const shipped = { roles: MERCHANT_ROLES, fields: MERCHANT_PLACEMENTS, defaults: {}, form: MERCHANT_FORM };
    const stored: FormDefinition = { ...MERCHANT_FORM, fields: MERCHANT_FORM.fields.map((f) => (f.optionList ? { ...f, options: [{ value: "x", label: { en: "relabelled by the workspace" } }] } : f)) };
    expect(contentFingerprint({ ...shipped, form: stored })).toBe(contentFingerprint(shipped));
    expect(stripListOptions(stored)).toEqual(MERCHANT_FORM);
  });

  it("tells a changed field from an unchanged one", () => {
    const base = { roles: MERCHANT_ROLES, fields: MERCHANT_PLACEMENTS, defaults: {}, form: MERCHANT_FORM };
    expect(contentFingerprint({ ...base, fields: [{ ...MERCHANT_PLACEMENTS[0], x: MERCHANT_PLACEMENTS[0].x + 0.01 }, ...MERCHANT_PLACEMENTS.slice(1)] })).not.toBe(contentFingerprint(base));
    expect(equalsAny(base, [])).toBe(false);
    expect(equalsAny(base, [{ ...base, defaults: { expiry_days: 99 } }, base])).toBe(true);
  });

  it("sees the generations of the Merchant form as different, and the shipped history as the generation-1 form", () => {
    const [v11] = merchantAddon.history![0].templates;
    expect(v11.form).toBe(MERCHANT_FORM_V1);
    const now = merchantAddon.templates[0];
    expect(contentFingerprint(v11)).not.toBe(contentFingerprint(now));
    expect(merchantAddon.history![0].version).toBe("1.1");
  });
});

describe("updating the Merchant add-on from 1.1 to 2.0", () => {
  it("gives a template nobody edited a new version with the shared lists and the sensitive answers, and records the update", async () => {
    const tpl = await onVersion11();
    const before = currentOf(tpl);
    expect(before.version_no).toBe(2);
    expect((await listAddonCards(t.ctx, ADDON_REGISTRY))[0]).toMatchObject({ updateAvailable: true, installed: { version: "1.1" } });

    const r = await updateAddon(t.ctx, "merchant");
    expect(r).toMatchObject({ key: "merchant", fromVersion: "1.1", toVersion: "2.0", upToDate: false, templates: [{ name: "Merchant Application", outcome: "updated", versionNo: 3 }] });

    // no second template: the same one, one version later, and the old versions are all still there
    expect(t.db.rows("sign_templates")).toHaveLength(1);
    expect(versionsOf(tpl.id).map((v) => v.version_no)).toEqual([1, 2, 3]);
    const now = currentOf(t.db.rows("sign_templates")[0]);
    expect(now.version_no).toBe(3);
    expect(t.db.rows("sign_templates")[0]).toMatchObject({ addon_version: "2.0", customised: false, name: "Merchant Application" });
    const form = now.form as FormDefinition;
    const field = (k: string) => form.fields.find((f) => f.key === k)!;
    // choices come from the lists (stored with the items copied in), the answers that identify a person or an account are sensitive
    expect(field("state")).toMatchObject({ optionList: "states_my" });
    expect(field("state").options).toHaveLength(16);
    expect(field("bank_name").options?.length).toBeGreaterThan(10);
    expect(field("msic_codes").options?.length).toBeGreaterThan(1000);
    expect(field("bank_account")).toMatchObject({ sensitive: true, printMasked: "last4" });
    expect(field("brn")).toMatchObject({ sensitive: true });
    expect(field("tin").sensitive).toBeUndefined();
    // the file, the placements and the roles are the ones that were there
    expect(now.source_path).toBe(before.source_path);
    expect(now.fields).toEqual(MERCHANT_PLACEMENTS);
    expect(now.roles).toEqual(MERCHANT_ROLES);
    // the update is recorded where the database logs it (the trigger on sign_addons: who, from which version)
    expect(t.db.rows("sign_addons")[0]).toMatchObject({ installed_version: "2.0", installed_by: USER, status: "installed" });
    expect((await listAddonCards(t.ctx))[0]).toMatchObject({ updateAvailable: false, installed: { version: "2.0" } });
  });

  it("is safe to press twice: the second time does nothing", async () => {
    await onVersion11();
    await updateAddon(t.ctx, "merchant");
    const versions = t.db.rows("sign_template_versions").length;
    const again = await updateAddon(t.ctx, "merchant");
    expect(again).toMatchObject({ upToDate: true, templates: [], fromVersion: "2.0", toVersion: "2.0" });
    expect(t.db.rows("sign_template_versions")).toHaveLength(versions);
    expect(t.db.rows("sign_templates")).toHaveLength(1);
  });

  it("still updates in place a template the workspace only renamed in the list or made active (those are not edits of its content)", async () => {
    const tpl = await onVersion11();
    tpl.status = "active";
    tpl.description = "Our own description";
    tpl.tags = ["ours"];
    const r = await updateAddon(t.ctx, "merchant");
    expect(r.templates[0]).toMatchObject({ outcome: "updated" });
    expect(t.db.rows("sign_templates")).toHaveLength(1);
    expect(t.db.rows("sign_templates")[0]).toMatchObject({ status: "active", description: "Our own description", tags: ["ours"], addon_version: "2.0" });
  });

  it("leaves a template the workspace changed exactly as it is and makes a new copy next to it, and says so", async () => {
    const tpl = await onVersion11();
    // the workspace moved a field and saved: a new version of its own, and the template is marked customised
    const own = currentOf(tpl);
    const moved = (own.fields as typeof MERCHANT_PLACEMENTS).map((f, i) => (i === 0 ? { ...f, x: f.x + 0.02 } : f));
    t.db.seed("sign_template_versions", [{ ...own, id: "mine", version_no: 3, fields: moved }]);
    tpl.current_version_id = "mine";
    tpl.customised = true;
    const snapshot = JSON.stringify([t.db.rows("sign_templates")[0], versionsOf(tpl.id)]);

    const r = await updateAddon(t.ctx, "merchant");
    expect(r.templates).toEqual([{ name: "Merchant Application", outcome: "copied", copyName: "Merchant Application (updated)" }]);
    // the original, and all its versions, are untouched
    expect(JSON.stringify([t.db.rows("sign_templates").find((x) => x.id === tpl.id), versionsOf(tpl.id)])).toBe(snapshot);
    // the copy is a draft of the new version, marked as the add-on's and not customised
    const copy = t.db.rows("sign_templates").find((x) => x.name === "Merchant Application (updated)")!;
    expect(copy).toMatchObject({ status: "draft", addon_key: "merchant", addon_version: "2.0", customised: false });
    const form = currentOf(copy).form as FormDefinition;
    expect(form.fields.find((f) => f.key === "bank_account")).toMatchObject({ sensitive: true });
    expect(currentOf(copy).fields).toEqual(MERCHANT_PLACEMENTS);
    expect(t.db.rows("sign_addons")[0].installed_version).toBe("2.0");
  });

  it("treats a changed form, changed roles or changed defaults as the workspace's own too", async () => {
    for (const edit of [
      (v: Record<string, unknown>) => (v.form = merchantForm({ generation: 1, bankRole: "finance" })),
      (v: Record<string, unknown>) => (v.roles = (v.roles as typeof MERCHANT_ROLES).slice(0, 2)),
      (v: Record<string, unknown>) => (v.defaults = { ...(v.defaults as object), expiry_days: 7 }),
    ]) {
      t = setup();
      const tpl = await onVersion11();
      edit(currentOf(tpl));
      const r = await updateAddon(t.ctx, "merchant");
      expect(r.templates[0].outcome).toBe("copied");
    }
  });

  it("makes a copy when the file the add-on ships is not the file the template has", async () => {
    const tpl = await onVersion11();
    currentOf(tpl).source_sha256 = "f".repeat(64);
    expect((await updateAddon(t.ctx, "merchant")).templates[0].outcome).toBe("copied");
  });

  it("names a second copy (updated 2) when the first is still there, and never takes a name the workspace uses", async () => {
    expect(copyName("Merchant Application", new Set())).toBe("Merchant Application (updated)");
    expect(copyName("Merchant Application", new Set(["merchant application (updated)"]))).toBe("Merchant Application (updated 2)");
    expect(copyName("Merchant Application", new Set(["merchant application (updated)", "merchant application (updated 2)"]))).toBe("Merchant Application (updated 3)");
    const tpl = await onVersion11();
    currentOf(tpl).defaults = { expiry_days: 7 };
    t.db.seed("sign_templates", [{ id: "someone-elses-name", account_id: ACCT, name: "merchant application (UPDATED)", status: "draft", addon_key: null }]);
    const r = await updateAddon(t.ctx, "merchant");
    expect(r.templates[0]).toMatchObject({ outcome: "copied", copyName: "Merchant Application (updated 2)" });
  });

  it("does nothing for a template the workspace deleted, and does not bring it back", async () => {
    const tpl = await onVersion11();
    t.db.tables.sign_templates = t.db.rows("sign_templates").filter((x) => x.id !== tpl.id);
    const r = await updateAddon(t.ctx, "merchant");
    expect(r.templates).toEqual([{ name: "Merchant Application", outcome: "missing" }]);
    expect(t.db.rows("sign_templates")).toHaveLength(0);
    expect(t.db.rows("sign_addons")[0].installed_version).toBe("2.0");
  });

  it("never changes a document that was sent, or a draft made from the old version", async () => {
    const tpl = await onVersion11();
    const v = currentOf(tpl);
    const sent = { id: "d1", account_id: ACCT, title: "Sent", status: "sent", template_version_id: v.id, fields_snapshot: v.fields, roles_snapshot: v.roles, form_snapshot: v.form, merge_values: {} };
    const draft = { ...sent, id: "d2", title: "Draft", status: "draft" };
    t.db.seed("sign_documents", [sent, draft]);
    const before = JSON.stringify(t.db.rows("sign_documents"));
    await updateAddon(t.ctx, "merchant");
    expect(JSON.stringify(t.db.rows("sign_documents"))).toBe(before);
    // the old version, which both of them point at, is still there as it was
    expect(t.db.rows("sign_template_versions").find((x) => x.id === v.id)?.form).toEqual(MERCHANT_FORM_V1);
  });

  it("leaves another workspace's templates and add-on record alone", async () => {
    await onVersion11();
    t.db.seed("sign_templates", [{ id: "theirs", account_id: OTHER, name: "Merchant Application", addon_key: "merchant", addon_version: "1.1", current_version_id: null, customised: false }]);
    t.db.seed("sign_addons", [{ account_id: OTHER, addon_key: "merchant", installed_version: "1.1", status: "installed" }]);
    await updateAddon(t.ctx, "merchant");
    expect(t.db.rows("sign_templates").find((x) => x.id === "theirs")).toMatchObject({ addon_version: "1.1" });
    expect(t.db.rows("sign_addons").find((x) => x.account_id === OTHER)).toMatchObject({ installed_version: "1.1" });
  });

  it("refuses an add-on that was never installed, one the operator has not allowed, and one that does not exist", async () => {
    await expect(updateAddon(t.ctx, "merchant")).rejects.toMatchObject({ code: "addon_not_installed", status: 409 });
    await expect(updateAddon(t.ctx, "nothing")).rejects.toMatchObject({ code: "addon_not_found", status: 404 });
    await onVersion11();
    t.db.tables.account_platform = [{ account_id: ACCT, status: "active", features: { sign: true, sign_merchant: false }, limits: {} }];
    await expect(updateAddon(t.ctx, "merchant")).rejects.toMatchObject({ code: "addon_not_available", status: 403 });
  });

  it("records nothing when a form is refused, so pressing Update again repeats it", async () => {
    await onVersion11();
    const broken: AddonRegistry = { merchant: { ...merchantAddon, templates: [{ ...merchantAddon.templates[0], form: { ...MERCHANT_FORM, fields: [{ ...MERCHANT_FORM.fields[0], part: "nowhere" }] } }] } as AddonManifest };
    await expect(updateAddon(t.ctx, "merchant", { registry: broken })).rejects.toMatchObject({ code: "invalid_layout" });
    expect(t.db.rows("sign_addons")[0].installed_version).toBe("1.1");
    expect((await updateAddon(t.ctx, "merchant")).templates[0].outcome).toBe("updated");
  });
});

describe("installing again on a workspace that has an older version", () => {
  it("adds what is missing but does not move the recorded version forward: only Update does", async () => {
    await onVersion11();
    const r = await installAddon(t.ctx, "merchant");
    expect(r).toMatchObject({ previousVersion: "1.1", version: "1.1", templates: { created: [], skipped: ["Merchant Application"] } });
    expect(t.db.rows("sign_addons")[0].installed_version).toBe("1.1");
    expect((await listAddonCards(t.ctx))[0]).toMatchObject({ updateAvailable: true });
  });
});

describe("what an update says", () => {
  it("lists the changes newer than the installed version, oldest first, up to the current one", () => {
    expect(changesSince(merchantAddon, "1.1").map((c) => c.version)).toEqual(["2.0"]);
    expect(changesSince(merchantAddon, "2.0")).toEqual([]);
    const many = { ...merchantAddon, version: "2.1", changes: [{ version: "2.1", items: { en: ["b"] } }, { version: "2.0", items: { en: ["a"] } }, { version: "3.0", items: { en: ["future"] } }] };
    expect(changesSince(many, "1.1").map((c) => c.version)).toEqual(["2.0", "2.1"]);
  });
});
