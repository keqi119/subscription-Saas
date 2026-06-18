"use client";

import { AlertOutlined, ArrowLeftOutlined, PlusOutlined, ToolOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  SERVICE_CASE_STATUS_LABELS,
  SERVICE_CASE_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalPagedResponse, PortalServiceCase } from "../../../lib/portal-types";

const statusColors: Record<string, string> = {
  ACCEPTED: "blue",
  CANCELLED: "default",
  CLOSED: "green",
  IN_PROGRESS: "processing",
  RESOLVED: "green",
  SUBMITTED: "gold",
  WAITING_CUSTOMER: "orange"
};

export default function PortalServiceCasesPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [items, setItems] = useState<PortalServiceCase[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalPagedResponse<PortalServiceCase>>("/portal/service-cases")
      .then((result) => setItems(result.items))
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/service-cases")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载服务工单");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的服务工单
            </Typography.Title>
            <Typography.Text type="secondary">提交事故报案、救援申请并查看处理进度</Typography.Text>
          </div>
        </Flex>

        <Flex gap={10} style={{ marginBottom: 16 }} wrap="wrap">
          <Button
            icon={<AlertOutlined />}
            onClick={() => router.push("/portal/service-cases/new?type=ACCIDENT_REPORT")}
            type="primary"
          >
            事故报案
          </Button>
          <Button
            icon={<ToolOutlined />}
            onClick={() => router.push("/portal/service-cases/new?type=RESCUE_REQUEST")}
          >
            救援申请
          </Button>
        </Flex>

        <List
          dataSource={items}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无服务工单" /> }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="detail" onClick={() => router.push(`/portal/service-cases/${item.id}`)} type="link">
                  查看详情
                </Button>
              ]}
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                marginBottom: 12,
                padding: 16
              }}
            >
              <List.Item.Meta
                avatar={item.caseType === "ACCIDENT_REPORT" ? <AlertOutlined /> : <ToolOutlined />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      {item.order?.orderNo ?? "未关联订单"} · {item.vehicle?.displayName ?? "车辆待确认"}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      提交时间 {formatTime(item.createdAt)}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color="blue">{labelOf(SERVICE_CASE_TYPE_LABELS, item.caseType)}</Tag>
                      <Tag color={statusColors[item.caseStatus] ?? "default"}>
                        {labelOf(SERVICE_CASE_STATUS_LABELS, item.caseStatus)}
                      </Tag>
                      {item.attachments.length > 0 ? <Tag icon={<PlusOutlined />}>{item.attachments.length} 个附件</Tag> : null}
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{item.caseNo}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
