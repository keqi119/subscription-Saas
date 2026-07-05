"use client";

import { Button, Card, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";

import type { FleetOpsOverviewAnomalyItem } from "../../lib/fleet-ops-api";
import {
  formatFleetOpsAgingBucketLabel,
  formatFleetOpsMoney,
  formatFleetOpsRatio,
  formatFleetOpsScore,
  mapFleetOpsAnomalyRows,
  type FleetOpsAnomalyTableRow
} from "../../lib/fleet-ops-view-model";

export interface FleetOpsAnomalyTableProps {
  items?: FleetOpsOverviewAnomalyItem[];
  title: string;
}

export function FleetOpsAnomalyTable({ items = [], title }: Readonly<FleetOpsAnomalyTableProps>) {
  const rows = mapFleetOpsAnomalyRows(items);

  return (
    <Card title={title}>
      <Table
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: "暂无异常车辆" }}
        pagination={false}
        rowKey={(record) => `${title}-${record.vehicleId}`}
        scroll={{ x: 900 }}
        size="small"
      />
    </Card>
  );
}

const columns: ColumnsType<FleetOpsAnomalyTableRow> = [
  { dataIndex: "vehicleLabel", title: "车辆" },
  {
    dataIndex: "overdueRemainingAmount",
    render: formatFleetOpsMoney,
    title: "逾期金额"
  },
  {
    dataIndex: "riskScore",
    render: formatFleetOpsScore,
    title: "风险分"
  },
  {
    dataIndex: "roi",
    render: formatFleetOpsRatio,
    title: "ROI"
  },
  {
    dataIndex: "confidence",
    render: formatFleetOpsScore,
    title: "置信度"
  },
  {
    dataIndex: "collectionLevel",
    render: (value?: string) => value ? <Tag>{formatFleetOpsAgingBucketLabel(value)}</Tag> : "-",
    title: "催收层级"
  },
  {
    fixed: "right",
    render: (_, record) => (
      <Link href={record.drilldownHref}>
        <Button size="small">查看单车快照</Button>
      </Link>
    ),
    title: "钻取",
    width: 140
  }
];
