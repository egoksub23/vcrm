// ============================================================
// GET /api/sign/registration/options   (menu.sign)
//
// What the registration form editor offers: the active templates with the roles each has (who fills what), the
// workspace's contact tags, the product's default agreement wording per language, the address pages are built on,
// and whether Turnstile is on (so the screen can say so; the keys themselves never leave the server).
// ============================================================
import { DEFAULT_REGISTRATION_CONSENT } from "@/lib/sign/registration/consent";
import { turnstileEnabled } from "@/lib/sign/registration/turnstile";
import { json, staff } from "@/lib/sign/http";
import { formOptions, withUserClient } from "@/lib/sign/service/registration-forms";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx, auth }) => json({ ...(await formOptions(withUserClient(ctx, auth.supabase))), consentDefaults: DEFAULT_REGISTRATION_CONSENT, turnstile: turnstileEnabled(), origin: ctx.origin }));
}
