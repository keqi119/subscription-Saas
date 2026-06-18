"use client";

import { ArrowLeftOutlined, GiftOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  ENTITLEMENT_GRANT_SOURCE_LABELS,
  ENTITLEMENT_GRANT_STATUS_LABELS,
  ENTITLEMENT_TYPE_LABELS,
  ENTITLEMENT_UNIT_LABELS,
  ENTITLEMENT_USAGE_SOURCE_LABELS,
  ENTITLEMENT_USAGE_STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  PortalEntitlementGrant,
  PortalEntitlementUsage,
  PortalPagedResponse
} from "../../../lib/portal-types";

export default function PortalEntitlementsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [grants, setGrants] = useState<PortalEntitlementGrant[]>([]);
  const [usages, setUsages] = useState<PortalEntitlementUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const orderId = searchParams.get("orderId");
  const grantPath = useMemo(
    () => `/portal/entitlements${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );
  const usagePath = useMemo(
    () => `/portal/entitlements/usages${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ""}`,
    [orderId]
  );

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalPagedResponse<PortalEntitlementGrant>>(grantPath),
      portalApiFetch<PortalPagedResponse<PortalEntitlementUsage>>(usagePath)
    ])
      .then(([grantResult, usageResult]) => {
        setGrants(grantResult.items);
        setUsages(usageResult.items);
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/entitlements")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载权益信息");
      })
      .finally(() => setLoading(false));
  }, [grantPath, message, router, usagePath]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 960 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的权益
            </Typography.Title>
            <Typography.Text type="secondary">查看权益余额、有效期和使用记录</Typography.Text>
          </div>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="center" gap={12} style={{ marginBottom: 12 }}>
            <GiftOutlined style={{ color: "#1677ff", fontSize: 24 }} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              权益余额
            </Typography.Title>
          </Flex>
          <Table
            columns={grantColumns}
            dataSource={grants}
            loading={loading}
            locale={{ emptyText: <Empty description="暂无权益" /> }}
            pagination={false}
            rowKey="grantId"
            size="small"
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            使用记录
          </Typography.Title>
          <Table
            columns={usageColumns}
            dataSource={usages}
            loading={loading}
            locale={{ emptyText: <Empty description="暂无使用记录" /> }}
            pagination={false}
            rowKey="usageId"
            size="small"
          />
        </section>
      </section>
    </main>
  );
}

const grantColumns: ColumnsType<PortalEntitlementGrant> = [
  {
    dataIndex: "name",
    title: "权益"
  },
  {
    dataIndex: "entitlementType",
    render: (value: string) => labelOf(ENTITLEMENT_TYPE_LABELS, value),
    title: "类型"
  },
  {
    dataIndex: "remainingAmount",
    render: (_value: number | null, row) => formatEntitlementAmount(row.remainingAmount, row.unit),
    title: "剩余"
  },
  {
    dataIndex: "usedAmount",
    render: (_value: number | null, row) => formatEntitlementAmount(row.usedAmount, row.unit),
    title: "已用"
  },
  {
    dataIndex: "status",
    render: (value: string) => <Tag>{labelOf(ENTITLEMENT_GRANT_STATUS_LABELS, value)}</Tag>,
    title: "状态"
  },
  {
    dataIndex: "source",
    render: (value: string) => labelOf(ENTITLEMENT_GRANT_SOURCE_LABELS, value),
    title: "来源"
  },
  {
    key: "valid",
    render: (_value, row) => `${row.validFrom ?? "-"} 至 ${row.validTo ?? "-"}`,
    title: "有效期"
  }
];

const usageColumns: ColumnsType<PortalEntitlementUsage> = [
  {
    dataIndex: "grantName",
    title: "权益"
  },
  {
    dataIndex: "amount",
    render: (_value: number, row) => formatEntitlementAmount(row.amount, row.unit),
    title: "使用量"
  },
  {
    dataIndex: "status",
    render: (value: string) => labelOf(ENTITLEMENT_USAGE_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "source",
    render: (value: string) => labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, value),
    title: "来源"
  },
  {
    dataIndex: "occurredAt",
    render: (value: string | null) => formatTime(value),
    title: "发生时间"
  }
];

function formatEntitlementAmount(value: number | null, unit: string) {
  if (unit === "TEXT") {
    return labelOf(ENTITLEMENT_UNIT_LABELS, unit);
  }
  if (value === null) {
    return "-";
  }
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${labelOf(ENTITLEMENT_UNIT_LABELS, unit)}`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};
