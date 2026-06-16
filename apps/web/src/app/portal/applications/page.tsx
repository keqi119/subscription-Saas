"use client";

import { ArrowLeftOutlined, FileSearchOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { STATUS_LABELS } from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalApplicationListItem } from "../../../lib/portal-types";

export default function PortalApplicationsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [applications, setApplications] = useState<PortalApplicationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalApplicationListItem[]>("/portal/applications")
      .then(setApplications)
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/applications")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载申请列表");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的申请
            </Typography.Title>
            <Typography.Text type="secondary">查看提交审核进度</Typography.Text>
          </div>
          <Button icon={<PlusOutlined />} onClick={() => router.push("/portal/catalog")} type="primary">
            去选车
          </Button>
        </Flex>

        <List
          dataSource={applications}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无申请" /> }}
          renderItem={(application) => (
            <List.Item
              actions={[
                <Button
                  key="detail"
                  onClick={() => router.push(`/portal/applications/${application.id}`)}
                  type="link"
                >
                  查看进度
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
                avatar={<FileSearchOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      {application.vehicle.displayName || "意向车辆"} · {application.plan.planName ?? "订阅套餐"}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color="blue">{STATUS_LABELS[application.status] ?? application.status}</Tag>
                      <Tag>{STATUS_LABELS[application.depositStatus] ?? application.depositStatus}</Tag>
                      <Tag>{STATUS_LABELS[application.planConfirmStatus] ?? application.planConfirmStatus}</Tag>
                    </Space>
                  </Space>
                }
                title={
                  <Typography.Text strong>
                    {application.applicationNo}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

