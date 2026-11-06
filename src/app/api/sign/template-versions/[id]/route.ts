import { UUID_RE, json, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff("sign.send", request, async ({ ctx }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) throw new SignError("version_not_found", "That version was not found.", 404);
    const { data, error } = await ctx.admin
      .from("sign_template_versions")
      .select("roles, fields, form")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return json({ version: data ?? null });
  });
}
