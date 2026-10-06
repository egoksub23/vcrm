// ============================================================
// POST /api/sign/registration/forms/[id]/slug   (sign.settings)
//
// A new address for the form: the readable start stays, the random end changes, and the old address stops
// answering at once. For a link that was shared where it should not have been.
// ============================================================
import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { publicUrl, regenerateFormSlug, withUserClient } from "@/lib/sign/service/registration-forms";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return staff(
    "sign.settings",
    request,
    async ({ ctx, auth }) => {
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("form_not_found", "That registration form was not found.", 404);
      const form = await regenerateFormSlug(withUserClient(ctx, auth.supabase), id);
      return json({ form, url: publicUrl(ctx.origin, form.slug) });
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
