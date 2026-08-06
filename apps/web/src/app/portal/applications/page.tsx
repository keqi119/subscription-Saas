"use client";

import { ArrowLeftOutlined, CalendarOutlined, FileSearchOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Empty, Flex, List, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { STATUS_LABELS } from "../../../constants/labels";
import {
  getPortalSubscriptionChange,
  listPortalRenewals,
  PortalApiError,
  portalApiFetch
} from "../../../lib/portal-api";
import {
  getPortalRenewalApplicationCard,
  toPortalRenewalDetail
} from "../../../lib/portal-renewal-view-model";
import type {
  PortalApplicationListItem,
  PortalRenewalDetail
} from "../../../lib/portal-types";

export default function PortalApplicationsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [applications, setApplications] = useState<PortalApplicationListItem[]>([]);
  const [renewals, setRenewals] = useState<PortalRenewalDetail[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalApplicationListItem[]>("/portal/applications"),
      listPortalRenewals()
    ])
      .then(async ([nextApplications, nextRenewals]) => {
        const details = await Promise.all(
          nextRenewals.map(async (renewal) =>
            toPortalRenewalDetail(
              renewal,
              renewal.changeOrderId
                ? await getPortalSubscriptionChange(renewal.changeOrderId).catch(() => null)
                : null
            )
          )
        );
        setApplications(nextApplications);
        setRenewals(details);
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/applications")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载申请与续订安排");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 920 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }} wrap="wrap">
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的申请
            </Typography.Title>
            <Typography.Text type="secondary">查看提交审核进度及续订与到期安排</Typography.Text>
          </div>
          <Button icon={<PlusOutlined />} onClick={() => router.push("/portal/catalog")} type="primary">
            去选车
          </Button>
        </Flex>

        {renewals.length ? (
          <section style={{ marginBottom: 22 }}>
            <Typography.Title level={4}>续订与到期安排</Typography.Title>
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              {renewals.map((renewal) => {
                const card = getPortalRenewalApplicationCard(renewal);
                return (
                  <Card key={renewal.id} size="small">
                    <Flex align="center" gap={16} justify="space-between" wrap="wrap">
                      <Space align="start">
                        <CalendarOutlined style={{ color: "#1677ff", fontSize: 24 }} />
                        <div>
                          <Typography.Text strong>{card.label}</Typography.Text>
                          <br />
                          <Typography.Text type="secondary">{card.message}</Typography.Text>
                        </div>
                      </Space>
                      <Button
                        onClick={() => router.push(card.url || `/portal/renewals/${renewal.id}`)}
                        type="primary"
                      >
                        查看续订进度
                      </Button>
                    </Flex>
                  </Card>
                );
              })}
            </Space>
          </section>
        ) : loading ? null : (
          <Alert message="当前没有待处理的续订或到期安排" showIcon style={{ marginBottom: 22 }} type="info" />
        )}

        <Typography.Title level={4}>车辆订阅申请</Typography.Title>
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
              style={cardStyle}
            >
              <List.Item.Meta
                avatar={<FileSearchOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space orientation="vertical" size={8}>
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
                title={<Typography.Text strong>{application.applicationNo}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 12,
  padding: 16
};
