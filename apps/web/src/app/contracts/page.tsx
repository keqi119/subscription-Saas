"use client";

import { EyeOutlined } from "@ant-design/icons";
import { App, Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch, ApiError } from "../../lib/api";

interface ContractRow {
  archivedAt?: string | null;
  contractNo: string;
  createdAt: string;
  customer: { name: string };
  id: string;
  order: { orderNo: string; id: string };
  signedAt?: string | null;
  status: string;
  version?: { versionNo: string } | null;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ContractsPage() {
  const { message } = App.useApp();
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      setContracts(await apiFetch<ContractRow[]>("/contracts"));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  const columns: ColumnsType<ContractRow> = [
    {
      dataIndex: "contractNo",
      render: (value: string, record) => <Link href={`/contracts/${record.id}`}>{value}</Link>,
      title: "合同编号",
      width: 170
    },
    {
      dataIndex: "order",
      render: (value: ContractRow["order"]) => <Link href={`/orders/${value.id}`}>{value.orderNo}</Link>,
      title: "订单编号",
      width: 170
    },
    { dataIndex: "customer", render: (value: ContractRow["customer"]) => value.name, title: "客户姓名", width: 140 },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "合同状态", width: 120 },
    { dataIndex: "version", render: (value?: ContractRow["version"]) => value?.versionNo ?? "-", title: "合同版本", width: 120 },
    { dataIndex: "signedAt", render: formatTime, title: "签署时间", width: 150 },
    { dataIndex: "archivedAt", render: formatTime, title: "归档时间", width: 150 },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间", width: 150 },
    {
      render: (_, record) => (
        <Link href={`/contracts/${record.id}`}>
          <Button icon={<EyeOutlined />} size="small">
            查看详情
          </Button>
        </Link>
      ),
      title: "操作",
      width: 120
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          合同管理
        </Typography.Title>
        <Table columns={columns} dataSource={contracts} loading={loading} rowKey="id" scroll={{ x: 1300 }} />
      </Space>
    </ProtectedShell>
  );
}
