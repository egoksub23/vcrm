import { NewDocument } from "@/components/sign/send/new-document";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One query value, only if it is a single id (anything else is ignored rather than trusted). */
function idParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

export default async function NewSignDocumentPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const q = await searchParams;
  return <NewDocument contactId={idParam(q.contactId)} ticketId={idParam(q.ticketId)} dealId={idParam(q.dealId)} templateId={idParam(q.templateId)} categoryId={idParam(q.categoryId)} kind={q.kind === "collection" ? "collection" : null} />;
}
