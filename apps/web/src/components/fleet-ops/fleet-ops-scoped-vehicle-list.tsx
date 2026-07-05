"use client";

import { Button, Card, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";

import type { FleetOpsPagination, FleetOpsVehicleScopeItem } from "../../lib/fleet-ops-api";
import { mapFleetOpsScopedVehicleRows, type FleetOpsScopedVehicleTableRow } from "../../lib/fleet-ops-view-model";

export interface FleetOpsScopedVehicleListProps {
  items?: FleetOpsVehicleScopeItem[];
  loading?: boolean;
  onPageChange?: (page: number, pageSize: number) => void;
  pagination?: FleetOpsPagination;
}

export function FleetOpsScopedVehicleList({
  items = [],
  loading = false,
  onPageChange,
  pagination
}: Readonly<FleetOpsScopedVehicleListProps>) {
  const rows = mapFleetOpsScopedVehicleRows(items);

  return (
    <Card title="车辆列表">
      <Table
        columns={columns}
        dataSource={rows}
        loading={loading}
        locale={{ emptyText: "暂无车辆" }}
        onChange={(nextPagination) => {
          onPageChange?.(nextPagination.current ?? 1, nextPagination.pageSize ?? 20);
        }}
        pagination={
          pagination
            ? {
                current: pagination.page,
                pageSize: pagination.pageSize,
                showSizeChanger: true,
                total: pagination.total
              }
            : false
        }
        rowKey="vehicleId"
        scroll={{ x: 920 }}
        size="small"
      />
    </Card>
  );
}

const columns: ColumnsType<FleetOpsScopedVehicleTableRow> = [
  { dataIndex: "vehicleLabel", title: "车辆" },
  { dataIndex: "status", render: (value?: string) => value ? <Tag>{value}</Tag> : "-", title: "状态" },
  { dataIndex: "modelLabel", title: "车型" },
  { dataIndex: "assetLocation", title: "资产地点" },
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
