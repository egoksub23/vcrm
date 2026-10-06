// ============================================================
// /api/sign/settings/certificate   (sign.settings)
//
//   GET     the certificate the next document will be sealed with, described (subject, issuer, serial, the dates, the
//           SHA-256 fingerprint, whether it is self-signed, the chain, any warnings). Never the key or the file.
//           `certificate` is null until the first document is sealed (the first seal makes a self-signed one).
//   POST    install a certificate (multipart: `file` .p12 or .pfx, `passphrase`, optional `name`). The file is checked
//           (passphrase, key, size, dates, key usage, chain, a test seal) and refused with its own code if it is unfit.
//           The passphrase of the uploaded file is used once and not kept.
//   DELETE  ?id=<uuid>  remove an uploaded certificate and its key; documents already sealed are unchanged.
//
// The table also holds the encrypted key and passphrase: they never leave the server and are not read by GET.
// ============================================================
import { UUID_RE, json, readUpload, staff } from "@/lib/sign/http";
import { describeSealingCertificate, installCertificate, removeCertificate } from "@/lib/sign/service/certificates";
import { SignError } from "@/lib/sign/service/errors";

export async function GET(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => json({ certificate: await describeSealingCertificate(ctx) }));
}

export async function POST(request: Request) {
  return staff(
    "sign.settings",
    request,
    async ({ ctx }) => {
      let upload;
      try {
        upload = await readUpload(request, 600 * 1024);
      } catch (err) {
        if (err instanceof SignError && err.code === "upload_too_large") throw new SignError("certificate_file_too_large", "This file is too large to be a certificate file.", 413);
        throw err;
      }
      if (!upload.file) throw new SignError("no_file", "Choose a certificate file (.p12 or .pfx).", 400);
      const certificate = await installCertificate(ctx, { bytes: upload.file.bytes, passphrase: upload.fields.passphrase ?? "", name: upload.fields.name ?? null });
      return json({ certificate }, 201);
    },
    // each try is a guess at a passphrase: few of them
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}

export async function DELETE(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!UUID_RE.test(id)) throw new SignError("certificate_not_found", "That certificate was not found.", 404);
    await removeCertificate(ctx, id);
    return json({ removed: true });
  });
}
