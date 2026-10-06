// ============================================================
// Certificates for sealing. Production uses a certificate the workspace uploads (a .p12 or .pfx
// from a certificate authority, or the operator's own). This module also makes a self-signed one
// for development and tests, and reads the facts about an uploaded one that the Settings screen
// shows (subject, issuer, serial, dates, fingerprint) and that sealing needs (it must hold a key and be
// valid today).
//
// An upload is checked before it is kept (`inspectP12`): the passphrase opens it, it holds an RSA private key
// of at least 2048 bits whose certificate is in the file, the certificate is valid today, its key usage
// (when it says) allows signing, and the chain of certificates above it is intact. It is then written out
// again in one plain shape (leaf first, then the certificates that vouch for it, a fresh passphrase), so a
// file made by any tool is stored the same way and the signing library reads it the same way.
// ============================================================

import forge from "node-forge";

/** Smallest RSA key an uploaded certificate may have. */
export const MIN_KEY_BITS = 2048;

export type CertificateCode =
  | "p12_unreadable"
  | "p12_bad_passphrase"
  | "p12_no_key"
  | "p12_expired"
  | "p12_not_yet_valid"
  | "p12_key_too_small"
  | "p12_unsupported_algorithm"
  | "p12_key_usage"
  | "p12_key_mismatch"
  | "p12_chain_invalid";

/** Things worth showing that do not stop the certificate being used. */
export type CertificateWarning = "chain_missing" | "weak_signature_algorithm" | "chain_certificate_expired" | "not_for_document_signing";

export interface P12Facts {
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** The certificate names itself as its own issuer (no authority vouches for it). */
  selfSigned: boolean;
  /** Certificates in the signature's chain: the signer's first, then each one above it that the file holds. */
  chainLength: number;
  /** Uppercase hexadecimal, no leading zeros. */
  serial: string;
  /** SHA-256 of the signing certificate, lowercase hexadecimal. */
  fingerprint: string;
  /** Size of the RSA key. */
  keyBits: number;
  /** The key usages the certificate lists, or null when it has no key usage extension. */
  keyUsage: string[] | null;
  /** The signature algorithm of the certificate, by name. */
  signatureAlgorithm: string;
  /** The chain, signer first. */
  chain: { subject: string; issuer: string }[];
  warnings: CertificateWarning[];
}

export class CertificateError extends Error {
  readonly code: CertificateCode;
  constructor(code: CertificateCode, message: string) {
    super(message);
    this.name = "CertificateError";
    this.code = code;
  }
}

function nameOf(attrs: forge.pki.CertificateField[]): string {
  const get = (sn: string) => attrs.find((a) => a.shortName === sn)?.value as string | undefined;
  const parts = [get("CN"), get("O"), get("C")].filter(Boolean);
  return parts.length ? parts.join(", ") : attrs.map((a) => `${a.shortName}=${String(a.value)}`).join(", ");
}

const SIGNATURE_NAMES: Record<string, string> = {
  "1.2.840.113549.1.1.2": "md2WithRSA",
  "1.2.840.113549.1.1.4": "md5WithRSA",
  "1.2.840.113549.1.1.5": "sha1WithRSA",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.113549.1.1.11": "sha256WithRSA",
  "1.2.840.113549.1.1.12": "sha384WithRSA",
  "1.2.840.113549.1.1.13": "sha512WithRSA",
  "1.2.840.10040.4.3": "dsaWithSHA1",
  "1.2.840.10045.4.1": "ecdsaWithSHA1",
  "1.2.840.10045.4.3.2": "ecdsaWithSHA256",
  "1.2.840.10045.4.3.3": "ecdsaWithSHA384",
  "1.2.840.10045.4.3.4": "ecdsaWithSHA512",
};
/** Signature algorithms readers are phasing out: allowed, with a warning. */
const WEAK_SIGNATURES = new Set(["1.2.840.113549.1.1.5", "1.2.840.10040.4.3", "1.2.840.10045.4.1"]);

/** What a certificate with an extended key usage list must carry for a PDF reader to accept it for signing documents. */
const SIGNING_PURPOSES = ["emailProtection", "1.3.6.1.4.1.311.10.3.12", "1.2.840.113583.1.1.5", "2.5.29.37.0", "1.3.6.1.5.5.7.3.4"];

const KEY_USAGE_NAMES = ["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign", "encipherOnly", "decipherOnly"];

interface Opened {
  key: forge.pki.rsa.PrivateKey;
  leaf: forge.pki.Certificate;
  /** Signer first, then the certificates above it that the file holds, in order. */
  chain: forge.pki.Certificate[];
  facts: P12Facts;
}

const sameKey = (a: forge.pki.rsa.PublicKey | null | undefined, b: forge.pki.rsa.PrivateKey): boolean =>
  !!a && !!(a as forge.pki.rsa.PublicKey).n && a.n.compareTo(b.n) === 0 && a.e.compareTo(b.e) === 0;

function fingerprintOf(cert: forge.pki.Certificate): string {
  const md = forge.md.sha256.create();
  md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  return md.digest().toHex();
}

function parse(p12: Uint8Array, passphrase: string, now: Date): Opened {
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(p12).toString("binary")));
  } catch {
    throw new CertificateError("p12_unreadable", "This file is not a certificate file (.p12 or .pfx).");
  }
  let store: forge.pkcs12.Pkcs12Pfx;
  try {
    store = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // check the algorithm words first: "unsupported MAC algorithm" also contains "MAC"
    if (/unsupported|private key|RSAPrivateKey|PBE|cipher|algorithm|OID/i.test(msg) && !/Invalid password/i.test(msg)) {
      throw new CertificateError("p12_unsupported_algorithm", "This certificate file uses a kind of key or encryption that cannot be read. Only RSA keys are supported.");
    }
    if (/password|mac/i.test(msg)) throw new CertificateError("p12_bad_passphrase", "The passphrase does not open this certificate file.");
    throw new CertificateError("p12_unreadable", "This file is not a certificate file (.p12 or .pfx).");
  }

  const keyBags = [
    ...(store.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(store.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  if (keyBags.length === 0) throw new CertificateError("p12_no_key", "This certificate file has no private key, so it cannot sign.");
  const key = keyBags.map((b) => b.key as forge.pki.rsa.PrivateKey | undefined).find((k) => !!k && !!k.n);
  if (!key) throw new CertificateError("p12_unsupported_algorithm", "This certificate file uses a kind of key that cannot be read. Only RSA keys are supported.");

  const certBags = store.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (certs.length === 0) throw new CertificateError("p12_unreadable", "This certificate file holds no certificate.");

  // The signer's certificate is the one whose public key is the private key's.
  const leaf = certs.find((c) => sameKey(c.publicKey as forge.pki.rsa.PublicKey | undefined, key));
  if (!leaf) throw new CertificateError("p12_key_mismatch", "The private key in this file does not belong to any certificate in it.");

  // The chain above it: each certificate that issued the one below, checked by its signature.
  const chain: forge.pki.Certificate[] = [leaf];
  let current = leaf;
  while (!current.isIssuer(current)) {
    const candidates = certs.filter((c) => !chain.includes(c) && current.isIssuer(c));
    if (candidates.length === 0) break;
    const verdicts = candidates.map((c) => {
      try {
        return { c, ok: c.verify(current) as boolean | undefined };
      } catch (err) {
        // a signature algorithm the library cannot check is not a fault of the file; a signature that does not decrypt is
        const msg = err instanceof Error ? err.message : "";
        return { c, ok: /unknown|unsupported|OID|scheme/i.test(msg) ? undefined : false };
      }
    });
    const next = verdicts.find((v) => v.ok !== false);
    if (!next) throw new CertificateError("p12_chain_invalid", "A certificate in this file is not signed by the one above it, so the chain is broken. Ask the certificate authority for the complete chain.");
    chain.push(next.c);
    current = next.c;
  }

  const selfSigned = leaf.isIssuer(leaf);
  const keyUsageExt = leaf.getExtension("keyUsage") as Record<string, unknown> | null;
  const keyUsage = keyUsageExt ? KEY_USAGE_NAMES.filter((n) => keyUsageExt[n] === true) : null;
  const sigOid = leaf.siginfo?.algorithmOid ?? leaf.signatureOid ?? "";

  const warnings: CertificateWarning[] = [];
  if (!selfSigned && chain.length === 1) warnings.push("chain_missing");
  if (WEAK_SIGNATURES.has(sigOid) || chain.some((c) => WEAK_SIGNATURES.has(c.siginfo?.algorithmOid ?? ""))) warnings.push("weak_signature_algorithm");
  if (chain.slice(1).some((c) => now > c.validity.notAfter || now < c.validity.notBefore)) warnings.push("chain_certificate_expired");
  const eku = leaf.getExtension("extKeyUsage") as Record<string, unknown> | null;
  if (eku && !SIGNING_PURPOSES.some((p) => eku[p] === true)) warnings.push("not_for_document_signing");

  const facts: P12Facts = {
    subject: nameOf(leaf.subject.attributes),
    issuer: nameOf(leaf.issuer.attributes),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
    selfSigned: selfSigned || nameOf(leaf.subject.attributes) === nameOf(leaf.issuer.attributes),
    chainLength: chain.length,
    serial: leaf.serialNumber.replace(/^0+/, "").toUpperCase() || "0",
    fingerprint: fingerprintOf(leaf),
    keyBits: key.n.bitLength(),
    keyUsage,
    signatureAlgorithm: SIGNATURE_NAMES[sigOid] ?? (sigOid || "unknown"),
    chain: chain.map((c) => ({ subject: nameOf(c.subject.attributes), issuer: nameOf(c.issuer.attributes) })),
    warnings,
  };
  return { key, leaf, chain, facts };
}

/** Open a PKCS#12 file and describe its signing certificate. Throws CertificateError. */
export function readP12(p12: Uint8Array, passphrase: string, now: Date = new Date()): P12Facts {
  return parse(p12, passphrase, now).facts;
}

/** Throws when the certificate is not valid at `now`. */
export function assertValidNow(facts: P12Facts, now: Date = new Date()): void {
  if (now < facts.notBefore) throw new CertificateError("p12_not_yet_valid", "This certificate is not valid yet.");
  if (now > facts.notAfter) throw new CertificateError("p12_expired", "This certificate has expired.");
}

/** What a certificate must be to be accepted as a sealing certificate. Throws CertificateError. */
export function assertUsableForSealing(facts: P12Facts): void {
  if (facts.keyBits < MIN_KEY_BITS) {
    throw new CertificateError("p12_key_too_small", `The key is ${facts.keyBits} bits. A sealing certificate needs an RSA key of at least ${MIN_KEY_BITS} bits.`);
  }
  if (facts.signatureAlgorithm === "md2WithRSA" || facts.signatureAlgorithm === "md5WithRSA") {
    throw new CertificateError("p12_unsupported_algorithm", `The certificate is signed with ${facts.signatureAlgorithm}, which is not safe and is refused.`);
  }
  // A key usage extension, when the certificate has one, must allow signing.
  if (facts.keyUsage && !facts.keyUsage.includes("digitalSignature") && !facts.keyUsage.includes("nonRepudiation")) {
    throw new CertificateError("p12_key_usage", "This certificate is not allowed to sign: its key usage lists neither digital signature nor non-repudiation.");
  }
}

export interface InspectedP12 {
  facts: P12Facts;
  /** The same key and certificates in one plain shape, protected by `passphrase`; what is stored. */
  p12: Uint8Array;
  passphrase: string;
}

/**
 * Check an uploaded certificate file and make the copy that is kept. Throws CertificateError with a stable
 * code for every way a file can be unfit. The original file and its passphrase are not kept: the copy is
 * encrypted by the key ring and opened with a passphrase made here.
 */
export function inspectP12(p12: Uint8Array, passphrase: string, newPassphrase: string, now: Date = new Date()): InspectedP12 {
  const opened = parse(p12, passphrase, now);
  assertValidNow(opened.facts, now);
  assertUsableForSealing(opened.facts);
  const out = forge.pkcs12.toPkcs12Asn1(opened.key, opened.chain, newPassphrase, { algorithm: "3des" });
  return { facts: opened.facts, p12: new Uint8Array(Buffer.from(forge.asn1.toDer(out).getBytes(), "binary")), passphrase: newPassphrase };
}

export interface SelfSignedOptions {
  commonName: string;
  organization?: string;
  country?: string;
  passphrase: string;
  years?: number;
  /** RSA key size. 2048 unless a test wants it faster. */
  bits?: number;
  notBefore?: Date;
}

/**
 * A self-signed signing certificate as a PKCS#12 file. For development and tests: a reader shows it
 * as "not trusted", which is the honest state of a certificate no authority vouches for.
 */
export function createSelfSignedP12(opts: SelfSignedOptions): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair({ bits: opts.bits ?? 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const from = opts.notBefore ?? new Date(Date.now() - 5 * 60 * 1000);
  cert.validity.notBefore = from;
  cert.validity.notAfter = new Date(from.getTime() + (opts.years ?? 2) * 365 * 24 * 3600 * 1000);
  const attrs: forge.pki.CertificateField[] = [{ name: "commonName", value: opts.commonName }];
  if (opts.organization) attrs.push({ name: "organizationName", value: opts.organization });
  if (opts.country) attrs.push({ name: "countryName", value: opts.country });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.passphrase, { algorithm: "3des" });
  return new Uint8Array(Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"));
}
