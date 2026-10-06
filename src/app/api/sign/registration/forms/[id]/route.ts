// ============================================================
// /api/sign/registration/forms/[id]
//
//   GET    (menu.sign)       the form, its address, its counts, why it cannot work yet, and its newest submissions
//                            (what happened and when: never an address or an email)
//   PATCH  (sign.settings)   change what is sent (a change sends only what changed); switch it on or off
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { formView, publicUrl, updateForm, withUserClient } from "@/lib/sign/service/registration-forms";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("form_not_found", "That registration form was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx, auth }) => json(await formView(withUserClient(ctx, auth.supabase), await idOf(params))));
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.settings", request, async ({ ctx, auth }) => {
    const id = await idOf(params);
    const form = await updateForm(withUserClient(ctx, auth.supabase), id, await readJson(request, 60_000));
    return json({ form, url: publicUrl(ctx.origin, form.slug) });
  });
}
