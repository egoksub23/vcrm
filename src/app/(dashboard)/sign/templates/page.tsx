import { TemplateLibrary } from "@/components/sign/templates/template-library";

// Sign > Templates. The title, the tabs and the "New document" button come from the Sign layout; the library
// itself (list, filters, upload) is a client component that reads through row level security.
export default function SignTemplatesPage() {
  return <TemplateLibrary />;
}
