// ============================================================
// Checking a sealed file. This does not trust the sealing code: it reads the signature out of the
// PDF itself and checks, with node-forge, that
//   - the signed byte ranges cover the whole file except the signature value,
//   - those bytes hash to the digest the signature carries, and
//   - the signature verifies against the certificate inside it.
// It does not decide whether the certificate is trusted (that needs the reader's trust list);
// it reports whether it is self-signed so the screen can say so honestly.
// ============================================================

import forge from "node-forge";

import { sha256Hex } from "./load";
import type { VerifyResult } from "./types";

const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_SHA1 = "1.3.14.3.2.26";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
const OID_SHA512 = "2.16.840.1.101.3.4.2.3";

function mdFor(oid: string): forge.md.MessageDigest | null {
  switch (oid) {
    case OID_SHA1:
      return forge.md.sha1.create();
    case OID_SHA256:
      return forge.md.sha256.create();
    case OID_SHA384:
      return forge.md.sha384.create();
    case OID_SHA512:
      return forge.md.sha512.create();
    default:
      return null;
  }
}

interface ByteRange {
  a: number;
  b: number;
  c: number;
  d: number;
}

function findByteRanges(text: string): ByteRange[] {
  const out: ByteRange[] = [];
  for (const m of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    out.push({ a: Number(m[1]), b: Number(m[2]), c: Number(m[3]), d: Number(m[4]) });
  }
  return out;
}

function binary(u8: Uint8Array): string {
  return Buffer.from(u8).toString("binary");
}

const isContext = (n: forge.asn1.Asn1, type: number) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === type;

/** Check the signature in a sealed PDF. Never throws on a bad file: the problems are listed. */
export function verifySealed(pdf: Uint8Array): VerifyResult {
  const sha256 = sha256Hex(pdf);
  const problems: string[] = [];
  const result: VerifyResult = {
    ok: false,
    signatureCount: 0,
    signatureValid: false,
    digestMatches: false,
    coversWholeFile: false,
    sha256,
    problems,
  };

  const text = Buffer.from(pdf).toString("latin1");
  const ranges = findByteRanges(text);
  result.signatureCount = ranges.length;
  if (ranges.length === 0) {
    problems.push("The file carries no signature.");
    return result;
  }
  if (ranges.length > 1) problems.push("The file carries more than one signature; only one was expected.");
  // The sealing signature is the last one: it covers everything before it.
  const r = ranges[ranges.length - 1];

  // 1. Coverage: from the start of the file to the signature value, and from after it to the end.
  const gapStart = r.a + r.b;
  const gapEnd = r.c;
  result.coversWholeFile = r.a === 0 && gapEnd > gapStart && r.c + r.d === pdf.byteLength;
  if (!result.coversWholeFile) problems.push("The signature does not cover the whole file.");
  if (text[gapStart] !== "<" || text[gapEnd - 1] !== ">") {
    problems.push("The signature value is not where the signed ranges say it is.");
    return result;
  }

  // 2. The signed bytes and the signature value.
  const signed = new Uint8Array(r.b + r.d);
  signed.set(pdf.subarray(r.a, r.a + r.b), 0);
  signed.set(pdf.subarray(r.c, r.c + r.d), r.b);
  const hex = text.slice(gapStart + 1, gapEnd - 1).replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length < 16) {
    problems.push("The signature value is damaged.");
    return result;
  }
  const der = Buffer.from(hex, "hex").toString("binary");

  try {
    // The signature value is zero-padded to the placeholder's size, so trailing bytes are expected. The
    // options object is supported at runtime; the bundled typings still declare a boolean.
    const lenient = { strict: false, parseAllBytes: false } as unknown as boolean;
    const root = forge.asn1.fromDer(forge.util.createBuffer(der), lenient);
    const signedData = (root.value as forge.asn1.Asn1[])[1]?.value as forge.asn1.Asn1[] | undefined;
    const sd = signedData?.[0]?.value as forge.asn1.Asn1[] | undefined;
    if (!sd) throw new Error("not a SignedData structure");

    const certNode = sd.find((n) => isContext(n, 0));
    const signerInfos = sd[sd.length - 1];
    const certs = ((certNode?.value as forge.asn1.Asn1[]) ?? []).map((c) => forge.pki.certificateFromAsn1(c));
    const si = ((signerInfos.value as forge.asn1.Asn1[])[0]?.value as forge.asn1.Asn1[]) ?? [];
    if (si.length < 5) throw new Error("no signer information");

    const sid = si[1].value as forge.asn1.Asn1[];
    const digestOid = forge.asn1.derToOid((((si[2].value as forge.asn1.Asn1[])[0]).value as string));
    const hasAttrs = isContext(si[3], 0);
    const attrs = hasAttrs ? (si[3].value as forge.asn1.Asn1[]) : [];
    const signature = String((hasAttrs ? si[5] : si[4]).value);

    // The certificate that made the signature: matched by serial number and issuer.
    const serialHex = forge.util.bytesToHex(String(sid[1].value)).replace(/^0+/, "");
    const issuerDer = forge.asn1.toDer(sid[0]).getBytes();
    const cert = certs.find(
      (c) =>
        c.serialNumber.replace(/^0+/, "") === serialHex &&
        forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(c.issuer)).getBytes() === issuerDer,
    );
    if (!cert) throw new Error("the signing certificate is not in the signature");

    const md = mdFor(digestOid);
    if (!md) throw new Error(`unsupported digest algorithm ${digestOid}`);
    const own = mdFor(digestOid)!;
    own.update(binary(signed));
    const fileDigest = own.digest().getBytes();

    let signedBytes: string;
    if (hasAttrs) {
      // The digest of the document is one of the signed attributes; the signature is over the attributes.
      let messageDigest: string | null = null;
      for (const a of attrs) {
        const parts = a.value as forge.asn1.Asn1[];
        const oid = forge.asn1.derToOid(String(parts[0].value));
        const first = (parts[1].value as forge.asn1.Asn1[])[0];
        if (oid === OID_MESSAGE_DIGEST) messageDigest = String(first.value);
        if (oid === OID_SIGNING_TIME) {
          const when = first.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(String(first.value)) : forge.asn1.generalizedTimeToDate(String(first.value));
          result.signingTime = when;
        }
      }
      result.digestMatches = messageDigest !== null && messageDigest === fileDigest;
      if (!result.digestMatches) problems.push("The file does not match the digest in the signature: it was changed after sealing.");
      const asSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      signedBytes = forge.asn1.toDer(asSet).getBytes();
    } else {
      result.digestMatches = true;
      signedBytes = binary(signed);
    }

    const sigMd = mdFor(digestOid)!;
    sigMd.update(signedBytes);
    result.signatureValid = (cert.publicKey as forge.pki.rsa.PublicKey).verify(sigMd.digest().getBytes(), signature);
    if (!result.signatureValid) problems.push("The signature does not verify against its certificate.");

    result.signer = {
      subject: nameString(cert.subject.attributes),
      issuer: nameString(cert.issuer.attributes),
      notBefore: cert.validity.notBefore,
      notAfter: cert.validity.notAfter,
      selfSigned: nameString(cert.subject.attributes) === nameString(cert.issuer.attributes) && cert.isIssuer(cert),
    };
  } catch (err) {
    problems.push(`The signature could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const reason = /\/Reason\s*\(([^)]*)\)/.exec(text);
  if (reason) result.reason = reason[1];
  result.ok = ranges.length === 1 && result.coversWholeFile && result.digestMatches && result.signatureValid && problems.length === 0;
  return result;
}

function nameString(attrs: forge.pki.CertificateField[]): string {
  const get = (sn: string) => attrs.find((a) => a.shortName === sn)?.value as string | undefined;
  const parts = [get("CN"), get("O"), get("C")].filter(Boolean);
  return parts.join(", ");
}
