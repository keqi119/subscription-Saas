import { DashboardContent } from "./dashboard-content";
import { ProtectedShell } from "./protected-shell";

export function AdminShell() {
  return (
    <ProtectedShell>
      <DashboardContent />
    </ProtectedShell>
  );
}
