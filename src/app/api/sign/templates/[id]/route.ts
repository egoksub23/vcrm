// ============================================================
// /api/sign/templates/[id]
//
//   GET     (menu.sign)       the template, its current version (fields, roles, defaults) and the list of versions
//   PATCH   (sign.templates)  name, description, category, tags, status (making a template active checks it is ready)
//   DELETE  (sign.templates)  delete the template and its files; documents sent from it keep their own copy
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { loadTemplateView, updateTemplate, deleteTemplate, type TemplatePatch } from "@/lib/sign/service/templates";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => json(await loadTemplateView(ctx, await idOf(params))));
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.templates", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<TemplatePatch>(request);
    return json({ template: await updateTemplate(ctx, id, body) });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return staff("sign.templates", request, async ({ ctx }) => {
    await deleteTemplate(ctx, await idOf(params));
    return json({ deleted: true });
  });
}
