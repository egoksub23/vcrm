// ============================================================
// The certificate a workspace's documents are sealed with. A workspace can upload one (Settings, a
// .p12 or .pfx from a certificate authority). Until it does, the first seal makes a self-signed one for
// the workspace and keeps it, so signing is never blocked: the seal still detects any change made after
// sealing, but a PDF reader will say the signer is not trusted, which is true of any self-signed
// certificate. The key and its passphrase are encrypted with the key ring (the same as every secret).
//
// A certificate the workspace uploaded is never replaced silently. If it has expired, sealing stops with a
// clear reason (the document waits, see sign_hold_sealing) until a valid one is installed; falling back to a
// self-signed certificate behind the owner's back would put a seal on the document that its owner never chose.
// Only the certificate Halo made itself is renewed automatically.
// ============================================================

import { randomBytes } from "node:crypto";

import { PDFDocument } from "pdf-lib";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { SELF_SIGNED_NAME_PREFIX } from "../client/admin-settings";
import type { CertificateView } from "../client/certificate-view";
import { savePdf } from "../pdf/load";
import { CertificateError, assertValidNow, createSelfSignedP12, inspectP12, readP12, type P12Facts } from "../pdf/p12";
import { SealError, sealPdf } from "../pdf/seal";
import { verifySealed } from "../pdf/verify";
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

export interface CertRow {
  id: string;
  name: string;
  /** Absent on a row older than migration 165. */
  source?: string | null;
  p12_enc: string;
  passphrase_enc: string;
  valid_until: string | null;
  is_default: boolean;
}

/** Codes of the errors that mean "the certificate is the problem": the document waits for a person to fix it. */
export const CERTIFICATE_HOLD_CODES: ReadonlySet<string> = new Set(["certificate_expired", "certificate_not_valid_yet", "certificate_unreadable"]);

/** Made by Halo (self-signed) rather than uploaded. */
export const isGeneratedCertificate = (row: Pick<CertRow, "name" | "source">): boolean => (row.source ? row.source === "generated" : row.name.startsWith(SELF_SIGNED_NAME_PREFIX));

/** The certificate in use: the workspace's chosen one, else its default, else any. */
export function pickCertificate<T extends { id: string; is_default: boolean }>(rows: readonly T[], chosenId: string | null | undefined): T | null {
  return rows.find((c) => c.id === chosenId) ?? rows.find((c) => c.is_default) ?? rows[0] ?? null;
}

function open(row: CertRow): { p12: Uint8Array; passphrase: string } {
  const passphrase = decrypt(row.passphrase_enc);
  const p12 = new Uint8Array(Buffer.from(decrypt(row.p12_enc), "base64"));
  return { p12, passphrase };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The uploaded certificate, or a SignError saying plainly why it cannot seal today. */
function openUploaded(row: CertRow, now: Date): SealingCertificate {
  let opened: { p12: Uint8Array; passphrase: string };
  let facts: P12Facts;
  try {
    opened = open(row);
    facts = readP12(opened.p12, opened.passphrase, now);
  } catch (err) {
    console.error("[sign] sealing certificate unreadable:", err instanceof Error ? err.message : err);
    throw new SignError("certificate_unreadable", "The sealing certificate could not be opened. Install the certificate again in Settings > Secure Sign > Sealing certificate.", 409);
  }
  try {
    assertValidNow(facts, now);
  } catch (err) {
    if (err instanceof CertificateError && err.code === "p12_expired") {
      throw new SignError("certificate_expired", `The sealing certificate expired on ${day(facts.notAfter)}. Install a renewed certificate in Settings > Secure Sign > Sealing certificate; this document is then sealed automatically.`, 409);
    }
    throw new SignError("certificate_not_valid_yet", `The sealing certificate is not valid until ${day(facts.notBefore)}. Install a certificate that is valid today in Settings > Secure Sign > Sealing certificate.`, 409);
  }
  return { p12: opened.p12, passphrase: opened.passphrase, facts, generated: false };
}

/**
 * The certificate to seal with: the workspace's chosen one, else its default, else a new self-signed one.
 * An uploaded certificate that cannot be used throws (never a quiet downgrade); an expired self-signed one
 * made by Halo is renewed.
 */
export async function sealingCertificate(ctx: SignCtx): Promise<SealingCertificate> {
  const settings = await loadSettings(ctx);
  const rows = await ctx.admin.from("sign_certificates").select("id, name, source, p12_enc, passphrase_enc, valid_until, is_default").eq("account_id", ctx.accountId);
  if (rows.error) raiseDatabaseError(rows.error, "load certificates");
  const all = (rows.data ?? []) as CertRow[];
  const now = ctx.now();
  const chosen = pickCertificate(all, settings.certificate_id);
  if (chosen && !isGeneratedCertificate(chosen)) return openUploaded(chosen, now);

  const candidates = [chosen, ...all.filter(isGeneratedCertificate)].filter((c, i, a): c is CertRow => !!c && a.indexOf(c) === i);
  for (const row of candidates) {
    try {
      const { p12, passphrase } = open(row);
      const facts = readP12(p12, passphrase, now);
      assertValidNow(facts, now);
      return { p12, passphrase, facts, generated: true };
    } catch (err) {
      // an expired or unreadable self-signed certificate is skipped; the next candidate is tried, then a new one is made
      if (!(err instanceof CertificateError)) console.error("[sign] certificate unusable:", err instanceof Error ? err.message : err);
    }
  }
  return createWorkspaceCertificate(ctx, all);
}

async function createWorkspaceCertificate(ctx: SignCtx, existing: readonly CertRow[]): Promise<SealingCertificate> {
  const acct = await ctx.admin.from("accounts").select("name").eq("id", ctx.accountId).maybeSingle();
  const name = (acct.data as { name?: string } | null)?.name?.trim() || "Workspace";
  const passphrase = randomBytes(24).toString("hex");
  const p12 = createSelfSignedP12({ commonName: `${name} (Vircle Secure Sign)`, organization: name, passphrase, years: 5 });
  const facts = readP12(p12, passphrase);
  // the one default allowed per workspace: an expired self-signed default gives way to the new one
  const stale = existing.filter((c) => c.is_default && isGeneratedCertificate(c));
  for (const c of stale) await ctx.admin.from("sign_certificates").update({ is_default: false }).eq("id", c.id).eq("account_id", ctx.accountId);
  const { data, error } = await ctx.admin
    .from("sign_certificates")
    .insert({
      account_id: ctx.accountId,
      name: `${SELF_SIGNED_NAME_PREFIX} (not trusted by PDF readers)`,
      source: "generated",
      subject: facts.subject,
      valid_until: facts.notAfter.toISOString(),
      p12_enc: encrypt(Buffer.from(p12).toString("base64")),
      passphrase_enc: encrypt(passphrase),
      is_default: true,
    })
    .select("id")
    .maybeSingle();
  // if another seal made one at the same moment the insert is refused, and this one is simply not kept
  if (error && !/duplicate|unique/i.test(error.message)) throw new SignError("certificate_failed", "Could not create a sealing certificate.", 500);
  const id = (data as { id?: string } | null)?.id;
  if (id) await ctx.admin.from("sign_settings").update({ certificate_id: id }).eq("account_id", ctx.accountId);
  return { p12, passphrase, facts, generated: true };
}

// ---- what Settings shows ----------------------------------------------------------------------------

export type { CertificateView };

function viewOf(row: CertRow, facts: P12Facts | null): CertificateView {
  const uploaded = !isGeneratedCertificate(row);
  return {
    id: row.id,
    name: row.name,
    uploaded,
    subject: facts?.subject ?? null,
    issuer: facts?.issuer ?? null,
    serial: facts?.serial ?? null,
    validFrom: facts?.notBefore.toISOString() ?? null,
    validUntil: facts?.notAfter.toISOString() ?? row.valid_until,
    selfSigned: facts ? facts.selfSigned : !uploaded,
    fingerprint: facts?.fingerprint ?? null,
    chainLength: facts?.chainLength ?? null,
    keyBits: facts?.keyBits ?? null,
    warnings: facts?.warnings ?? [],
    readable: !!facts,
  };
}

/** The certificate the next document will be sealed with, described, or null before there is one. Never returns the key. */
export async function describeSealingCertificate(ctx: SignCtx): Promise<CertificateView | null> {
  const settings = await loadSettings(ctx);
  const { data, error } = await ctx.admin.from("sign_certificates").select("id, name, source, subject, p12_enc, passphrase_enc, valid_until, is_default").eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "load certificate facts");
  const chosen = pickCertificate((data ?? []) as (CertRow & { subject: string | null })[], settings.certificate_id);
  if (!chosen) return null;
  try {
    const { p12, passphrase } = open(chosen);
    return viewOf(chosen, readP12(p12, passphrase, ctx.now()));
  } catch (err) {
    console.error("[sign] could not read the sealing certificate for Settings:", err instanceof Error ? err.message : err);
    return { ...viewOf(chosen, null), subject: chosen.subject };
  }
}

// ---- installing one -------------------------------------------------------------------------------

/** The biggest certificate file taken: a key with a chain is a few kilobytes. */
export const MAX_CERTIFICATE_BYTES = 256 * 1024;

/** A tiny PDF, sealed and read back: the certificate must be able to do the one thing it is for. */
async function selfTest(kept: { p12: Uint8Array; passphrase: string }, facts: P12Facts, now: Date): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  try {
    const sealed = await sealPdf(await savePdf(doc), kept.p12, kept.passphrase, { name: "Vircle Secure Sign certificate check", reason: "Certificate check", signingTime: now });
    const v = verifySealed(sealed.bytes);
    if (!v.ok || v.certificateCount !== facts.chainLength) throw new SignError("certificate_self_test_failed", "A test seal made with this certificate could not be verified.", 422);
  } catch (err) {
    if (err instanceof SignError) throw err;
    if (err instanceof SealError && err.code === "seal_too_large") throw new SignError("certificate_chain_too_large", "The certificate chain is too long to fit in a seal. Remove certificates the authority does not require, or ask it for a shorter chain.", 422);
    throw new SignError("certificate_self_test_failed", "A test seal made with this certificate failed.", 422);
  }
}

/**
 * Check an uploaded .p12 or .pfx and make it the workspace's sealing certificate. Everything that can be wrong with
 * the file is refused with its own code and a plain message (the screen words the code); nothing is stored then.
 * What is stored is a clean copy under a passphrase made here, so the file's own passphrase is not kept.
 */
export async function installCertificate(ctx: SignCtx, args: { bytes: Uint8Array; passphrase: string; name?: string | null }): Promise<CertificateView> {
  if (args.bytes.byteLength === 0) throw new SignError("p12_unreadable", "This file is empty.", 422);
  if (args.bytes.byteLength > MAX_CERTIFICATE_BYTES) throw new SignError("certificate_file_too_large", "This file is too large to be a certificate file.", 413);
  const now = ctx.now();
  const keptPassphrase = randomBytes(24).toString("hex");
  let kept;
  try {
    kept = inspectP12(args.bytes, args.passphrase, keptPassphrase, now);
  } catch (err) {
    if (err instanceof CertificateError) throw new SignError(err.code, err.message, 422);
    throw err;
  }
  await selfTest(kept, kept.facts, now);

  const base = kept.facts.subject.split(",")[0].trim() || "certificate";
  let name = (args.name?.trim() || `Uploaded: ${base}`).slice(0, 120);
  // the prefix is how a self-signed certificate made by Halo is recognised on rows older than migration 165
  if (name.startsWith(SELF_SIGNED_NAME_PREFIX)) name = `Uploaded: ${name}`.slice(0, 120);
  const { data, error } = await ctx.admin.rpc("sign_install_certificate", {
    p_account: ctx.accountId,
    p_name: name,
    p_subject: kept.facts.subject.slice(0, 500),
    p_valid_until: kept.facts.notAfter.toISOString(),
    p_p12_enc: encrypt(Buffer.from(kept.p12).toString("base64")),
    p_passphrase_enc: encrypt(kept.passphrase),
    p_user: ctx.userId,
  });
  if (error) raiseDatabaseError(error, "install certificate");
  return viewOf({ id: String(data), name, source: "uploaded", p12_enc: "", passphrase_enc: "", valid_until: kept.facts.notAfter.toISOString(), is_default: true }, kept.facts);
}

/** Remove an uploaded certificate (and its key). Documents sealed with it are unchanged; the next seal uses another one. */
export async function removeCertificate(ctx: SignCtx, id: string): Promise<void> {
  const { data, error } = await ctx.admin.from("sign_certificates").delete().eq("id", id).eq("account_id", ctx.accountId).eq("source", "uploaded").select("id");
  if (error) raiseDatabaseError(error, "remove certificate");
  if (!data || data.length === 0) throw new SignError("certificate_not_found", "That certificate was not found.", 404);
}
