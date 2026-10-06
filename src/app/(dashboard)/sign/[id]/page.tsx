import { SignDocumentView } from "@/components/sign/send/document-view";

export default async function SignDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SignDocumentView documentId={id} />;
}
