// ============================================================
// /api/sign/addons
//
//   GET   (sign.settings)  the catalogue: each add-on with its version, whether the platform operator allows
//                          this workspace to install it, and whether it is installed (and which version)
//   POST  (sign.settings)  { key }  install it (safe to repeat). Answers 403 `addon_not_available` when the
//                          operator has not switched the add-on on for this workspace, 404 `addon_not_found`
//                          for an unknown key. Returns what was done.
//                          { key, action: "update" }  bring an installed add-on to its newest version (F-81): templates nobody
//                          edited get a new version, edited ones are left alone and a "(updated)" copy is made beside them.
//                          409 `addon_not_installed` when it was never installed. Returns what happened to each template.
// ============================================================
import { json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { installAddon, listAddonCards } from "@/lib/sign/addons/install";
import { updateAddon } from "@/lib/sign/addons/update";

export async function GET(request: Request) {
  return staff("sign.settings", request, async ({ ctx }) => json({ addons: await listAddonCards(ctx) }));
}

export async function POST(request: Request) {
  return staff(
    "sign.settings",
    request,
    async ({ ctx }) => {
      const body = await readJson<{ key?: unknown; action?: unknown }>(request, 10_000);
      if (typeof body.key !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(body.key)) throw new SignError("addon_not_found", "That add-on does not exist.", 404);
      if (body.action === "update") return json({ result: await updateAddon(ctx, body.key) });
      return json({ result: await installAddon(ctx, body.key) });
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
