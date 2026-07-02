"use client";

import { Card, Descriptions, Tag } from "antd";

import type { FleetOpsStateSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsStateCard({ state }: Readonly<{ state: FleetOpsStateSummary }>) {
  return (
    <Card title="运营状态">
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="计算状态">
          {state.computedState ? <Tag color="blue">{state.computedState}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="置信度">{formatPercent(state.confidenceScore)}</Descriptions.Item>
        <Descriptions.Item label="证据">{state.evidenceCount}</Descriptions.Item>
        <Descriptions.Item label="冲突">
          <Tag color={state.conflictCount ? "orange" : "green"}>{state.conflictCount}</Tag>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function formatPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "-";
}
