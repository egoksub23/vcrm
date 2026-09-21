import { getSearchDocs } from "@/lib/help/content";

// The documents behind the guide's search box: one entry per page with its
// title, section, description, headings and plain body text. The browser builds
// the actual index from this on first use (see src/lib/help/search.ts).
// Requests under /help are behind the same sign-in redirect as the pages.
export function GET() {
  return Response.json(getSearchDocs());
}
