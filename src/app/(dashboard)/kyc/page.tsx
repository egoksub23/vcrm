import { KycScreen } from "@/components/kyc/kyc-screen";

// KYC review (migration 182): the staff screen over the ID verification back end. The dashboard shell's page guard needs menu.kyc (and the operator's
// `kyc` flag removes that capability), the screen asks again, and every /api/kyc route checks it on the server.
export default function KycPage() {
  return <KycScreen />;
}
