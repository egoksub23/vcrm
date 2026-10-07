import { NewProcess } from "@/components/sign/process/new-process";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One query value, only if it is a single id (anything else is ignored rather than trusted). */
function idParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

export default async function NewSignDocumentPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const q = await searchParams;
  // `?kind=collection` is no longer a choice (the number of documents decides), so it is not read; `?contactId=`, `?ticketId=` and `?dealId=` still link the draft
  return <NewProcess contactId={idParam(q.contactId)} ticketId={idParam(q.ticketId)} dealId={idParam(q.dealId)} templateId={idParam(q.templateId)} categoryId={idParam(q.categoryId)} />;
}
