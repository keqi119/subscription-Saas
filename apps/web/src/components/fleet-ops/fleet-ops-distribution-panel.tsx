"use client";

import { Card, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";

import { formatFleetOpsAgingBucketLabel, formatFleetOpsConfidenceBandLabel } from "../../lib/fleet-ops-view-model";

interface DistributionRow {
  count: number;
  key: string;
  label: string;
}

export interface FleetOpsDistributionPanelProps {
  distributions?: Record<string, Record<string, number>>;
  risk?: Record<string, number | Record<string, number>>;
}

export function FleetOpsDistributionPanel({ distributions = {}, risk = {} }: Readonly<FleetOpsDistributionPanelProps>) {
  const panels = [
    { rows: distributionRows(distributions.vehicleStatus), title: "车辆状态分布" },
    { rows: distributionRows(asDistribution(risk.agingDistribution), formatFleetOpsAgingBucketLabel), title: "D1-D5 账龄分布" },
    { rows: distributionRows(asDistribution(risk.collectionDistribution), formatFleetOpsAgingBucketLabel), title: "催收优先级分布" },
    { rows: distributionRows(distributions.confidence ?? {}, formatFleetOpsConfidenceBandLabel), title: "置信度分布" }
  ];

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
      {panels.map((panel) => (
        <Card key={panel.title} title={panel.title}>
          <Table
            columns={columns}
            dataSource={panel.rows}
            locale={{ emptyText: "暂无分布数据" }}
            pagination={false}
            rowKey="key"
            size="small"
          />
        </Card>
      ))}
    </div>
  );
}

const columns: ColumnsType<DistributionRow> = [
  {
    dataIndex: "label",
    render: (value: string) => <Tag>{value}</Tag>,
    title: "分组"
  },
  {
    dataIndex: "count",
    title: "数量"
  }
];

function distributionRows(
  values: Record<string, number> = {},
  labeler: (value: string) => string = (value) => value
): DistributionRow[] {
  return Object.entries(values).map(([key, count]) => ({ count, key, label: labeler(key) }));
}

function asDistribution(value: unknown): Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, number> : {};
}
