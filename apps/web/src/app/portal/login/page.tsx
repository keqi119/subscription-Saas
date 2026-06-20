"use client";

import { MobileOutlined, SafetyCertificateOutlined, WechatOutlined } from "@ant-design/icons";
import { Alert, App, Button, Checkbox, Flex, Form, Input, Typography } from "antd";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";

const PORTAL_BETA_GATE_MESSAGE = "当前客户门户处于受邀试运行阶段，请联系工作人员开通。";
const PORTAL_SMS_SEND_FAILURE_MESSAGE = "验证码发送失败，请稍后重试或联系客服。";

interface RequestCodeResponse {
  debugCode?: string;
  expiresIn: number;
  sent: boolean;
}

interface PortalLoginFormValues {
  agreement: boolean;
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
        void message.error("请输入正确的手机号码");
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
      void message.error(getRequestCodeErrorMessage(error));
    } finally {
      setRequestingCode(false);
    }
  }

  async function login(values: PortalLoginFormValues) {
    try {
      setSubmitting(true);
      await portalApiFetch("/portal/auth/login", {
        body: JSON.stringify({ code: values.code, phone: values.phone }),
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
          使用手机号验证码登录。后续可从微信服务号菜单进入客户 H5。
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

          <Form.Item
            name="agreement"
            rules={[
              {
                validator: (_, value: boolean | undefined) =>
                  value ? Promise.resolve() : Promise.reject(new Error("请先阅读并同意用户协议和隐私政策"))
              }
            ]}
            valuePropName="checked"
          >
            <Checkbox>
              我已阅读并同意
              <Link href="/portal/terms">《用户协议》</Link>
              和
              <Link href="/portal/privacy">《隐私政策》</Link>
            </Checkbox>
          </Form.Item>

          {debugCode ? (
            <Alert
              message={`开发 / 测试验证码：${debugCode}`}
              showIcon
              style={{ marginBottom: 16 }}
              type="info"
            />
          ) : null}

          <Button block htmlType="submit" loading={submitting} type="primary">
            登录
          </Button>
          <Button block disabled icon={<WechatOutlined />} style={{ marginTop: 12 }}>
            微信一键登录待开放
          </Button>
        </Form>
      </section>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof PortalApiError ? error.message : "操作失败，请稍后重试";
}

function getRequestCodeErrorMessage(error: unknown) {
  if (!(error instanceof PortalApiError)) {
    return PORTAL_SMS_SEND_FAILURE_MESSAGE;
  }

  if (error.message === PORTAL_BETA_GATE_MESSAGE || error.message === PORTAL_SMS_SEND_FAILURE_MESSAGE) {
    return error.message;
  }

  return error.status === 0 || error.status >= 500 ? PORTAL_SMS_SEND_FAILURE_MESSAGE : error.message;
}

function resolvePortalRedirect(value: string | null) {
  return value?.startsWith("/portal") ? value : "/portal";
}
