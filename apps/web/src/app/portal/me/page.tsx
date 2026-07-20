"use client";

import { Alert, App, Button, Descriptions, Form, Input, Skeleton, Space, Tag, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { CUSTOMER_ACCOUNT_STATUS_LABELS } from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import type { PortalCustomerProfile, PortalMissingProfileField } from "../../../lib/portal-types";

interface PortalMe {
  accountStatus: string;
  customerAccountId: string;
  customerId: string;
  phone: string;
}

interface PortalProfileFormValues {
  idCardNo?: string;
  mobile: string;
  name: string;
}

export default function PortalMePage() {
  return (
    <Suspense fallback={<PortalMeLoadingShell />}>
      <PortalMeContent />
    </Suspense>
  );
}

function PortalMeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [form] = Form.useForm<PortalProfileFormValues>();
  const [me, setMe] = useState<PortalMe>();
  const [profile, setProfile] = useState<PortalCustomerProfile>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const redirect = searchParams.get("redirect");

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalMe>("/portal/me"),
      portalApiFetch<PortalCustomerProfile>("/portal/profile")
    ])
      .then(([nextMe, nextProfile]) => {
        setMe(nextMe);
        setProfile(nextProfile);
        form.setFieldsValue({
          mobile: nextProfile.mobile ?? nextMe.phone,
          name: nextProfile.name
        });
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace("/portal/login");
          return;
        }

        void message.error(error instanceof PortalApiError ? error.message : "无法加载客户信息");
      })
      .finally(() => setLoading(false));
  }, [form, message, router]);

  async function saveProfile(values: PortalProfileFormValues) {
    setSaving(true);
    try {
      const nextProfile = await portalApiFetch<PortalCustomerProfile>("/portal/profile", {
        body: JSON.stringify({
          idCardNo: values.idCardNo?.trim() || undefined,
          mobile: values.mobile,
          name: values.name
        }),
        method: "PATCH"
      });
      setProfile(nextProfile);
      form.setFieldsValue({
        idCardNo: undefined,
        mobile: nextProfile.mobile ?? values.mobile,
        name: nextProfile.name
      });
      void message.success("资料已保存");
      if (redirect && nextProfile.profileComplete) {
        router.push(redirect);
      }
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "资料保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 18px" }}>
      <section style={{ margin: "0 auto", maxWidth: 640 }}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Typography.Title level={2} style={{ margin: 0 }}>
            我的资料
          </Typography.Title>
          {loading ? (
            <Skeleton active />
          ) : (
            <>
              <Descriptions bordered column={1} size="small">
                <Descriptions.Item label="登录手机号">{me?.phone ?? "-"}</Descriptions.Item>
                <Descriptions.Item label="账号状态">
                  {CUSTOMER_ACCOUNT_STATUS_LABELS[me?.accountStatus ?? ""] ?? "-"}
                </Descriptions.Item>
                <Descriptions.Item label="身份证号">
                  {profile?.idCardNoPresent ? (
                    <Tag color="green">{profile.idCardNoMasked ?? "已保存"}</Tag>
                  ) : (
                    <Tag color="red">未填写</Tag>
                  )}
                </Descriptions.Item>
              </Descriptions>

              {profile?.profileComplete ? (
                <Alert message="实名资料已完整，可以继续提交进件。" showIcon type="success" />
              ) : (
                <Alert
                  description={<MissingProfileFields fields={profile?.missingProfileFields ?? []} />}
                  message="请先完善实名资料，才能提交进件。"
                  showIcon
                  type="warning"
                />
              )}

              <Form<PortalProfileFormValues>
                form={form}
                layout="vertical"
                onFinish={saveProfile}
              >
                <Form.Item
                  label="姓名"
                  name="name"
                  rules={[{ required: true, message: "请输入身份证上的姓名" }]}
                >
                  <Input autoComplete="name" maxLength={64} placeholder="请输入身份证上的姓名" />
                </Form.Item>
                <Form.Item
                  label="实名手机号"
                  name="mobile"
                  rules={[
                    { required: true, message: "请输入实名手机号" },
                    { pattern: /^1\d{10}$/, message: "手机号需为 11 位大陆手机号" }
                  ]}
                >
                  <Input autoComplete="tel" maxLength={11} placeholder="需与当前登录手机号一致" />
                </Form.Item>
                <Form.Item
                  label="身份证号"
                  name="idCardNo"
                  rules={[
                    () => ({
                      validator: async (_, value: string | undefined) => {
                        const normalized = value?.trim();
                        if (!normalized && profile?.idCardNoPresent) {
                          return;
                        }
                        if (!normalized) {
                          throw new Error("请输入 18 位身份证号");
                        }
                        if (!/^\d{17}[\dXx]$/.test(normalized)) {
                          throw new Error("身份证号需为 18 位，末位可为数字或 X");
                        }
                      }
                    })
                  ]}
                >
                  <Input.Password
                    autoComplete="off"
                    maxLength={18}
                    placeholder={
                      profile?.idCardNoPresent
                        ? `已保存 ${profile.idCardNoMasked ?? ""}，如需修改请重新输入`
                        : "请输入 18 位身份证号"
                    }
                  />
                </Form.Item>
                <Space wrap>
                  <Button htmlType="submit" loading={saving} type="primary">
                    保存资料
                  </Button>
                  <Button onClick={() => router.push(redirect ?? "/portal")}>
                    返回
                  </Button>
                </Space>
              </Form>
            </>
          )}
        </Space>
      </section>
    </main>
  );
}

function PortalMeLoadingShell() {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "28px 18px" }}>
      <section style={{ margin: "0 auto", maxWidth: 640 }}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Typography.Title level={2} style={{ margin: 0 }}>
            我的资料
          </Typography.Title>
          <Skeleton active />
        </Space>
      </section>
    </main>
  );
}

function MissingProfileFields({ fields }: Readonly<{ fields: PortalMissingProfileField[] }>) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <Space direction="vertical" size={2}>
      {fields.map((field) => (
        <Typography.Text key={field.key}>
          {field.label}: {field.reason === "PLACEHOLDER" ? "请填写真实信息" : "请补全或修正格式"}
        </Typography.Text>
      ))}
    </Space>
  );
}
