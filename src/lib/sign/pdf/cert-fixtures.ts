// ============================================================
// Test certificates: a small certificate authority, an intermediate and a signer, with every property a
// test wants to vary (key size, dates, key usage, extended key usage, signature hash). Imported only by
// tests. Keys come from Node's own generator, which is fast; forge reads them.
// ============================================================

import { generateKeyPairSync } from "node:crypto";

import forge from "node-forge";

export interface Party {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}

const keys = new Map<string, forge.pki.rsa.KeyPair>();

/** An RSA key pair, made once per `slot` and size so a test file does not pay for a key twice. */
export function rsaKey(bits = 2048, slot = "default"): forge.pki.rsa.KeyPair {
  const id = `${bits}:${slot}`;
  let pair = keys.get(id);
  if (!pair) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: bits,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    pair = { publicKey: forge.pki.publicKeyFromPem(publicKey), privateKey: forge.pki.privateKeyFromPem(privateKey) };
    keys.set(id, pair);
  }
  return pair;
}

export interface IssueOptions {
  commonName: string;
  organization?: string;
  /** Signed by this party; self-signed when absent. */
  issuer?: Party;
  bits?: number;
  /** Key pairs are shared by slot: two certificates with different slots never share a key. */
  slot?: string;
  notBefore?: Date;
  notAfter?: Date;
  /** A certificate authority (can issue certificates). */
  ca?: boolean;
  /** The key usage extension: the flags to set, null for no extension at all. */
  keyUsage?: Record<string, boolean> | null;
  /** Extended key usage flags, or undefined for no extension. */
  extKeyUsage?: Record<string, boolean>;
  hash?: "sha256" | "sha1" | "md5";
}

const DAY = 24 * 3600 * 1000;

export function issue(o: IssueOptions): Party {
  const pair = rsaKey(o.bits ?? 2048, o.slot ?? o.commonName);
  const cert = forge.pki.createCertificate();
  cert.publicKey = pair.publicKey;
  cert.serialNumber = "0" + forge.util.bytesToHex(forge.random.getBytesSync(8));
  const from = o.notBefore ?? new Date(Date.now() - 2 * DAY);
  cert.validity.notBefore = from;
  cert.validity.notAfter = o.notAfter ?? new Date(from.getTime() + 365 * DAY);
  const subject: forge.pki.CertificateField[] = [{ name: "commonName", value: o.commonName }];
  if (o.organization) subject.push({ name: "organizationName", value: o.organization });
  subject.push({ name: "countryName", value: "MY" });
  cert.setSubject(subject);
  cert.setIssuer(o.issuer ? o.issuer.cert.subject.attributes : subject);
  const ext: Record<string, unknown>[] = [{ name: "basicConstraints", cA: !!o.ca, critical: !!o.ca }];
  const ku = o.keyUsage === undefined ? (o.ca ? { keyCertSign: true, cRLSign: true } : { digitalSignature: true, nonRepudiation: true }) : o.keyUsage;
  if (ku) ext.push({ name: "keyUsage", ...ku, critical: true });
  if (o.extKeyUsage) ext.push({ name: "extKeyUsage", ...o.extKeyUsage });
  ext.push({ name: "subjectKeyIdentifier" });
  cert.setExtensions(ext);
  const signer = o.issuer ? o.issuer.key : pair.privateKey;
  const md = o.hash === "sha1" ? forge.md.sha1.create() : o.hash === "md5" ? forge.md.md5.create() : forge.md.sha256.create();
  cert.sign(signer, md);
  return { cert, key: pair.privateKey };
}

/** A root, an intermediate and a signing certificate, the way a certificate authority issues them. */
export function chain(over: Partial<IssueOptions> = {}): { root: Party; intermediate: Party; leaf: Party } {
  const root = issue({ commonName: "Test Root CA", organization: "Test Trust Sdn Bhd", ca: true, bits: 2048, notAfter: new Date(Date.now() + 3650 * DAY) });
  const intermediate = issue({ commonName: "Test Issuing CA", organization: "Test Trust Sdn Bhd", ca: true, issuer: root, notAfter: new Date(Date.now() + 1800 * DAY) });
  const leaf = issue({ commonName: "Kedai Runcit Ali Sdn Bhd", organization: "Kedai Runcit Ali", issuer: intermediate, ...over });
  return { root, intermediate, leaf };
}

/** A PKCS#12 file with `key` and the certificates in the order given (the signer's first). */
export function p12Of(key: forge.pki.rsa.PrivateKey, certs: forge.pki.Certificate[], passphrase: string, algorithm: "3des" | "aes256" = "3des"): Uint8Array {
  const out = forge.pkcs12.toPkcs12Asn1(key, certs, passphrase, { algorithm });
  return new Uint8Array(Buffer.from(forge.asn1.toDer(out).getBytes(), "binary"));
}

/** A PKCS#12 file that holds certificates and no key. */
export function certOnlyP12(certs: forge.pki.Certificate[], passphrase: string): Uint8Array {
  const out = forge.pkcs12.toPkcs12Asn1(null, certs, passphrase, { algorithm: "3des" });
  return new Uint8Array(Buffer.from(forge.asn1.toDer(out).getBytes(), "binary"));
}

export const pem = (c: forge.pki.Certificate) => forge.pki.certificateToPem(c);
export const keyPem = (k: forge.pki.rsa.PrivateKey) => forge.pki.privateKeyToPem(k);
