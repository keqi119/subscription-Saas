"use client";

import { Card, Descriptions, Tag } from "antd";

import type { FleetOpsStateSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsStateCard({ state }: Readonly<{ state: FleetOpsStateSummary }>) {
  return (
    <Card title="Operational state">
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="Computed state">
          {state.computedState ? <Tag color="blue">{state.computedState}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Confidence">{formatPercent(state.confidenceScore)}</Descriptions.Item>
        <Descriptions.Item label="Evidence">{state.evidenceCount}</Descriptions.Item>
        <Descriptions.Item label="Conflicts">
          <Tag color={state.conflictCount ? "orange" : "green"}>{state.conflictCount}</Tag>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function formatPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "-";
}
