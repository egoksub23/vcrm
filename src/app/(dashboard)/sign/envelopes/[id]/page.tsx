import { EnvelopeView } from "@/components/sign/envelope/envelope-view";

export default async function SignEnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EnvelopeView envelopeId={id} />;
}
