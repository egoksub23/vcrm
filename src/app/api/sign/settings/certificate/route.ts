// ============================================================
// GET /api/sign/settings/certificate   (sign.settings)
//
// The facts about the certificate the workspace's documents are sealed with: its name, subject and the date
// it is valid until, and whether Halo made it itself (self-signed). It names the columns it reads: the table
// also holds the encrypted key and passphrase, which never leave the server. `certificate` is null until the
// first document is sealed (the first seal makes a self-signed one).
// ============================================================
import { json, staff } from "@/lib/sign/http";
import { raiseDatabaseError } from "@/lib/sign/service/errors";
import { loadSettings } from "@/lib/sign/service/context";
import { SELF_SIGNED_NAME_PREFIX } from "@/lib/sign/client/admin-settings";

interface CertFacts {
  id: string;
  name: string;
  subject: string | null;
  valid_until: string | null;
  is_default: boolean;
}

export async function GET(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => {
    const settings = await loadSettings(ctx);
    const { data, error } = await ctx.admin.from("sign_certificates").select("id, name, subject, valid_until, is_default").eq("account_id", ctx.accountId);
    if (error) raiseDatabaseError(error, "load certificate facts");
    const all = (data ?? []) as CertFacts[];
    // the one sealing uses: the chosen one, else the default, else any
    const chosen = all.find((c) => c.id === settings.certificate_id) ?? all.find((c) => c.is_default) ?? all[0] ?? null;
    return json({
      certificate: chosen
        ? { name: chosen.name, subject: chosen.subject, validUntil: chosen.valid_until, selfSigned: chosen.name.startsWith(SELF_SIGNED_NAME_PREFIX) }
        : null,
    });
  });
}
