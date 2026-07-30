"use client";

import { EyeOutlined } from "@ant-design/icons";
import { Button, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch } from "../../lib/api";

interface QuoteRow {
  application: { applicationNo: string; id: string };
  customer: { grade?: string | null; mobile: string; name: string };
  createdAt: string;
  depositAmount: number;
  id: string;
  modelDisplayName?: string | null;
  modelDisplaySource?: string | null;
  monthlyFeeAmount: number;
  periodMonths: number;
  productVersion: { product: { name: string }; versionNo: string };
  quoteNo: string;
  status: string;
  modelCodeSnapshot?: string | null;
  vehiclePurchasePriceAmount: number;
}

const statusColors: Record<string, string> = {
  CANCELLED: "red",
  CONFIRMED: "green",
  DRAFT: "blue",
  EXPIRED: "default"
};

function formatYuan(value: number) {
  return `￥${(value / 100).toFixed(2)}`;
}

export default function QuotesPage() {
  const [loading, setLoading] = useState(false);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);

  const loadQuotes = useCallback(async () => {
    setLoading(true);
    try {
      const nextQuotes = await apiFetch<QuoteRow[]>("/quotes");
      setQuotes(nextQuotes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQuotes();
  }, [loadQuotes]);

  const columns: ColumnsType<QuoteRow> = [
    {
      dataIndex: "quoteNo",
      render: (value: string, record) => <Link href={`/quotes/${record.id}`}>{value}</Link>,
      title: "报价编号",
      width: 170
    },
    {
      dataIndex: "application",
      render: (value: QuoteRow["application"]) => (
        <Link href={`/applications/${value.id}`}>{value.applicationNo}</Link>
      ),
      title: "关联进件",
      width: 170
    },
    {
      dataIndex: "customer",
      render: (value: QuoteRow["customer"]) => `${value.name} / ${value.grade ?? "-"}`,
      title: "客户信息",
      width: 160
    },
    { dataIndex: "modelDisplayName", title: "车型", width: 140 },
    { dataIndex: "vehiclePurchasePriceAmount", render: formatYuan, title: "车辆采购价", width: 130 },
    { dataIndex: "monthlyFeeAmount", render: formatYuan, title: "月费金额", width: 120 },
    { dataIndex: "depositAmount", render: formatYuan, title: "押金", width: 120 },
    { dataIndex: "periodMonths", render: (value: number) => `${value} 个月`, title: "订阅周期", width: 100 },
    {
      dataIndex: "status",
      render: (value: string) => (
        <Tag color={statusColors[value]}>{labelOf(STATUS_LABELS, value)}</Tag>
      ),
      title: "状态",
      width: 110
    },
    {
      dataIndex: "createdAt",
      render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
      title: "创建时间",
      width: 150
    },
    {
      render: (_, record) => (
        <Link href={`/quotes/${record.id}`}>
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
          订阅报价
        </Typography.Title>
        <Table columns={columns} dataSource={quotes} loading={loading} rowKey="id" scroll={{ x: 1400 }} />
      </Space>
    </ProtectedShell>
  );
}
