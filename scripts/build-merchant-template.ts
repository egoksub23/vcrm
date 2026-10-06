// Builds the Merchant Application template file of the Merchant Registration add-on.
//
//   npx esbuild scripts/build-merchant-template.ts --bundle --platform=node --format=cjs --packages=external --outfile=build/merchant-template.cjs
//   node build/merchant-template.cjs            (run from the repository root; the fonts are read from there)
//
// (The repository has no TypeScript runner for scripts, so the script is bundled first with the esbuild that
// ships with the tooling. `UPDATE_MERCHANT_TEMPLATE=1 npx vitest run src/lib/sign/addons/merchant` does the same
// through the test runner. `build/` is ignored by git.)
//
// It draws the template from the layout description (src/lib/sign/addons/merchant/layout.ts), the same
// description the add-on's placed fields come from, and writes two files next to each other:
//   assets/merchant-application.pdf          the template (4 pages, A4, bundled fonts, no images)
//   assets/merchant-application.layout.json  the summary the drift test compares against
// Commit both. The test fails if the layout changes and these files were not rebuilt.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildMerchantAssets } from "../src/lib/sign/addons/merchant/render";

const OUT = path.resolve(process.cwd(), "src", "lib", "sign", "addons", "merchant", "assets");

async function main() {
  const { pdf, summary, summaryJson } = await buildMerchantAssets();
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "merchant-application.pdf"), pdf);
  await writeFile(path.join(OUT, "merchant-application.layout.json"), summaryJson);
  console.log(`merchant-application.pdf: ${pdf.length} bytes, ${summary.pageCount} pages, ${summary.placements.length} placements`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
