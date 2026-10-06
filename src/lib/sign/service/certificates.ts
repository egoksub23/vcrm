// ============================================================
// The certificate a workspace's documents are sealed with. A workspace can upload one (Settings, a
// .p12 or .pfx from a certificate authority). Until it does, the first seal makes a self-signed one for
// the workspace and keeps it, so signing is never blocked: the seal still detects any change made after
// sealing, but a PDF reader will say the signer is not trusted, which is true of any self-signed
// certificate. The key and its passphrase are encrypted with the key ring (the same as every secret).
// ============================================================

import { randomBytes } from "node:crypto";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { CertificateError, assertValidNow, createSelfSignedP12, readP12, type P12Facts } from "../pdf/p12";
import type { SignCtx } from "./context";
import { loadSettings } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

export interface SealingCertificate {
  p12: Uint8Array;
  passphrase: string;
  facts: P12Facts;
  /** Made by Halo for this workspace, not uploaded. */
  generated: boolean;
}

interface CertRow {
  id: string;
  name: string;
  p12_enc: string;
  passphrase_enc: string;
  valid_until: string | null;
  is_default: boolean;
}

function open(row: CertRow): { p12: Uint8Array; passphrase: string } {
  const passphrase = decrypt(row.passphrase_enc);
  const p12 = new Uint8Array(Buffer.from(decrypt(row.p12_enc), "base64"));
  return { p12, passphrase };
}

/** The certificate to seal with: the workspace's chosen one, else its default, else a new self-signed one. */
export async function sealingCertificate(ctx: SignCtx): Promise<SealingCertificate> {
  const settings = await loadSettings(ctx);
  const rows = await ctx.admin.from("sign_certificates").select("id, name, p12_enc, passphrase_enc, valid_until, is_default").eq("account_id", ctx.accountId);
  if (rows.error) raiseDatabaseError(rows.error, "load certificates");
  const all = (rows.data ?? []) as CertRow[];
  const now = ctx.now();
  const candidates = [all.find((c) => c.id === settings.certificate_id), all.find((c) => c.is_default), ...all].filter((c): c is CertRow => !!c);
  for (const row of candidates) {
    try {
      const { p12, passphrase } = open(row);
      const facts = readP12(p12, passphrase);
      assertValidNow(facts, now);
      return { p12, passphrase, facts, generated: row.name.startsWith("Halo self-signed") };
    } catch (err) {
      // an expired or unreadable certificate is skipped; the next candidate is tried
      if (!(err instanceof CertificateError)) console.error("[sign] certificate unusable:", err instanceof Error ? err.message : err);
    }
  }
  return createWorkspaceCertificate(ctx);
}

async function createWorkspaceCertificate(ctx: SignCtx): Promise<SealingCertificate> {
  const acct = await ctx.admin.from("accounts").select("name").eq("id", ctx.accountId).maybeSingle();
  const name = (acct.data as { name?: string } | null)?.name?.trim() || "Workspace";
  const passphrase = randomBytes(24).toString("hex");
  const p12 = createSelfSignedP12({ commonName: `${name} (Halo Doc Sign)`, organization: name, passphrase, years: 5 });
  const facts = readP12(p12, passphrase);
  const { error } = await ctx.admin.from("sign_certificates").insert({
    account_id: ctx.accountId,
    name: "Halo self-signed (not trusted by PDF readers)",
    subject: facts.subject,
    valid_until: facts.notAfter.toISOString(),
    p12_enc: encrypt(Buffer.from(p12).toString("base64")),
    passphrase_enc: encrypt(passphrase),
    // the one default allowed per workspace; if another was created at the same moment the insert is refused
    is_default: true,
  });
  if (error && !/duplicate|unique/i.test(error.message)) throw new SignError("certificate_failed", "Could not create a sealing certificate.", 500);
  return { p12, passphrase, facts, generated: true };
}
