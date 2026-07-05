"use client";

import { useParams } from "next/navigation";

import { ProtectedShell } from "../../../../components/protected-shell";
import { FleetOpsPoolOverview } from "../../../../components/fleet-ops/fleet-ops-pool-overview";

export default function FleetOpsPoolDetailPage() {
  const params = useParams<{ poolId: string }>();

  return (
    <ProtectedShell>
      <FleetOpsPoolOverview fixedPoolId={params.poolId} />
    </ProtectedShell>
  );
}
