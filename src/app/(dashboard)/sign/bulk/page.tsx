import { BulkWizard } from "@/components/sign/bulk/bulk-wizard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BulkSendPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const q = await searchParams;
  // a template can be chosen from the address (one id only; anything else is ignored rather than trusted)
  return <BulkWizard templateId={typeof q.templateId === "string" && UUID_RE.test(q.templateId) ? q.templateId : null} />;
}
