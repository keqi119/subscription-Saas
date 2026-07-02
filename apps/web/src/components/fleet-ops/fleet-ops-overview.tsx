"use client";

import { Alert, Card, Descriptions, Space, Tag, Typography } from "antd";

import type { FleetOpsSnapshotSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsOverview({ summary }: Readonly<{ summary: FleetOpsSnapshotSummary }>) {
  return (
    <Card title="车队运营总览">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          message="内部只读管理视图"
          showIcon
          type="info"
        />
        <Descriptions bordered column={3} size="small">
          <Descriptions.Item label="车辆">{summary.vehicleId ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="生成时间">{summary.generatedAt ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="置信度">
            {formatPercent(summary.system.overallConfidenceScore)} {summary.system.confidenceBand ? <Tag>{summary.system.confidenceBand}</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label="一致性">{formatPercent(summary.system.consistencyScore)}</Descriptions.Item>
          <Descriptions.Item label="预警">{summary.warningCount}</Descriptions.Item>
          <Descriptions.Item label="证据">{summary.evidenceCount}</Descriptions.Item>
        </Descriptions>
        {summary.warningCodes.length ? (
          <Space wrap>
            <Typography.Text type="secondary">预警</Typography.Text>
            {summary.warningCodes.map((code) => (
              <Tag color="orange" key={code}>
                {code}
              </Tag>
            ))}
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}

function formatPercent(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? `${value}%` : "-";
}
