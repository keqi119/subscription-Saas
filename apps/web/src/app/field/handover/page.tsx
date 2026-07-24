"use client";

import { CarOutlined, LoginOutlined, MobileOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, App, Button, Flex, Form, Input, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  getFieldHandoverLoginErrorMessage,
  getFieldHandoverSendCodeErrorMessage,
  getFieldHandoverSession,
  isFieldHandoverUnauthorized,
  isValidFieldHandoverPhone,
  loginFieldHandover,
  sendFieldHandoverCode
} from "../../../lib/field-handover-api";

interface FieldHandoverLoginValues {
  code: string;
  phone: string;
}

export default function FieldHandoverLoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<FieldHandoverLoginValues>();
  const [countdown, setCountdown] = useState(0);
  const [requestingCode, setRequestingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    getFieldHandoverSession()
      .then((session) => {
        if (active && session.authenticated) {
          router.replace("/field/handover/tasks");
        }
      })
      .catch((error) => {
        if (!isFieldHandoverUnauthorized(error)) {
          void message.warning("交接登录状态暂不可用，请稍后重试");
        }
      })
    return () => {
      active = false;
    };
  }, [message, router]);

  useEffect(() => {
    if (countdown <= 0) {
      return;
    }

    const timer = window.setTimeout(() => setCountdown((value) => Math.max(value - 1, 0)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  async function requestCode() {
    const phone = String(form.getFieldValue("phone") ?? "").trim();
    if (!isValidFieldHandoverPhone(phone)) {
      form.setFields([{ errors: ["请输入正确的手机号"], name: "phone" }]);
      void message.error("请输入正确的手机号");
      return;
    }

    try {
      setRequestingCode(true);
      const result = await sendFieldHandoverCode(phone);
      setCountdown(Math.min(Math.max(result.expiresIn, 1), 60));
      void message.success("验证码已发送，请查收短信");
    } catch (error) {
      void message.error(getFieldHandoverSendCodeErrorMessage(error));
    } finally {
      setRequestingCode(false);
    }
  }

  async function login(values: FieldHandoverLoginValues) {
    try {
      setSubmitting(true);
      await loginFieldHandover(values.phone, values.code);
      router.replace("/field/handover/tasks");
    } catch (error) {
      void message.error(getFieldHandoverLoginErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        background: "linear-gradient(180deg, #eef6ff 0%, #f7f9fc 42%, #ffffff 100%)",
        minHeight: "100vh",
        padding: "max(28px, env(safe-area-inset-top)) 18px max(28px, env(safe-area-inset-bottom))"
      }}
    >
      <section style={{ margin: "0 auto", maxWidth: 430 }}>
        <Flex align="center" gap={12} style={{ marginBottom: 18 }}>
          <div
            aria-hidden="true"
            style={{
              alignItems: "center",
              background: "#1677ff",
              borderRadius: 8,
              color: "#fff",
              display: "flex",
              height: 44,
              justifyContent: "center",
              width: 44
            }}
          >
            <CarOutlined style={{ fontSize: 22 }} />
          </div>
          <div>
            <Typography.Title level={2} style={{ fontSize: 24, lineHeight: 1.2, margin: 0 }}>
              车辆现场交接
            </Typography.Title>
            <Typography.Text style={{ color: "#536173" }}>
              请使用被分配交接任务的手机号登录
            </Typography.Text>
          </div>
        </Flex>

        <Alert
          message="短信只用于登录验证，不包含任务链接。"
          showIcon
          style={{ marginBottom: 18 }}
          type="info"
        />

        <div
          style={{
            background: "#fff",
            border: "1px solid #dde5f0",
            borderRadius: 8,
            boxShadow: "0 10px 26px rgba(38, 86, 136, 0.08)",
            padding: 18
          }}
        >
          <Form<FieldHandoverLoginValues> form={form} layout="vertical" onFinish={login}>
            <Form.Item
              label="手机号"
              name="phone"
              rules={[
                { required: true, message: "请输入手机号" },
                { pattern: /^1[3-9]\d{9}$/, message: "请输入正确的手机号" }
              ]}
            >
              <Input
                autoComplete="tel"
                inputMode="tel"
                maxLength={11}
                prefix={<MobileOutlined />}
                size="large"
              />
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
                  size="large"
                />
                <Button
                  disabled={countdown > 0}
                  loading={requestingCode}
                  onClick={requestCode}
                  size="large"
                  style={{ minWidth: 118 }}
                >
                  {countdown > 0 ? `${countdown}s` : "获取验证码"}
                </Button>
              </Flex>
            </Form.Item>

            <Button
              block
              htmlType="submit"
              icon={<LoginOutlined />}
              loading={submitting}
              size="large"
              type="primary"
            >
              登录
            </Button>
          </Form>
        </div>
      </section>
    </main>
  );
}
