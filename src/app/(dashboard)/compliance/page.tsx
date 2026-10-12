import { ComplianceScreen } from "@/components/compliance/compliance-screen";

// Compliance requests (migration 183): account closures, withdrawals and phone changes with a regulatory clock, an identity check and a Head of
// Compliance sign-off. The dashboard shell's page guard needs menu.compliance (and the operator's `compliance` flag removes that capability), the
// screen asks again, and every /api/compliance route checks it on the server.
export default function CompliancePage() {
  return <ComplianceScreen />;
}
