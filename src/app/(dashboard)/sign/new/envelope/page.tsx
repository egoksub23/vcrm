import { NewEnvelope } from "@/components/sign/envelope/new-envelope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One query value, only if it is a single id (anything else is ignored rather than trusted). */
function idParam(v: string | string[] | undefined): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v : null;
}

/** "Send as envelope": several documents signed in one sitting. A contact, ticket or deal can be named in the address (opened from its own page). */
export default async function NewSignEnvelopePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const q = await searchParams;
  return <NewEnvelope contactId={idParam(q.contactId)} ticketId={idParam(q.ticketId)} dealId={idParam(q.dealId)} />;
}
