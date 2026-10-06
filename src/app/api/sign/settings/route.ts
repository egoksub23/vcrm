// ============================================================
// GET /api/sign/settings   (sign.settings)
//
// The workspace's Doc Sign settings row, and the consent wording in force for each language (the
// workspace's own text if it set one, else the product default, with the version that is recorded with a
// signer's agreement). The row (and the four starting categories) is created the first time anyone asks, by
// the database function sign_ensure_defaults, which only the server may call: that is why the Settings screen
// starts here. After this call the screen reads the categories, and writes the settings and the categories,
// itself with the browser client under row level security (sign.settings is checked there). Reading the
// consent here, not in the browser, keeps the hashing module off the client bundle.
// ============================================================
import { consentFor } from "@/lib/sign/consent";
import { json, staff } from "@/lib/sign/http";
import { loadSettings } from "@/lib/sign/service/context";
import { SIGN_LOCALES } from "@/lib/sign/types";

export async function GET(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => {
    const settings = await loadSettings(ctx);
    const consent = Object.fromEntries(SIGN_LOCALES.map((l) => [l, consentFor(settings.consent_texts, l)]));
    // the default wording of each language, shown beside a custom one
    const defaults = Object.fromEntries(SIGN_LOCALES.map((l) => [l, consentFor(null, l)]));
    return json({ settings, consent, consentDefaults: defaults });
  });
}
