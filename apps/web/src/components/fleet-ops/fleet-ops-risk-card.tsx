"use client";

import { Card, Descriptions, Tag } from "antd";

import type { FleetOpsRiskSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsRiskCard({ risk }: Readonly<{ risk: FleetOpsRiskSummary }>) {
  return (
    <Card title="风险与逾期">
      <Descriptions bordered column={3} size="small">
        <Descriptions.Item label="评分">{risk.score ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="风险等级">{risk.level ? <Tag color="orange">{risk.level}</Tag> : "-"}</Descriptions.Item>
        <Descriptions.Item label="催收等级">
          {risk.collectionLevel ? <Tag color="blue">{risk.collectionLevel}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="账龄分层">
          {risk.agingBucket ? <Tag color="purple">{risk.agingBucket}</Tag> : "-"}
        </Descriptions.Item>
        <Descriptions.Item label="逾期金额">{formatMoney(risk.overdueRemainingAmount)}</Descriptions.Item>
        <Descriptions.Item label="逾期账单">{risk.overdueBillCount}</Descriptions.Item>
        <Descriptions.Item label="最大逾期天数">{risk.maxOverdueDays ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="欠款阶段">{risk.arrearsStage ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="预警">{risk.warningCount}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function formatMoney(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")}` : "-";
}
