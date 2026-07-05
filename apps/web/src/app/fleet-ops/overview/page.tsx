"use client";

import { ProtectedShell } from "../../../components/protected-shell";
import { FleetOpsPoolOverview } from "../../../components/fleet-ops/fleet-ops-pool-overview";

export default function FleetOpsOverviewPage() {
  return (
    <ProtectedShell>
      <FleetOpsPoolOverview />
    </ProtectedShell>
  );
}
