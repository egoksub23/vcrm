// ============================================================
// POST /api/sign/lists/[key]/import   (sign.settings)
//
// Load a CSV into a list. Body { csv, mode: "merge" | "replace", dryRun? }: `csv` is the text of the file.
// merge adds what is new and updates what is there; replace makes the list exactly the file (a list that comes with Doc
// Sign can only be merged). A row with a problem is left out and reported, never half applied. `dryRun` only says what
// would change. Answer: { dryRun, added, updated, unchanged, removed, problems, list? }.
// ============================================================
import { json, readJson, staff } from "@/lib/sign/http";
import { importIntoList, MAX_IMPORT_CHARS } from "@/lib/sign/service/lists";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return staff(
    "sign.settings",
    request,
    async ({ ctx }) => {
      const { key } = await params;
      const body = await readJson<{ csv?: unknown; mode?: unknown; dryRun?: unknown }>(request, MAX_IMPORT_CHARS + 100_000);
      return json(await importIntoList(ctx, key, { csv: body.csv as string, mode: body.mode as "merge" | "replace", dryRun: body.dryRun === true }));
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}
