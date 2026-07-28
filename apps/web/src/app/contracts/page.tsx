"use client";

import { ClearOutlined, EyeOutlined, SearchOutlined } from "@ant-design/icons";
import { App, Button, Input, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch, ApiError } from "../../lib/api";
import { buildAdminContractsListPath } from "../../lib/admin-contracts";

interface ContractRow {
  archivedAt?: string | null;
  contractNo: string;
  contractTitle?: string | null;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [contractNo, setContractNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [orderNo, setOrderNo] = useState("");
  const activeContractNo = searchParams.get("contractNo") ?? "";
  const activeOrderNo = searchParams.get("orderNo") ?? "";

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      setContracts(
        await apiFetch<ContractRow[]>(
          buildAdminContractsListPath({ contractNo: activeContractNo, orderNo: activeOrderNo })
        )
      );
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [activeContractNo, activeOrderNo, message]);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  useEffect(() => {
    setContractNo(activeContractNo);
    setOrderNo(activeOrderNo);
  }, [activeContractNo, activeOrderNo]);

  const search = () => {
    router.push(buildAdminContractsListPath({ contractNo, orderNo }));
  };

  const clearSearch = () => {
    setContractNo("");
    setOrderNo("");
    router.push(buildAdminContractsListPath({}));
  };

  const columns: ColumnsType<ContractRow> = [
    {
      dataIndex: "contractNo",
      render: (value: string, record) => <Link href={`/contracts/${record.id}`}>{value}</Link>,
      title: "合同编号",
      width: 170
    },
    { dataIndex: "contractTitle", render: (value?: string | null) => value ?? "-", title: "合同标题", width: 180 },
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
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          合同管理
        </Typography.Title>
        <Space align="end" size={12} wrap>
          <Space direction="vertical" size={4}>
            <Typography.Text>合同编号</Typography.Text>
            <Input
              aria-label="合同编号"
              maxLength={128}
              onChange={(event) => setContractNo(event.target.value)}
              onPressEnter={search}
              placeholder="合同编号"
              size="small"
              value={contractNo}
            />
          </Space>
          <Space direction="vertical" size={4}>
            <Typography.Text>订单编号</Typography.Text>
            <Input
              aria-label="订单编号"
              maxLength={128}
              onChange={(event) => setOrderNo(event.target.value)}
              onPressEnter={search}
              placeholder="订单编号"
              size="small"
              value={orderNo}
            />
          </Space>
          <Tooltip title="搜索">
            <Button aria-label="搜索" icon={<SearchOutlined />} onClick={search} type="primary" />
          </Tooltip>
          <Tooltip title="清空筛选">
            <Button aria-label="清空筛选" icon={<ClearOutlined />} onClick={clearSearch} />
          </Tooltip>
        </Space>
        <Table columns={columns} dataSource={contracts} loading={loading} rowKey="id" scroll={{ x: 1480 }} />
      </Space>
    </ProtectedShell>
  );
}
