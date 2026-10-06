// ============================================================
// Certificates for sealing. Production uses a certificate the workspace uploads (a .p12 or .pfx
// from a certificate authority, or the operator's own). This module also makes a self-signed one
// for development and tests, and reads the facts about an uploaded one that the Settings screen
// shows (subject, expiry) and that sealing needs (it must hold a key and be valid today).
// ============================================================

import forge from "node-forge";

export interface P12Facts {
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
  /** Certificates in the file, the signer's first. */
  chainLength: number;
}

export class CertificateError extends Error {
  readonly code: "p12_unreadable" | "p12_bad_passphrase" | "p12_no_key" | "p12_expired" | "p12_not_yet_valid";
  constructor(code: CertificateError["code"], message: string) {
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

/** Open a PKCS#12 file and describe its signing certificate. Throws CertificateError. */
export function readP12(p12: Uint8Array, passphrase: string): P12Facts {
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
    if (/password|mac/i.test(msg)) throw new CertificateError("p12_bad_passphrase", "The passphrase does not open this certificate file.");
    throw new CertificateError("p12_unreadable", "This file is not a certificate file (.p12 or .pfx).");
  }
  const keyBags = store.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeyBags = store.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  if (keyBags.length + plainKeyBags.length === 0) {
    throw new CertificateError("p12_no_key", "This certificate file has no private key, so it cannot sign.");
  }
  const certBags = store.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (certs.length === 0) throw new CertificateError("p12_unreadable", "This certificate file holds no certificate.");
  // The signer's certificate is the one whose key matches the private key; fall back to the first.
  const cert = certs[0];
  const selfSigned = cert.issued(cert) || nameOf(cert.subject.attributes) === nameOf(cert.issuer.attributes);
  return {
    subject: nameOf(cert.subject.attributes),
    issuer: nameOf(cert.issuer.attributes),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    selfSigned,
    chainLength: certs.length,
  };
}

/** Throws when the certificate is not valid at `now`. */
export function assertValidNow(facts: P12Facts, now: Date = new Date()): void {
  if (now < facts.notBefore) throw new CertificateError("p12_not_yet_valid", "This certificate is not valid yet.");
  if (now > facts.notAfter) throw new CertificateError("p12_expired", "This certificate has expired.");
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
