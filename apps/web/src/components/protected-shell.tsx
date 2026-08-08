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
import type { ReactNode, UIEventHandler } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PLATFORM_NAME } from "@subscription-saas/shared";
import type { MenuItemDefinition } from "@subscription-saas/shared";

import { localizeMenuLabel, ROLE_LABELS } from "../constants/labels";
import {
  getAdminMenuState,
  persistAdminMenuOpenKeys,
  persistAdminMenuScrollTop,
  resolveAdminMenuOpenKeys
} from "../lib/admin-menu-state";
import { apiFetch, ApiError } from "../lib/api";
import type { AuthMeResponse } from "../lib/auth";
import { AccountActions } from "./account-actions";
import { AdminShellFrame } from "./admin-shell-frame";
import { ChangePasswordModal } from "./change-password-modal";

const { Content } = Layout;

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
  const [openKeys, setOpenKeys] = useState<string[]>(
    () => getAdminMenuState().openKeys
  );
  const menuScrollRef = useRef<HTMLDivElement | null>(null);
  const initialMenuScrollTopRef = useRef(getAdminMenuState().scrollTop);

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
    const syncCurrentMenuKey = () => {
      const queryString = window.location.search.replace(/^\?/, "");
      setCurrentMenuKey(queryString ? `${pathname}?${queryString}` : pathname);
    };

    syncCurrentMenuKey();
    window.addEventListener("popstate", syncCurrentMenuKey);
    return () => window.removeEventListener("popstate", syncCurrentMenuKey);
  }, [pathname]);

  useEffect(() => {
    if (!me) {
      return;
    }

    const routeOpenKeys = findRouteOpenKeys(me.menus, permissions, currentMenuKey, pathname);
    const allowedMenuCodes = new Set(
      me.menus
        .filter((menu) => !menu.permissionCode || permissions.has(menu.permissionCode))
        .map((menu) => menu.code)
    );

    setOpenKeys((current) => {
      const next = resolveAdminMenuOpenKeys(
        current,
        routeOpenKeys,
        allowedMenuCodes
      );
      if (sameKeys(current, next)) {
        return current;
      }
      persistAdminMenuOpenKeys(next);
      return next;
    });
  }, [currentMenuKey, me, pathname, permissions]);

  useLayoutEffect(() => {
    if (!loading && menuScrollRef.current) {
      menuScrollRef.current.scrollTop = initialMenuScrollTopRef.current;
    }
  }, [loading]);

  const navigateMenu = (target: string) => {
    if (target === currentMenuKey) {
      return;
    }
    setCurrentMenuKey(target);
    router.push(target);
  };

  const updateOpenKeys = (keys: string[]) => {
    setOpenKeys(keys);
    persistAdminMenuOpenKeys(keys);
  };

  const handleMenuScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const scrollTop = event.currentTarget.scrollTop;
    initialMenuScrollTopRef.current = scrollTop;
    persistAdminMenuScrollTop(scrollTop);
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
      <AdminShellFrame
        brand="订阅运营中台"
        header={
          <>
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
          </>
        }
        menu={
          <Menu
            items={menuItems}
            mode="inline"
            onClick={({ key }) => navigateMenu(String(key))}
            onOpenChange={updateOpenKeys}
            openKeys={openKeys}
            selectedKeys={[currentMenuKey, pathname]}
            theme="dark"
          />
        }
        menuScrollRef={menuScrollRef}
        onMenuScroll={handleMenuScroll}
      >
        {children}
      </AdminShellFrame>
      <ChangePasswordModal
        onCancel={() => setChangePasswordOpen(false)}
        onChanged={() =>
          finishPasswordChangeSession(router, () => setChangePasswordOpen(false))
        }
        open={changePasswordOpen}
      />
    </>
  );
}

export function finishPasswordChangeSession(
  router: Pick<ReturnType<typeof useRouter>, "replace">,
  closeModal: () => void
) {
  cachedAuthMe = null;
  closeModal();
  router.replace("/login");
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
