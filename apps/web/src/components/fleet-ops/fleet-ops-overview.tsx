"use client";

import { Alert, Card, Descriptions, Space, Tag, Typography } from "antd";

import type { FleetOpsSnapshotSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsOverview({ summary }: Readonly<{ summary: FleetOpsSnapshotSummary }>) {
  return (
    <Card title="Fleet Ops overview">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Alert
          message="Read-only admin view"
          showIcon
          type="info"
        />
        <Descriptions bordered column={3} size="small">
          <Descriptions.Item label="Vehicle">{summary.vehicleId ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="Generated at">{summary.generatedAt ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="Confidence">
            {formatPercent(summary.system.overallConfidenceScore)} {summary.system.confidenceBand ? <Tag>{summary.system.confidenceBand}</Tag> : null}
          </Descriptions.Item>
          <Descriptions.Item label="Consistency">{formatPercent(summary.system.consistencyScore)}</Descriptions.Item>
          <Descriptions.Item label="Warnings">{summary.warningCount}</Descriptions.Item>
          <Descriptions.Item label="Evidence">{summary.evidenceCount}</Descriptions.Item>
        </Descriptions>
        {summary.warningCodes.length ? (
          <Space wrap>
            <Typography.Text type="secondary">Warnings</Typography.Text>
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
