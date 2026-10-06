// ============================================================
// POST /api/sign/templates/[id]/test   (sign.send)
//
// Template test mode (F-10): make a document from the template, mark it TEST, and send it to the signed-in person. Body (all
// optional): { email?: string, emails?: { [roleKey]: string } }. Each address must be one of the person's own (their sign-in or
// profile address, or that address with a +tag): a test can never be sent to anyone else. A template that is still a draft can be
// tried. The document is created and sent through the ordinary services, so it uses the template's current version and form; it is
// not counted against the monthly limit and is never announced to webhooks or automations. Answers 201 with where it went.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { assertSignOn } from "@/lib/sign/service/gate";
import { sendTestDocument } from "@/lib/sign/service/test-mode";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      await assertSignOn(ctx);
      const { id } = await params;
      if (!UUID_RE.test(id)) throw new SignError("template_not_found", "That template was not found.", 404);
      const body = await readJson<{ email?: unknown; emails?: unknown }>(request, 10_000);
      const emails: Record<string, string> = {};
      if (body.emails !== undefined) {
        if (typeof body.emails !== "object" || body.emails === null || Array.isArray(body.emails)) throw new SignError("bad_request", "The addresses are not valid.", 400);
        for (const [role, value] of Object.entries(body.emails as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim() && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(role)) emails[role] = value;
        }
      }
      const result = await sendTestDocument(ctx, id, { email: typeof body.email === "string" ? body.email : null, emails });
      return json({ result }, 201);
    },
    { rate: { limit: 10, windowMs: 60_000 } },
  );
}
