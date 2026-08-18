"use client";

import {
  AlertOutlined,
  AuditOutlined,
  CarOutlined,
  DashboardOutlined,
  FileTextOutlined,
  GiftOutlined,
  IdcardOutlined,
  LogoutOutlined,
  MessageOutlined,
  PayCircleOutlined,
  ProfileOutlined,
  SafetyOutlined,
  ToolOutlined
} from "@ant-design/icons";
import { App, Button, Flex, List, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CUSTOMER_ACCOUNT_STATUS_LABELS } from "../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../lib/portal-api";

interface PortalMe {
  accountStatus: string;
  customerAccountId: string;
  customerId: string;
  phone: string;
}

const portalEntries = [
  { href: "/portal/catalog", icon: <CarOutlined />, title: "订阅车辆" },
  { href: "/portal/me", icon: <IdcardOutlined />, title: "我的资料" },
  { href: "/portal/applications", icon: <AuditOutlined />, title: "我的申请" },
  { href: "/portal/contracts", icon: <FileTextOutlined />, title: "我的合同" },
  { href: "/portal/orders", icon: <ProfileOutlined />, title: "我的订单" },
  { href: "/portal/handover-reviews", icon: <AuditOutlined />, title: "车辆交接确认" },
  { href: "/portal/mileage-reviews", icon: <DashboardOutlined />, title: "月度里程复核" },
  { href: "/portal/bills", icon: <FileTextOutlined />, title: "我的账单" },
  { href: "/portal/payment-orders", icon: <PayCircleOutlined />, title: "支付记录" },
  { href: "/portal/notifications", icon: <MessageOutlined />, title: "消息通知" },
  { href: "/portal/deposit", icon: <SafetyOutlined />, title: "我的押金" },
  { href: "/portal/entitlements", icon: <GiftOutlined />, title: "我的权益" },
  {
    href: "/portal/service-cases/new?type=ACCIDENT_REPORT",
    icon: <AlertOutlined />,
    title: "事故报案"
  },
  {
    href: "/portal/service-cases/new?type=RESCUE_REQUEST",
    icon: <ToolOutlined />,
    title: "救援申请"
  }
];

export default function PortalHomePage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [me, setMe] = useState<PortalMe>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalMe>("/portal/auth/me")
      .then(setMe)
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace("/portal/login");
          return;
        }

        void message.error(error instanceof PortalApiError ? error.message : "无法加载客户信息");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  async function logout() {
    try {
      await portalApiFetch("/portal/auth/logout", { method: "POST" });
      router.replace("/portal/login");
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "退出失败");
    }
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 18px" }}>
      <section style={{ margin: "0 auto", maxWidth: 560 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 20 }}>
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>
              客户门户
            </Typography.Title>
            <Typography.Text type="secondary">A 线线上订阅入口</Typography.Text>
          </div>
          <Button icon={<LogoutOutlined />} onClick={logout}>
            退出
          </Button>
        </Flex>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 16,
            padding: 18
          }}
        >
          <Flex align="center" gap={12}>
            <SafetyOutlined style={{ color: "#1677ff", fontSize: 24 }} />
            <div>
              <Typography.Text strong>{loading ? "加载中" : me?.phone}</Typography.Text>
              <div>
                <Tag color="blue">
                  {CUSTOMER_ACCOUNT_STATUS_LABELS[me?.accountStatus ?? ""] ?? "未登录"}
                </Tag>
              </div>
            </div>
          </Flex>
        </section>

        <List
          bordered
          dataSource={portalEntries}
          loading={loading}
          renderItem={(item) => (
            <List.Item
              actions={[
                item.href ? (
                  <Button key="open" onClick={() => router.push(item.href)} type="link">
                    进入
                  </Button>
                ) : (
                  <Tag key="soon">即将上线</Tag>
                )
              ]}
            >
              <List.Item.Meta avatar={item.icon} title={item.title} />
            </List.Item>
          )}
          style={{ background: "#ffffff", borderRadius: 8 }}
        />
      </section>
    </main>
  );
}
