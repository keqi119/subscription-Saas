"use client";

import { Card, Descriptions, Tag } from "antd";

import type { FleetOpsRiskSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsRiskCard({ risk }: Readonly<{ risk: FleetOpsRiskSummary }>) {
  return (
    <Card title="Risk and collection">
      <Descriptions bordered column={3} size="small">
        <Descriptions.Item label="Score">{risk.score ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Level">{risk.level ? <Tag color="orange">{risk.level}</Tag> : "-"}</Descriptions.Item>
        <Descriptions.Item label="Collection level">
          {risk.collectionLevel ? <Tag color="blue">{risk.collectionLevel}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Aging bucket">
          {risk.agingBucket ? <Tag color="purple">{risk.agingBucket}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="Overdue amount">{formatMoney(risk.overdueRemainingAmount)}</Descriptions.Item>
        <Descriptions.Item label="Overdue bills">{risk.overdueBillCount}</Descriptions.Item>
        <Descriptions.Item label="Max overdue days">{risk.maxOverdueDays ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Arrears stage">{risk.arrearsStage ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Warnings">{risk.warningCount}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")}` : "-";
}
