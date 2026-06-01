import { DashboardContent } from "../components/dashboard-content";
import { ProtectedShell } from "../components/protected-shell";

export default function HomePage() {
  return (
    <ProtectedShell>
      <DashboardContent />
    </ProtectedShell>
  );
}
