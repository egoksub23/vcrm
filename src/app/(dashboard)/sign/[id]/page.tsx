import { SignDocumentView } from "@/components/sign/send/document-view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One query value, only if it is a single value (anything else is ignored rather than trusted). */
const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : null);

export default async function SignDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { id } = await params;
  const q = await searchParams;
  const doc = one(q.doc);
  return <SignDocumentView documentId={id} asked={{ step: one(q.step), doc: doc && UUID_RE.test(doc) ? doc : null }} />;
}
