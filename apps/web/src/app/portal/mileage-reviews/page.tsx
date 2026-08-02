"use client";

import { ArrowLeftOutlined, DashboardOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, List, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  getMileageReviewPresentation,
  getPortalMileageReviewGuidance,
  isMileageReviewOverdue,
  sortMileageReviewQueue,
  type MileageReviewPage,
  type MileageReviewView
} from "../../../lib/mileage-review-view-model";

export default function PortalMileageReviewsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [page, setPage] = useState<MileageReviewPage>({ items: [], page: 1, pageSize: 50, total: 0 });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(undefined);
    try {
      setPage(await portalApiFetch<MileageReviewPage>("/portal/mileage-reviews?page=1&pageSize=100"));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/mileage-reviews")}`);
        return;
      }
      const text = error instanceof Error ? error.message : "里程复核列表加载失败";
      setErrorMessage(text);
      void message.error(text);
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => sortMileageReviewQueue(page.items), [page.items]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "20px 12px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 760 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 10 }}>返回门户</Button>
            <Typography.Title level={2} style={{ margin: 0 }}>月度里程复核</Typography.Title>
            <Typography.Text type="secondary">按实际交付日对应的月度周期提交累计里程与仪表盘照片。</Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Flex>

        <Alert
          message="未按时提交不会影响固定月租账单，但会延后里程额度核销和超里程计费。"
          showIcon
          style={{ marginBottom: 14 }}
          type="info"
        />

        {loading ? <section style={cardStyle}><Flex align="center" gap={10}><Spin /><span>正在加载里程复核...</span></Flex></section> : null}
        {!loading && errorMessage ? <Alert action={<Button onClick={() => void load()}>重试</Button>} message={errorMessage} showIcon type="error" /> : null}
        {!loading && !errorMessage ? (
          <List
            dataSource={items}
            locale={{ emptyText: <Empty description="暂无里程复核记录" /> }}
            renderItem={(item) => <MileageReviewCard item={item} onOpen={(href) => router.push(href)} />}
          />
        ) : null}
      </section>
    </main>
  );
}

function MileageReviewCard({ item, onOpen }: { item: MileageReviewView; onOpen: (href: string) => void }) {
  const overdue = isMileageReviewOverdue(item);
  const presentation = getMileageReviewPresentation(item.status, overdue);
  const guidance = getPortalMileageReviewGuidance(item);
  return (
    <List.Item style={cardStyle}>
      <Flex gap={14} style={{ width: "100%" }}>
        <DashboardOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />
        <div style={{ minWidth: 0, width: "100%" }}>
          <Flex align="flex-start" gap={8} justify="space-between" wrap="wrap">
            <div>
              <Typography.Text strong>{item.order.orderNo} · 第 {item.cycleNo} 期</Typography.Text>
              <div><Typography.Text type="secondary">{item.vehicle.plateNo || item.vehicle.vin || "车辆"}</Typography.Text></div>
            </div>
            <Tag color={presentation.color}>{presentation.label}</Tag>
          </Flex>
          <Space orientation="vertical" size={3} style={{ marginTop: 10, width: "100%" }}>
            <Typography.Text type="secondary">周期：{dayjs(item.periodStart).format("YYYY-MM-DD")} 至 {dayjs(item.periodEnd).format("YYYY-MM-DD")}</Typography.Text>
            <Typography.Text type="secondary">提交截止：{dayjs(item.dueAt).format("YYYY-MM-DD HH:mm")}</Typography.Text>
            <Typography.Text type="secondary">上期确认里程：{item.baselineMileageKm.toLocaleString("zh-CN")} km</Typography.Text>
          </Space>
          <Button block onClick={() => onOpen(guidance.href)} style={{ marginTop: 14 }} type={guidance.kind === "ACTION" ? "primary" : "default"}>
            {guidance.actionLabel}
          </Button>
        </div>
      </Flex>
    </List.Item>
  );
}

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 12,
  marginBottom: 12,
  padding: 16
};
