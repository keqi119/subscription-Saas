"use client";

import {
  AuditOutlined,
  CarOutlined,
  CalculatorOutlined,
  DashboardOutlined,
  DollarOutlined,
  FileOutlined,
  FileTextOutlined,
  KeyOutlined,
  LogoutOutlined,
  MessageOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  TeamOutlined,
  UserOutlined
} from "@ant-design/icons";
import { App, Button, Layout, Menu, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { ItemType } from "antd/es/menu/interface";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { PLATFORM_NAME } from "@subscription-saas/shared";
import type { MenuItemDefinition } from "@subscription-saas/shared";

import { localizeMenuLabel, ROLE_LABELS } from "../constants/labels";
import { apiFetch, ApiError } from "../lib/api";
import type { AuthMeResponse } from "../lib/auth";

const { Content, Header, Sider } = Layout;

const iconMap: Record<string, ReactNode> = {
  application: <FileTextOutlined />,
  audit: <AuditOutlined />,
  car: <CarOutlined />,
  contract: <ProfileOutlined />,
  customer: <UserOutlined />,
  dashboard: <DashboardOutlined />,
  file: <FileOutlined />,
  key: <KeyOutlined />,
  message: <MessageOutlined />,
  money: <DollarOutlined />,
  order: <ShoppingCartOutlined />,
  product: <ShoppingOutlined />,
  quote: <CalculatorOutlined />,
  safety: <SafetyCertificateOutlined />,
  setting: <SettingOutlined />,
  team: <TeamOutlined />
};

export function ProtectedShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const { message } = App.useApp();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          router.replace("/login");
          return;
        }
        if (error instanceof ApiError) {
          void message.error(error.message);
          return;
        }
        void message.error("无法加载登录信息");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me?.user.permissions]);
  const menuItems = useMemo(() => buildMenuItems(me?.menus ?? [], permissions), [me?.menus, permissions]);

  if (loading) {
    return (
      <Layout style={{ minHeight: "100vh" }}>
        <Content style={{ padding: 24 }}>
          <Skeleton active />
        </Content>
      </Layout>
    );
  }

  if (!me) {
    return null;
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth="0" width={248}>
        <div style={{ color: "#fff", fontWeight: 700, padding: "20px 18px" }}>订阅运营中台</div>
        <Menu
          items={menuItems}
          mode="inline"
          onClick={({ key }) => router.push(String(key))}
          selectedKeys={[pathname]}
          theme="dark"
        />
      </Sider>
      <Layout>
        <Header
          style={{
            alignItems: "center",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            height: 64,
            justifyContent: "space-between",
            padding: "0 24px"
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {PLATFORM_NAME}
          </Typography.Title>
          <Space>
            {me.user.roles.map((role) => (
              <Tag color="blue" key={role}>
                {ROLE_LABELS[role] ?? role}
              </Tag>
            ))}
            <Tooltip title="退出登录">
              <Button
                aria-label="退出登录"
                icon={<LogoutOutlined />}
                onClick={() => logout(router)}
                type="text"
              />
            </Tooltip>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>{children}</Content>
      </Layout>
    </Layout>
  );
}

function buildMenuItems(menus: MenuItemDefinition[], permissions: Set<string>): ItemType[] {
  const allowedMenus = menus.filter((menu) => !menu.permissionCode || permissions.has(menu.permissionCode));
  const byCode = new Map(
    allowedMenus.map((menu) => [menu.code, { ...menu, children: [] as MenuItemDefinition[] }])
  );
  const roots: Array<MenuItemDefinition & { children: MenuItemDefinition[] }> = [];

  for (const menu of byCode.values()) {
    if (menu.code.includes(".")) {
      const parentCode = menu.code.split(".").slice(0, -1).join(".");
      const parent = byCode.get(parentCode);
      if (parent) {
        parent.children.push(menu);
        continue;
      }
    }
    roots.push(menu);
  }

  return roots.map((menu) => ({
    children: menu.children.length ? buildMenuItems(menu.children, permissions) : undefined,
    icon: menu.icon ? iconMap[menu.icon] : undefined,
    key: menu.children.length ? menu.code : menu.path,
    label: localizeMenuLabel(menu)
  }));
}

async function logout(router: ReturnType<typeof useRouter>) {
  await apiFetch("/auth/logout", { method: "POST" });
  router.replace("/login");
}
