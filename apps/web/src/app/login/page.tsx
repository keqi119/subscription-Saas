"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Card, Form, Input, Typography } from "antd";
import { useRouter } from "next/navigation";

import { PLATFORM_NAME } from "@subscription-saas/shared";

import { ApiError, apiFetch } from "../../lib/api";

interface LoginFormValues {
  password: string;
  username: string;
}

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();

  async function onFinish(values: LoginFormValues) {
    try {
      await apiFetch("/auth/login", {
        body: JSON.stringify(values),
        method: "POST"
      });
      router.replace("/");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          void message.error("用户名或密码错误");
          return;
        }

        void message.error(error.message);
        return;
      }

      void message.error("登录失败，请稍后重试");
    }
  }

  return (
    <main
      style={{
        alignItems: "center",
        background: "#f5f7fb",
        display: "flex",
        minHeight: "100vh",
        padding: 24
      }}
    >
      <Card style={{ margin: "0 auto", maxWidth: 420, width: "100%" }}>
        <Typography.Title level={3}>{PLATFORM_NAME}</Typography.Title>
        <Form<LoginFormValues>
          initialValues={{ password: "Admin@123456", username: "admin" }}
          layout="vertical"
          onFinish={onFinish}
        >
          <Form.Item label="账号" name="username" rules={[{ required: true }]}>
            <Input autoComplete="username" prefix={<UserOutlined />} />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, min: 8 }]}>
            <Input.Password autoComplete="current-password" prefix={<LockOutlined />} />
          </Form.Item>
          <Button block htmlType="submit" type="primary">
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}
