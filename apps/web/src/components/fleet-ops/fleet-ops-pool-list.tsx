"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "../../lib/api";
import {
  getFleetOpsPools,
  isFleetOpsApiDisabled,
  isFleetOpsPermissionDenied,
  type FleetOpsPagination,
  type FleetOpsPoolIdentity
} from "../../lib/fleet-ops-api";
import { mapFleetOpsPoolRows, type FleetOpsPoolTableRow } from "../../lib/fleet-ops-view-model";

export function FleetOpsPoolList() {
  const [items, setItems] = useState<FleetOpsPoolIdentity[]>([]);
  const [pagination, setPagination] = useState<FleetOpsPagination>({ page: 1, pageSize: 20, total: 0 });
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiDisabled, setApiDisabled] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const rows = useMemo(() => mapFleetOpsPoolRows(items), [items]);

  const loadData = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true);
    setErrorMessage(null);
    setApiDisabled(false);
    setPermissionDenied(false);

    try {
      const result = await getFleetOpsPools({ page, pageSize });
      setItems(result.data.items);
      setPagination(result.data.pagination);
      setGeneratedAt(result.data.generatedAt ?? result.generatedAt ?? null);
    } catch (error) {
      if (isFleetOpsApiDisabled(error)) {
        setApiDisabled(true);
      } else if (isFleetOpsPermissionDenied(error)) {
        setPermissionDenied(true);
      } else {
        setErrorMessage(getErrorMessage(error));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData(1, 20);
  }, [loadData]);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <span>{generatedAt ? `生成时间 ${generatedAt}` : "系统正式资产/管理口径的车辆池。"}</span>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData(pagination.page, pagination.pageSize)}>
          刷新
        </Button>
      </Space>

      {apiDisabled ? <Alert message="车队运营 API 未启用" showIcon type="warning" /> : null}
      {permissionDenied ? <Alert message="当前账号需要 fleet_ops:read 才能访问车辆池视图。" showIcon type="error" /> : null}
      {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}

      <Card title="车辆池">
        <Table
          columns={columns}
          dataSource={rows}
          loading={loading}
          locale={{ emptyText: "暂无车辆池" }}
          onChange={(nextPagination) => {
            void loadData(nextPagination.current ?? 1, nextPagination.pageSize ?? 20);
          }}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            showSizeChanger: true,
            total: pagination.total
          }}
          rowKey="poolId"
          scroll={{ x: 920 }}
          size="small"
        />
      </Card>
    </Space>
  );
}

const columns: ColumnsType<FleetOpsPoolTableRow> = [
  { dataIndex: "poolNo", title: "车辆池编号" },
  { dataIndex: "poolName", title: "车辆池名称" },
  { dataIndex: "poolType", render: (value: string) => <Tag>{value}</Tag>, title: "类型" },
  { dataIndex: "poolStatus", render: (value: string) => <Tag color={value === "ACTIVE" ? "green" : "default"}>{value}</Tag>, title: "状态" },
  { dataIndex: "activeVehicleCount", title: "生效车辆数" },
  {
    fixed: "right",
    render: (_, record) => (
      <Link href={record.detailHref}>
        <Button size="small">查看详情</Button>
      </Link>
    ),
    title: "详情",
    width: 120
  }
];

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "车辆池加载失败。";
}
