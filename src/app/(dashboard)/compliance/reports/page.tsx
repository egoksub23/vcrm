import { ReportsScreen } from "@/components/compliance/reports-screen";

// The Compliance reports (migration 184): counts, the clock against the practice target and the stop, days to decision and completion, sign-offs by person,
// rejections by category, ageing, and the CSV for audit. The dashboard shell's page guard needs menu.compliance; the screen and every route behind it need
// compliance.review or compliance.approve as well.
export default function ComplianceReportsPage() {
  return <ReportsScreen />;
}
