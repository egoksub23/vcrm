// ============================================================
// /api/sign/lists
//
//   GET   (menu.sign)       the workspace's option lists, each without its items: key, name, kind, whether it comes with
//                           Doc Sign, how many items, its version. The shipped lists are copied in first if they are missing.
//   POST  (sign.settings)   a new list of the workspace's own. Body { name, description?, items? }. The key is made from the
//                           name and never changes. Answer { list } (201).
//
// A list is archived, never deleted (PATCH /api/sign/lists/[key]). See docs/doc-sign-setup.md.
// ============================================================
import { json, readJson, staff } from "@/lib/sign/http";
import type { ListItem } from "@/lib/sign/lists/types";
import { createList, listAll } from "@/lib/sign/service/lists";

export async function GET(request: Request) {
  return staff("menu.sign", request, async ({ ctx }) => json({ lists: await listAll(ctx) }));
}

export async function POST(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => {
    const body = await readJson<{ name?: unknown; description?: unknown; items?: unknown }>(request);
    const list = await createList(ctx, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : null,
      items: Array.isArray(body.items) ? (body.items as ListItem[]) : undefined,
    });
    return json({ list }, 201);
  });
}
