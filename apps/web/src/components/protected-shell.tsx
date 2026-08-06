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
  MessageOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  TeamOutlined,
  UserOutlined
} from "@ant-design/icons";
import { App, Layout, Menu, Skeleton, Space, Tag, Typography } from "antd";
import type { ItemType } from "antd/es/menu/interface";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { PLATFORM_NAME } from "@subscription-saas/shared";
import type { MenuItemDefinition } from "@subscription-saas/shared";

import { localizeMenuLabel, ROLE_LABELS } from "../constants/labels";
import { apiFetch, ApiError } from "../lib/api";
import type { AuthMeResponse } from "../lib/auth";
import { AccountActions } from "./account-actions";
import { ChangePasswordModal } from "./change-password-modal";

const { Content, Header, Sider } = Layout;

const MENU_OPEN_KEYS_STORAGE_KEY = "subscription-saas.admin.menu.openKeys";

let cachedAuthMe: AuthMeResponse | null = null;

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
  const [me, setMe] = useState<AuthMeResponse | null>(() => cachedAuthMe);
  const [loading, setLoading] = useState(() => !cachedAuthMe);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [currentMenuKey, setCurrentMenuKey] = useState(pathname);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [openKeysRestored, setOpenKeysRestored] = useState(false);

  useEffect(() => {
    let canceled = false;

    apiFetch<AuthMeResponse>("/auth/me")
      .then((profile) => {
        cachedAuthMe = profile;
        if (!canceled) {
          setMe(profile);
        }
      })
      .catch((error: unknown) => {
        if (canceled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          cachedAuthMe = null;
          router.replace("/login");
          return;
        }
        if (error instanceof ApiError) {
          void message.error(error.message);
          return;
        }
        void message.error("无法加载登录信息");
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [message, router]);

  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me?.user.permissions]);
  const menuItems = useMemo(() => buildMenuItems(me?.menus ?? [], permissions), [me?.menus, permissions]);

  useEffect(() => {
    setOpenKeys(readStoredOpenKeys());
    setOpenKeysRestored(true);
  }, []);

  useEffect(() => {
    const syncCurrentMenuKey = () => {
      const queryString = window.location.search.replace(/^\?/, "");
      setCurrentMenuKey(queryString ? `${pathname}?${queryString}` : pathname);
    };

    syncCurrentMenuKey();
    window.addEventListener("popstate", syncCurrentMenuKey);
    return () => window.removeEventListener("popstate", syncCurrentMenuKey);
  }, [pathname]);

  useEffect(() => {
    if (!openKeysRestored || !me) {
      return;
    }

    const routeOpenKeys = findRouteOpenKeys(me.menus, permissions, currentMenuKey, pathname);
    if (!routeOpenKeys.length) {
      return;
    }

    setOpenKeys((current) => {
      const next = mergeKeys(current, routeOpenKeys);
      if (sameKeys(current, next)) {
        return current;
      }
      storeOpenKeys(next);
      return next;
    });
  }, [currentMenuKey, me, openKeysRestored, pathname, permissions]);

  const navigateMenu = (target: string) => {
    if (target === currentMenuKey) {
      return;
    }
    setCurrentMenuKey(target);
    router.push(target);
  };

  const updateOpenKeys = (keys: string[]) => {
    setOpenKeys(keys);
    storeOpenKeys(keys);
  };

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

  const userLabel = me.user.name
    ? `${me.user.name} (${me.user.username})`
    : me.user.username;

  return (
    <>
      <Layout style={{ minHeight: "100vh" }}>
        <Sider breakpoint="lg" collapsedWidth="0" width={248}>
          <div style={{ color: "#fff", fontWeight: 700, padding: "20px 18px" }}>订阅运营中台</div>
          <Menu
            items={menuItems}
            mode="inline"
            onClick={({ key }) => navigateMenu(String(key))}
            onOpenChange={updateOpenKeys}
            openKeys={openKeys}
            selectedKeys={[currentMenuKey, pathname]}
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
              <AccountActions
                onChangePassword={() => setChangePasswordOpen(true)}
                onLogout={() => void logout(router)}
                userLabel={userLabel}
              />
            </Space>
          </Header>
          <Content style={{ padding: 24 }}>{children}</Content>
        </Layout>
      </Layout>
      <ChangePasswordModal
        onCancel={() => setChangePasswordOpen(false)}
        onChanged={() => {
          cachedAuthMe = null;
          setChangePasswordOpen(false);
          router.replace("/login");
        }}
        open={changePasswordOpen}
      />
    </>
  );
}

function readStoredOpenKeys() {
  if (typeof window === "undefined") {
    return [];
  }
  const rawValue = window.sessionStorage.getItem(MENU_OPEN_KEYS_STORAGE_KEY);
  if (!rawValue) {
    return [];
  }
  try {
    const value = JSON.parse(rawValue);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function storeOpenKeys(keys: string[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(MENU_OPEN_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

function mergeKeys(current: string[], keys: string[]) {
  return Array.from(new Set([...current, ...keys]));
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function findRouteOpenKeys(
  menus: MenuItemDefinition[],
  permissions: Set<string>,
  currentMenuKey: string,
  pathname: string
) {
  const allowedMenus = menus.filter((menu) => !menu.permissionCode || permissions.has(menu.permissionCode));
  const allowedCodes = new Set(allowedMenus.map((menu) => menu.code));
  const activeMenu = findActiveMenu(allowedMenus, currentMenuKey, pathname);

  if (!activeMenu) {
    return [];
  }

  const codeSegments = activeMenu.code.split(".");
  return codeSegments
    .slice(0, -1)
    .map((_, index) => codeSegments.slice(0, index + 1).join("."))
    .filter((code) => allowedCodes.has(code));
}

function findActiveMenu(menus: MenuItemDefinition[], currentMenuKey: string, pathname: string) {
  const exactWithQuery = findDeepestMenu(menus.filter((menu) => menu.path === currentMenuKey));
  if (exactWithQuery) {
    return exactWithQuery;
  }

  const exactPath = findDeepestMenu(menus.filter((menu) => menu.path === pathname));
  if (exactPath) {
    return exactPath;
  }

  return menus
    .filter((menu) => !menu.path.includes("?") && isPathPrefix(pathname, menu.path))
    .sort((left, right) => right.path.length - left.path.length || menuDepth(right) - menuDepth(left))[0];
}

function findDeepestMenu(menus: MenuItemDefinition[]) {
  return [...menus].sort((left, right) => menuDepth(right) - menuDepth(left))[0];
}

function menuDepth(menu: MenuItemDefinition) {
  return menu.code.split(".").length;
}

function isPathPrefix(pathname: string, menuPath: string) {
  return pathname === menuPath || pathname.startsWith(`${menuPath}/`);
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
  cachedAuthMe = null;
  await apiFetch("/auth/logout", { method: "POST" });
  router.replace("/login");
}
