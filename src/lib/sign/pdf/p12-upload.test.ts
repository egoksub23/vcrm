// Checking an uploaded certificate (`inspectP12`) and sealing with one that came from an authority: every way a
// file can be unfit has its own code, a chain survives into the signature, and the copy that is kept opens
// with its own passphrase. Certificates are generated here (cert-fixtures.ts); where openssl is installed,
// files made by openssl itself are read too, because that is what a certificate authority hands out.

import { X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CertificateError, MIN_KEY_BITS, inspectP12, readP12 } from "./p12";
import { certOnlyP12, chain, issue, keyPem, p12Of, pem, rsaKey } from "./cert-fixtures";
import { sealPdf } from "./seal";
import { verifySealed } from "./verify";
import { A4, makePdf } from "./fixtures";

const PASS = "correct horse";
const KEPT = "kept-passphrase";
const DAY = 24 * 3600 * 1000;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CertificateError) return e.code;
    throw e;
  }
  return "no error";
}

const inspect = (p12: Uint8Array, now?: Date) => inspectP12(p12, PASS, KEPT, now);

describe("reading a certificate from an authority", () => {
  const c = chain();
  const file = p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert, c.root.cert], PASS);

  it("describes the signer, who issued it, and the chain above it", () => {
    const f = readP12(file, PASS);
    expect(f.subject).toBe("Kedai Runcit Ali Sdn Bhd, Kedai Runcit Ali, MY");
    expect(f.issuer).toContain("Test Issuing CA");
    expect(f.selfSigned).toBe(false);
    expect(f.chainLength).toBe(3);
    expect(f.chain.map((x) => x.subject.split(",")[0])).toEqual(["Kedai Runcit Ali Sdn Bhd", "Test Issuing CA", "Test Root CA"]);
    expect(f.keyBits).toBe(2048);
    expect(f.signatureAlgorithm).toBe("sha256WithRSA");
    expect(f.keyUsage).toEqual(["digitalSignature", "nonRepudiation"]);
    expect(f.warnings).toEqual([]);
  });

  it("reports the serial and the SHA-256 fingerprint the way other tools do", () => {
    const f = readP12(file, PASS);
    const x = new X509Certificate(pem(c.leaf.cert));
    expect(f.fingerprint).toBe(x.fingerprint256.replace(/:/g, "").toLowerCase());
    expect(f.serial).toBe(x.serialNumber.replace(/^0+/, ""));
  });

  it("finds the signer's certificate wherever it sits in the file", () => {
    const f = readP12(p12Of(c.leaf.key, [c.root.cert, c.intermediate.cert, c.leaf.cert], PASS), PASS);
    expect(f.subject).toContain("Kedai Runcit Ali");
    expect(f.chain.map((x) => x.subject.split(",")[0])).toEqual(["Kedai Runcit Ali Sdn Bhd", "Test Issuing CA", "Test Root CA"]);
  });

  it("calls a certificate that names itself as issuer self-signed", () => {
    const s = issue({ commonName: "Self Made", slot: "self" });
    const f = readP12(p12Of(s.key, [s.cert], PASS), PASS);
    expect(f.selfSigned).toBe(true);
    expect(f.chainLength).toBe(1);
    expect(f.warnings).toEqual([]);
  });

  it("warns that a CA-issued certificate comes without the certificates above it", () => {
    const f = readP12(p12Of(c.leaf.key, [c.leaf.cert], PASS), PASS);
    expect(f.selfSigned).toBe(false);
    expect(f.warnings).toContain("chain_missing");
  });

  it("leaves out certificates that are not part of the chain", () => {
    const stranger = issue({ commonName: "Somebody Else", slot: "stranger" });
    const f = readP12(p12Of(c.leaf.key, [c.leaf.cert, stranger.cert, c.intermediate.cert], PASS), PASS);
    expect(f.chainLength).toBe(2);
  });
});

describe("the keeps-it-or-refuses-it checks", () => {
  const c = chain();

  it("accepts a good CA-issued file and keeps the whole chain under a passphrase of its own", () => {
    const kept = inspect(p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert], PASS));
    expect(kept.passphrase).toBe(KEPT);
    expect(() => readP12(kept.p12, PASS)).toThrow(/passphrase/);
    const again = readP12(kept.p12, KEPT);
    expect(again.fingerprint).toBe(kept.facts.fingerprint);
    expect(again.chainLength).toBe(2);
  });

  it("refuses a wrong passphrase, a file that is not a certificate, and one with no private key", () => {
    expect(code(() => inspectP12(p12Of(c.leaf.key, [c.leaf.cert], PASS), "nope", KEPT))).toBe("p12_bad_passphrase");
    expect(code(() => inspect(new Uint8Array([1, 2, 3, 4])))).toBe("p12_unreadable");
    expect(code(() => inspect(certOnlyP12([c.leaf.cert, c.intermediate.cert], PASS)))).toBe("p12_no_key");
  });

  it("refuses a key that belongs to none of the certificates", () => {
    const other = rsaKey(2048, "someone-else").privateKey;
    expect(code(() => inspect(p12Of(other, [c.leaf.cert, c.intermediate.cert], PASS)))).toBe("p12_key_mismatch");
  });

  it("refuses an RSA key under 2048 bits", () => {
    const weak = issue({ commonName: "Small Key", bits: 1024, slot: "small", issuer: c.intermediate });
    expect(code(() => inspect(p12Of(weak.key, [weak.cert, c.intermediate.cert], PASS)))).toBe("p12_key_too_small");
    expect(MIN_KEY_BITS).toBe(2048);
  });

  it("refuses a certificate that has expired, or is not valid yet, and says which", () => {
    const old = issue({ commonName: "Old", slot: "old", issuer: c.intermediate, notBefore: new Date(Date.now() - 400 * DAY), notAfter: new Date(Date.now() - 35 * DAY) });
    expect(code(() => inspect(p12Of(old.key, [old.cert], PASS)))).toBe("p12_expired");
    const future = issue({ commonName: "Future", slot: "future", issuer: c.intermediate, notBefore: new Date(Date.now() + 10 * DAY), notAfter: new Date(Date.now() + 375 * DAY) });
    expect(code(() => inspect(p12Of(future.key, [future.cert], PASS)))).toBe("p12_not_yet_valid");
    // the same certificate is fine on a day it is valid
    expect(code(() => inspect(p12Of(future.key, [future.cert], PASS), new Date(Date.now() + 20 * DAY)))).toBe("no error");
  });

  it("refuses a key usage that forbids signing, and accepts either signing usage or none at all", () => {
    const tls = issue({ commonName: "Key Encipherment Only", slot: "ku1", issuer: c.intermediate, keyUsage: { keyEncipherment: true } });
    expect(code(() => inspect(p12Of(tls.key, [tls.cert], PASS)))).toBe("p12_key_usage");
    const nr = issue({ commonName: "Non Repudiation", slot: "ku2", issuer: c.intermediate, keyUsage: { nonRepudiation: true } });
    expect(code(() => inspect(p12Of(nr.key, [nr.cert], PASS)))).toBe("no error");
    const ds = issue({ commonName: "Digital Signature", slot: "ku3", issuer: c.intermediate, keyUsage: { digitalSignature: true } });
    expect(code(() => inspect(p12Of(ds.key, [ds.cert], PASS)))).toBe("no error");
    const none = issue({ commonName: "No Key Usage", slot: "ku4", issuer: c.intermediate, keyUsage: null });
    expect(readP12(p12Of(none.key, [none.cert], PASS), PASS).keyUsage).toBeNull();
    expect(code(() => inspect(p12Of(none.key, [none.cert], PASS)))).toBe("no error");
  });

  it("refuses an MD5 signature and warns about SHA-1", () => {
    const md5 = issue({ commonName: "Md5", slot: "md5", hash: "md5" });
    expect(code(() => inspect(p12Of(md5.key, [md5.cert], PASS)))).toBe("p12_unsupported_algorithm");
    const sha1 = issue({ commonName: "Sha1", slot: "sha1", hash: "sha1" });
    expect(readP12(p12Of(sha1.key, [sha1.cert], PASS), PASS).warnings).toContain("weak_signature_algorithm");
    expect(code(() => inspect(p12Of(sha1.key, [sha1.cert], PASS)))).toBe("no error");
  });

  it("refuses a chain whose link does not verify", () => {
    // a certificate that names the intermediate as its issuer but was signed with another key
    const impostor = issue({ commonName: "Impostor Issuing CA", ca: true, slot: "impostor" });
    const forged = issue({ commonName: "Forged Leaf", slot: "forged", issuer: { cert: c.intermediate.cert, key: impostor.key } });
    expect(code(() => inspect(p12Of(forged.key, [forged.cert, c.intermediate.cert], PASS)))).toBe("p12_chain_invalid");
  });

  it("warns when the certificate is not meant for signing documents, and when an authority above has expired", () => {
    const tls = issue({ commonName: "Web Server", slot: "eku", issuer: c.intermediate, extKeyUsage: { serverAuth: true } });
    expect(readP12(p12Of(tls.key, [tls.cert], PASS), PASS).warnings).toContain("not_for_document_signing");
    const mail = issue({ commonName: "Mail Signer", slot: "eku2", issuer: c.intermediate, extKeyUsage: { emailProtection: true } });
    expect(readP12(p12Of(mail.key, [mail.cert], PASS), PASS).warnings).not.toContain("not_for_document_signing");
    const deadCa = issue({ commonName: "Dead CA", ca: true, slot: "dead", notBefore: new Date(Date.now() - 900 * DAY), notAfter: new Date(Date.now() - 2 * DAY) });
    const leaf = issue({ commonName: "Under Dead CA", slot: "under", issuer: deadCa });
    expect(readP12(p12Of(leaf.key, [leaf.cert, deadCa.cert], PASS), PASS).warnings).toContain("chain_certificate_expired");
  });
});

describe("a chain in the signature", () => {
  it("puts the signer and every certificate above it into the sealed PDF, and the seal verifies", async () => {
    const c = chain();
    const kept = inspect(p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert, c.root.cert], PASS));
    const pdf = await makePdf([{ ...A4 }]);
    const sealed = await sealPdf(pdf, kept.p12, kept.passphrase, { name: "Test" });
    const v = verifySealed(sealed.bytes);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.certificateCount).toBe(3);
    expect(v.signer?.subject).toContain("Kedai Runcit Ali");
    expect(v.signer?.issuer).toContain("Test Issuing CA");
    expect(v.signer?.selfSigned).toBe(false);
  });

  it("carries only the signer for a self-signed certificate", async () => {
    const s = issue({ commonName: "Self Made", slot: "self2" });
    const kept = inspect(p12Of(s.key, [s.cert], PASS));
    const sealed = await sealPdf(await makePdf([{ ...A4 }]), kept.p12, kept.passphrase);
    const v = verifySealed(sealed.bytes);
    expect(v.ok).toBe(true);
    expect(v.certificateCount).toBe(1);
    expect(v.signer?.selfSigned).toBe(true);
  });

  it("holds a 4096-bit key with three certificates in the room the signature has", async () => {
    const root = issue({ commonName: "Big Root", ca: true, bits: 4096, slot: "big-root" });
    const mid = issue({ commonName: "Big Intermediate", ca: true, bits: 4096, issuer: root, slot: "big-mid" });
    const leaf = issue({ commonName: "Big Leaf", bits: 4096, issuer: mid, slot: "big-leaf" });
    const kept = inspect(p12Of(leaf.key, [leaf.cert, mid.cert, root.cert], PASS));
    expect(kept.facts.keyBits).toBe(4096);
    const sealed = await sealPdf(await makePdf([{ ...A4 }]), kept.p12, kept.passphrase);
    const v = verifySealed(sealed.bytes);
    expect(v.ok).toBe(true);
    expect(v.certificateCount).toBe(3);
  }, 60_000);
});

// ---- files made by openssl, as a certificate authority would hand them out ----------------------------------

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!haveOpenssl)("files made by openssl", () => {
  function make(args: { name: string; keyGen: string[]; exportArgs: string[] }): { dir: string; p12: Uint8Array } {
    const c = chain();
    const dir = mkdtempSync(path.join(tmpdir(), "p12-"));
    writeFileSync(path.join(dir, "leaf.pem"), pem(c.leaf.cert));
    writeFileSync(path.join(dir, "chain.pem"), pem(c.intermediate.cert) + pem(c.root.cert));
    writeFileSync(path.join(dir, "key.pem"), keyPem(c.leaf.key));
    const run = spawnSync("openssl", ["pkcs12", "-export", "-in", path.join(dir, "leaf.pem"), "-inkey", path.join(dir, "key.pem"), "-certfile", path.join(dir, "chain.pem"), "-passout", `pass:${PASS}`, "-out", path.join(dir, "out.p12"), ...args.exportArgs], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`openssl failed for ${args.name}: ${run.stderr}`);
    return { dir, p12: new Uint8Array(readFileSync(path.join(dir, "out.p12"))) };
  }

  it("reads openssl's default export (AES-256 and a SHA-256 MAC) and its legacy export", () => {
    for (const exportArgs of [[], ["-legacy"]]) {
      let made: { dir: string; p12: Uint8Array } | null = null;
      try {
        made = make({ name: exportArgs.join(" ") || "default", keyGen: [], exportArgs });
      } catch {
        continue; // this build of openssl does not know -legacy
      }
      const kept = inspect(made.p12);
      expect(kept.facts.chainLength).toBe(3);
      expect(readP12(kept.p12, KEPT).fingerprint).toBe(kept.facts.fingerprint);
      rmSync(made.dir, { recursive: true, force: true });
    }
  });

  it("refuses an elliptic-curve key with the unsupported-algorithm code", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p12ec-"));
    const sh = (args: string[]) => {
      const r = spawnSync("openssl", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    sh(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path.join(dir, "ec.key")]);
    sh(["req", "-new", "-x509", "-key", path.join(dir, "ec.key"), "-subj", "/CN=EC Signer", "-days", "30", "-out", path.join(dir, "ec.pem")]);
    sh(["pkcs12", "-export", "-in", path.join(dir, "ec.pem"), "-inkey", path.join(dir, "ec.key"), "-passout", `pass:${PASS}`, "-out", path.join(dir, "ec.p12")]);
    expect(code(() => inspect(new Uint8Array(readFileSync(path.join(dir, "ec.p12")))))).toBe("p12_unsupported_algorithm");
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a sealed PDF a chain that openssl can verify against the root", async () => {
    const c = chain();
    const kept = inspect(p12Of(c.leaf.key, [c.leaf.cert, c.intermediate.cert], PASS));
    const sealed = await sealPdf(await makePdf([{ ...A4 }]), kept.p12, kept.passphrase);
    const text = Buffer.from(sealed.bytes).toString("latin1");
    const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)!;
    const [a, b, cc, d] = range.slice(1).map(Number);
    const hexSig = text.slice(a + b + 1, cc - 1).replace(/\s+/g, "").replace(/(00)+$/, "");
    const dir = mkdtempSync(path.join(tmpdir(), "p12cms-"));
    writeFileSync(path.join(dir, "sig.der"), Buffer.from(hexSig, "hex"));
    writeFileSync(path.join(dir, "content.bin"), Buffer.concat([Buffer.from(sealed.bytes.subarray(a, a + b)), Buffer.from(sealed.bytes.subarray(cc, cc + d))]));
    writeFileSync(path.join(dir, "root.pem"), pem(c.root.cert));
    // with only the root given as trusted, openssl must build leaf -> intermediate (from the signature) -> root
    const out = spawnSync("openssl", ["cms", "-verify", "-inform", "DER", "-in", path.join(dir, "sig.der"), "-content", path.join(dir, "content.bin"), "-binary", "-CAfile", path.join(dir, "root.pem"), "-purpose", "any", "-out", path.join(dir, "out.bin")], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(out.stderr).toContain("Verification successful");
    expect(out.status).toBe(0);
  });
});

