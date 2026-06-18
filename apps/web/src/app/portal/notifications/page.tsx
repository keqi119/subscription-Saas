"use client";

import { ArrowLeftOutlined, CheckOutlined, MailOutlined, ReloadOutlined } from "@ant-design/icons";
import { App, Badge, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import type { PortalNotification, PortalNotificationListResponse } from "../../../lib/portal-types";

const statusColors: Record<string, string> = {
  FAILED: "red",
  PENDING: "gold",
  READ: "default",
  SENT: "green",
  SKIPPED: "default"
};

export default function PortalNotificationsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [items, setItems] = useState<PortalNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const result = await portalApiFetch<PortalNotificationListResponse>("/portal/notifications?pageSize=50");
      setItems(result.items);
      setUnreadCount(result.unreadCount);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/notifications")}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载消息通知");
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  async function markRead(item: PortalNotification) {
    if (item.readAt) {
      openNotificationUrl(item.url);
      return;
    }

    try {
      await portalApiFetch(`/portal/notifications/${item.notificationId}/read`, { method: "POST" });
      await loadNotifications();
      openNotificationUrl(item.url);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "标记已读失败");
    }
  }

  async function markAllRead() {
    try {
      await portalApiFetch("/portal/notifications/read-all", { method: "POST" });
      await loadNotifications();
      void message.success("已全部标记为已读");
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "标记全部已读失败");
    }
  }

  function openNotificationUrl(url: string | null) {
    if (!url) {
      return;
    }

    if (url.startsWith("/")) {
      router.push(url);
      return;
    }

    try {
      const target = new URL(url);
      if (target.origin === window.location.origin) {
        router.push(`${target.pathname}${target.search}${target.hash}`);
        return;
      }
    } catch {
      return;
    }

    window.location.assign(url);
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              消息通知
            </Typography.Title>
            <Typography.Text type="secondary">查看申请、合同、支付和服务工单进度提醒</Typography.Text>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadNotifications()}>
              刷新
            </Button>
            <Button disabled={!unreadCount} icon={<CheckOutlined />} onClick={() => void markAllRead()}>
              全部已读
            </Button>
          </Space>
        </Flex>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 16,
            padding: 16
          }}
        >
          <Space>
            <Badge count={unreadCount} overflowCount={99}>
              <MailOutlined style={{ color: "#1677ff", fontSize: 24 }} />
            </Badge>
            <Typography.Text strong>未读消息 {unreadCount} 条</Typography.Text>
          </Space>
        </section>

        <List
          dataSource={items}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无消息通知" /> }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button key="read" onClick={() => void markRead(item)} type="link">
                  {item.url ? "查看" : item.readAt ? "已读" : "标记已读"}
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
                avatar={<Badge dot={!item.readAt}><MailOutlined /></Badge>}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">{item.content ?? "-"}</Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color="blue">{labelOf(NOTIFICATION_TYPE_LABELS, item.notificationType)}</Tag>
                      <Tag>{labelOf(NOTIFICATION_CHANNEL_LABELS, item.channel)}</Tag>
                      <Tag color={statusColors[item.notificationStatus] ?? "default"}>
                        {item.readAt ? "已读" : labelOf(NOTIFICATION_STATUS_LABELS, item.notificationStatus)}
                      </Tag>
                      <Typography.Text type="secondary">{formatTime(item.createdAt)}</Typography.Text>
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{item.title ?? item.notificationNo}</Typography.Text>}
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
