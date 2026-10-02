import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectWhatsAppIds,
  parseAppSecrets,
  verifyMetaWebhookSignature,
  verifyWhatsAppWebhook,
  type TenantSecretRow,
  type WhatsAppIds,
} from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, signedHeader(body))).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyMetaWebhookSignature(body, signedHeader(body, "wrong"))).toBe(
      false,
    );
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaWebhookSignature("anything", null)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto
      .createHmac("sha256", SECRET)
      .update(body)
      .digest("hex");
    expect(verifyMetaWebhookSignature(body, hex)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyMetaWebhookSignature("{}", "sha256=tooshort")).toBe(false);
  });

  describe("several comma-separated secrets (issue #500)", () => {
    const originalSecret = process.env.META_APP_SECRET;
    const SECOND = "second-app-secret";
    const THIRD = "third-app-secret";
    beforeEach(() => {
      // Deliberately messy: stray spaces and an empty slot, which an
      // operator editing a hosting panel's env field will produce.
      process.env.META_APP_SECRET = ` ${SECRET} , ${SECOND},,${THIRD} `;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it("accepts a request signed by any configured app", () => {
      const body = '{"entry":[{"id":"waba-under-app-2"}]}';
      expect(verifyMetaWebhookSignature(body, signedHeader(body, SECRET))).toBe(true);
      expect(verifyMetaWebhookSignature(body, signedHeader(body, SECOND))).toBe(true);
      expect(verifyMetaWebhookSignature(body, signedHeader(body, THIRD))).toBe(true);
    });

    it("still rejects a signature from an app that is not configured", () => {
      const body = "{}";
      expect(
        verifyMetaWebhookSignature(body, signedHeader(body, "some-fourth-app")),
      ).toBe(false);
    });

    it("does not treat the empty slot between commas as a valid secret", () => {
      const body = "{}";
      expect(verifyMetaWebhookSignature(body, signedHeader(body, ""))).toBe(false);
    });

    it("rejects tampering regardless of which app signed", () => {
      const header = signedHeader('{"a":1}', SECOND);
      expect(verifyMetaWebhookSignature('{"a":2}', header)).toBe(false);
    });
  });

  describe("parseAppSecrets", () => {
    it("splits on commas, trims, and drops empties", () => {
      expect(parseAppSecrets(" a , b,,c ,")).toEqual(["a", "b", "c"]);
    });

    it("returns a single secret unchanged", () => {
      expect(parseAppSecrets("only-one")).toEqual(["only-one"]);
    });

    it("returns nothing for unset, empty, or comma-only values", () => {
      expect(parseAppSecrets(undefined)).toEqual([]);
      expect(parseAppSecrets("")).toEqual([]);
      expect(parseAppSecrets(" , ,")).toEqual([]);
    });
  });

  describe("fail-closed when secret is missing", () => {
    const originalSecret = process.env.META_APP_SECRET;
    beforeEach(() => {
      delete process.env.META_APP_SECRET;
    });
    afterEach(() => {
      process.env.META_APP_SECRET = originalSecret;
    });

    it("rejects even a correctly-formed signature when no secret is configured", () => {
      const body = "{}";
      // Use the original secret to produce the header so we can verify
      // the rejection is solely due to missing config.
      const header = signedHeader(body, originalSecret!);
      expect(verifyMetaWebhookSignature(body, header)).toBe(false);
    });

    it("treats a value of only commas and spaces as not configured", () => {
      process.env.META_APP_SECRET = " , ";
      const body = "{}";
      expect(verifyMetaWebhookSignature(body, signedHeader(body, " , "))).toBe(false);
      expect(verifyMetaWebhookSignature(body, signedHeader(body, ""))).toBe(false);
    });
  });
});

// ------------------------------------------------------------------
// Workspace-bound verification (migration 136)
// ------------------------------------------------------------------

const delivery = (...phoneIds: string[]) =>
  JSON.stringify({
    entry: phoneIds.map((id) => ({
      id: "waba-x",
      changes: [{ field: "messages", value: { metadata: { phone_number_id: id }, messages: [] } }],
    })),
  });

const templateEvent = (wabaId: string) =>
  JSON.stringify({
    entry: [{ id: wabaId, changes: [{ field: "message_template_status_update", value: {} }] }],
  });

// Rows as the database would return them; "enc:" stands in for encryption.
const rowsFor = (rows: TenantSecretRow[]) => async (ids: WhatsAppIds) =>
  rows.filter(
    (r) =>
      (r.phone_number_id && ids.phoneNumberIds.includes(r.phone_number_id)) ||
      (r.waba_id && ids.wabaIds.includes(r.waba_id)),
  );
const dec = (c: string) => {
  if (!c.startsWith("enc:")) throw new Error("bad ciphertext");
  return c.slice(4);
};
const tenant = (phone: string, waba: string, secret: string): TenantSecretRow => ({
  phone_number_id: phone,
  waba_id: waba,
  app_secret_enc: "enc:" + secret,
});

describe("collectWhatsAppIds", () => {
  it("reads phone numbers from message changes and WABAs from template events", () => {
    expect(collectWhatsAppIds(JSON.parse(delivery("p1", "p2", "p1")))).toEqual({
      phoneNumberIds: ["p1", "p2"],
      wabaIds: [],
    });
    expect(collectWhatsAppIds(JSON.parse(templateEvent("w9")))).toEqual({ phoneNumberIds: [], wabaIds: ["w9"] });
  });

  it("tolerates junk without throwing", () => {
    for (const junk of [null, undefined, 5, "x", {}, { entry: "no" }, { entry: [null, {}, { changes: "no" }] }]) {
      expect(collectWhatsAppIds(junk)).toEqual({ phoneNumberIds: [], wabaIds: [] });
    }
  });
});

describe("verifyWhatsAppWebhook", () => {
  const B = tenant("pn-b", "waba-b", "tenant-b-secret");
  const A = tenant("pn-a", "waba-a", "tenant-a-secret");

  it("accepts an operator-owned secret for any number, without touching the database", async () => {
    let asked = false;
    const body = delivery("pn-anything");
    const ok = await verifyWhatsAppWebhook(body, signedHeader(body), async () => {
      asked = true;
      return [];
    }, dec);
    expect(ok).toBe(true);
    expect(asked).toBe(false);
  });

  it("accepts a workspace's own secret for its own number", async () => {
    const body = delivery("pn-b");
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(true);
  });

  it("rejects a workspace's secret on a payload that names ANOTHER workspace's number", async () => {
    const body = delivery("pn-a");
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(false);
  });

  it("rejects a payload that mixes the signer's number with someone else's", async () => {
    const body = delivery("pn-b", "pn-a");
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(false);
  });

  it("rejects a workspace's secret for a number nobody has registered", async () => {
    const body = delivery("pn-unknown");
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(false);
  });

  it("binds template events by WABA the same way", async () => {
    const own = templateEvent("waba-b");
    expect(await verifyWhatsAppWebhook(own, signedHeader(own, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(true);
    const foreign = templateEvent("waba-a");
    expect(await verifyWhatsAppWebhook(foreign, signedHeader(foreign, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(false);
  });

  it("rejects when no stored secret matches, the signature is malformed, or the body is not JSON", async () => {
    const body = delivery("pn-b");
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "nope"), rowsFor([A, B]), dec)).toBe(false);
    expect(await verifyWhatsAppWebhook(body, null, rowsFor([A, B]), dec)).toBe(false);
    expect(await verifyWhatsAppWebhook(body, "abc", rowsFor([A, B]), dec)).toBe(false);
    const junk = "not json";
    expect(await verifyWhatsAppWebhook(junk, signedHeader(junk, "tenant-b-secret"), rowsFor([A, B]), dec)).toBe(false);
  });

  it("fails closed when the lookup throws, a secret cannot be decrypted, or the payload names nothing", async () => {
    const body = delivery("pn-b");
    const header = signedHeader(body, "tenant-b-secret");
    expect(await verifyWhatsAppWebhook(body, header, async () => { throw new Error("db down"); }, dec)).toBe(false);
    const broken: TenantSecretRow = { phone_number_id: "pn-b", waba_id: "waba-b", app_secret_enc: "garbage" };
    expect(await verifyWhatsAppWebhook(body, header, rowsFor([broken]), dec)).toBe(false);
    const empty = "{}";
    expect(await verifyWhatsAppWebhook(empty, signedHeader(empty, "tenant-b-secret"), rowsFor([B]), dec)).toBe(false);
  });

  it("ignores rows that hold no secret", async () => {
    const body = delivery("pn-b");
    const none: TenantSecretRow = { phone_number_id: "pn-b", waba_id: "waba-b", app_secret_enc: null };
    expect(await verifyWhatsAppWebhook(body, signedHeader(body, "tenant-b-secret"), rowsFor([none]), dec)).toBe(false);
  });
});

