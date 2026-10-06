// ============================================================
// /api/sign/lists/[key]
//
//   GET    (menu.sign)       the list with all its items, and the templates whose current version uses it (read only)
//   PATCH  (sign.settings)   { name?, description?, archived?, items? }. `items` replaces the items: relabel, add, reorder, archive
//                            an item. A list that comes with Doc Sign never loses a value (409 `list_values_locked`).
//
// There is no DELETE: a list is archived, so a form that names it keeps working.
// ============================================================
import { json, readJson, staff } from "@/lib/sign/http";
import type { ListItem } from "@/lib/sign/lists/types";
import { getList, updateList, type ListPatch } from "@/lib/sign/service/lists";

type Params = { params: Promise<{ key: string }> };

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => json(await getList(ctx, (await params).key)));
}

export async function PATCH(request: Request, { params }: Params) {
  return staff("sign.settings", request, async ({ ctx }) => {
    const { key } = await params;
    const body = await readJson<{ name?: unknown; description?: unknown; archived?: unknown; items?: unknown }>(request, 2_500_000);
    const patch: ListPatch = {};
    if (body.name !== undefined) patch.name = typeof body.name === "string" ? body.name : "";
    if (body.description !== undefined) patch.description = typeof body.description === "string" ? body.description : null;
    if (body.archived !== undefined) patch.archived = body.archived as boolean;
    if (body.items !== undefined) patch.items = body.items as ListItem[];
    return json({ list: await updateList(ctx, key, patch) });
  });
}
