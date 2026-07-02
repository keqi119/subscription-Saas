"use client";

import { Card, Descriptions, Space, Tag } from "antd";

import type { FleetOpsTimelineSummary } from "../../lib/fleet-ops-view-model";

export function FleetOpsTimelineCard({ timeline }: Readonly<{ timeline: FleetOpsTimelineSummary }>) {
  return (
    <Card title="Timeline">
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Descriptions bordered column={3} size="small">
          <Descriptions.Item label="Range days">{timeline.rangeDays ?? "-"}</Descriptions.Item>
          <Descriptions.Item label="Events">{timeline.eventCount}</Descriptions.Item>
          <Descriptions.Item label="Fallback days">{timeline.fallbackWarningDays}</Descriptions.Item>
        </Descriptions>
        {timeline.warnings.length ? (
          <Space wrap>
            {timeline.warnings.map((warning) => (
              <Tag color={warning === "CURRENT_STATUS_PROJECTED_ACROSS_RANGE" ? "orange" : "gold"} key={warning}>
                {warning}
              </Tag>
            ))}
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}
