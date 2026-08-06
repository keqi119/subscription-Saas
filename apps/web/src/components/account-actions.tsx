"use client";

import { KeyOutlined, LogoutOutlined } from "@ant-design/icons";
import { Button, Space, Typography } from "antd";

export function AccountActions({
  onChangePassword,
  onLogout,
  userLabel
}: Readonly<{ onChangePassword: () => void; onLogout: () => void; userLabel: string }>) {
  return (
    <Space>
      <Typography.Text>{userLabel}</Typography.Text>
      <Button icon={<KeyOutlined />} onClick={onChangePassword} type="text">
        修改密码
      </Button>
      <Button aria-label="退出登录" icon={<LogoutOutlined />} onClick={onLogout} type="text">
        退出登录
      </Button>
    </Space>
  );
}
