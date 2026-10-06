import { BulkJobScreen } from "@/components/sign/bulk/bulk-job";

export default async function BulkJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BulkJobScreen id={id} />;
}
