// ============================================================
// /api/sign/registration/forms
//
//   GET   (menu.sign)       the workspace's registration forms, each with its address, its counts over the last 30
//                           days and why it cannot work yet (empty when it can)
//   POST  (sign.settings)   a new form (name, template, roles, tag, details asked, wording, daily cap). It is made
//                           switched off unless asked, and a form that cannot work is refused when switched on
//
// The reads and writes use the signed-in person's own client, so row level security checks sign.settings and the
// audit log records who made the form.
// ============================================================
import { json, readJson, staff } from "@/lib/sign/http";
import { createForm, listForms, publicUrl, withUserClient } from "@/lib/sign/service/registration-forms";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx, auth }) => json({ forms: await listForms(withUserClient(ctx, auth.supabase)) }));
}

export async function POST(request: Request) {
  return staff(
    "sign.settings",
    request,
    async ({ ctx, auth }) => {
      const form = await createForm(withUserClient(ctx, auth.supabase), await readJson(request, 60_000));
      return json({ form, url: publicUrl(ctx.origin, form.slug) }, 201);
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
