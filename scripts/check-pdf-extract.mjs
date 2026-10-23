// Self-test for the PDF text extraction the knowledge-base import uses (src/lib/knowledge/import-file.ts, through `unpdf`).
//
// `npm ci` warns that unpdf and pdfjs-dist ask for Node 22+ (the Docker image used to run Node 20; it now runs Node 24). This reads a tiny PDF made in memory and prints
// what came out, so you can see on the Node you actually run whether the feature works, instead of reading a warning.
//
//   locally:       node scripts/check-pdf-extract.mjs
//   in the image:  docker exec -w /app <container> node scripts/check-pdf-extract.mjs
//                  (or paste the file's body into `node --input-type=module -e '...'` if scripts/ is not in the image)
//
// Prints "PDF-EXTRACT-OK" and exits 0 when the text comes back, otherwise prints the error and exits 1.

const pdf = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 220 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
  "4 0 obj<</Length 42>>stream",
  "BT /F1 18 Tf 20 50 Td (Hello Halo PDF) Tj ET",
  "endstream endobj",
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

console.log(`node ${process.version}`);
try {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new TextEncoder().encode(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  console.log(`pages: ${doc.numPages}, text: ${JSON.stringify(text.trim())}`);
  if (!/Hello Halo PDF/.test(text)) throw new Error("the text did not come back");
  console.log("PDF-EXTRACT-OK");
} catch (err) {
  console.log("PDF-EXTRACT-FAILED:", err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n") : err);
  process.exit(1);
}
