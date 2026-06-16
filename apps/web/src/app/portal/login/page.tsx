"use client";

import { MobileOutlined, SafetyCertificateOutlined, WechatOutlined } from "@ant-design/icons";
import { Alert, App, Button, Flex, Form, Input, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";

interface RequestCodeResponse {
  debugCode?: string;
  expiresIn: number;
  sent: boolean;
}

interface PortalLoginFormValues {
  code: string;
  phone: string;
}

export default function PortalLoginPage() {
  return (
    <Suspense fallback={null}>
      <PortalLoginPageContent />
    </Suspense>
  );
}

function PortalLoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [form] = Form.useForm<PortalLoginFormValues>();
  const [debugCode, setDebugCode] = useState<string>();
  const [requestingCode, setRequestingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => setCountdown((value) => Math.max(value - 1, 0)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  async function requestCode() {
    try {
      const phone = form.getFieldValue("phone") as string | undefined;
      if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
        void message.error("请输入正确的手机号");
        return;
      }

      setRequestingCode(true);
      const result = await portalApiFetch<RequestCodeResponse>("/portal/auth/request-code", {
        body: JSON.stringify({ phone }),
        method: "POST"
      });
      setDebugCode(result.debugCode);
      setCountdown(60);
      void message.success("验证码已发送");
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setRequestingCode(false);
    }
  }

  async function login(values: PortalLoginFormValues) {
    try {
      setSubmitting(true);
      await portalApiFetch("/portal/auth/login", {
        body: JSON.stringify(values),
        method: "POST"
      });
      router.replace(resolvePortalRedirect(searchParams.get("redirect")));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        background: "#f6f8fb",
        minHeight: "100vh",
        padding: "32px 20px"
      }}
    >
      <section style={{ margin: "0 auto", maxWidth: 420 }}>
        <Typography.Title level={2} style={{ marginBottom: 8 }}>
          客户门户
        </Typography.Title>
        <Typography.Paragraph style={{ color: "#566273", marginBottom: 28 }}>
          使用手机号验证码登录，后续可从微信服务号菜单进入。
        </Typography.Paragraph>

        <Form<PortalLoginFormValues> form={form} layout="vertical" onFinish={login}>
          <Form.Item
            label="手机号"
            name="phone"
            rules={[
              { required: true, message: "请输入手机号" },
              { pattern: /^1[3-9]\d{9}$/, message: "请输入正确的手机号" }
            ]}
          >
            <Input autoComplete="tel" inputMode="tel" prefix={<MobileOutlined />} />
          </Form.Item>

          <Form.Item
            label="验证码"
            name="code"
            rules={[
              { required: true, message: "请输入验证码" },
              { pattern: /^\d{6}$/, message: "请输入 6 位数字验证码" }
            ]}
          >
            <Flex gap={8}>
              <Input
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                prefix={<SafetyCertificateOutlined />}
              />
              <Button disabled={countdown > 0} loading={requestingCode} onClick={requestCode}>
                {countdown > 0 ? `${countdown}s` : "获取验证码"}
              </Button>
            </Flex>
          </Form.Item>

          {debugCode ? (
            <Alert
              message={`开发/测试验证码：${debugCode}`}
              showIcon
              style={{ marginBottom: 16 }}
              type="info"
            />
          ) : null}

          <Button block htmlType="submit" loading={submitting} type="primary">
            登录
          </Button>
          <Button block disabled icon={<WechatOutlined />} style={{ marginTop: 12 }}>
            微信登录，暂未开通
          </Button>
        </Form>
      </section>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof PortalApiError ? error.message : "操作失败，请稍后重试";
}

function resolvePortalRedirect(value: string | null) {
  return value?.startsWith("/portal") ? value : "/portal";
}
