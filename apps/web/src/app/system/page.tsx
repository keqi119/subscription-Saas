"use client";

import { Button, Space, Typography } from "antd";
import { useRouter } from "next/navigation";

import { ProtectedShell } from "../../components/protected-shell";

const systemLinks = [
  { path: "/system/users", title: "用户管理" },
  { path: "/system/roles", title: "角色管理" },
  { path: "/system/permissions", title: "权限管理" },
  { path: "/system/audit-logs", title: "操作日志" }
];

export default function SystemPage() {
  const router = useRouter();

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          系统管理
        </Typography.Title>
        <Space wrap>
          {systemLinks.map((link) => (
            <Button key={link.path} onClick={() => router.push(link.path)}>
              {link.title}
            </Button>
          ))}
        </Space>
      </Space>
    </ProtectedShell>
  );
}
