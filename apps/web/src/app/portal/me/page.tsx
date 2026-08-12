"use client";

import {
  Alert,
  App,
  Button,
  Cascader,
  Descriptions,
  Form,
  Input,
  Skeleton,
  Space,
  Tag,
  Typography
} from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { PortalProfileTabs } from "../../../components/portal/portal-profile-tabs";
import { CUSTOMER_ACCOUNT_STATUS_LABELS } from "../../../constants/labels";
import { CHINA_REGION_OPTIONS } from "../../../lib/china-region-options";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  type PortalProfileFormValues,
  toPortalProfileFormValues,
  toPortalProfileUpdatePayload
} from "../../../lib/portal-profile-form";
import {
  buildPortalProfileHref,
  normalizePortalRedirect
} from "../../../lib/portal-profile-navigation";
import type { PortalCustomerProfile, PortalMissingProfileField } from "../../../lib/portal-types";

interface PortalMe {
  accountStatus: string;
  customerAccountId: string;
  customerId: string;
  phone: string;
}

const PROFILE_FIELD_LABELS: Record<PortalMissingProfileField["key"], string> = {
  emergencyContactMobile: "紧急联系人手机号",
  emergencyContactName: "紧急联系人姓名",
  idCardNo: "身份证号",
  mobile: "登录手机号",
  name: "姓名",
  residenceCity: "居住城市",
  residenceDetail: "详细地址",
  residenceDistrict: "居住区县",
  residenceProvince: "居住省份"
};

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
  const redirect = normalizePortalRedirect(searchParams.get("redirect"));

  useEffect(() => {
    Promise.all([
      portalApiFetch<PortalMe>("/portal/me"),
      portalApiFetch<PortalCustomerProfile>("/portal/profile")
    ])
      .then(([nextMe, nextProfile]) => {
        setMe(nextMe);
        setProfile(nextProfile);
        form.setFieldsValue(toPortalProfileFormValues(nextProfile));
      })
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          const profileHref = buildPortalProfileHref("basic", redirect);
          router.replace(`/portal/login?redirect=${encodeURIComponent(profileHref)}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载客户信息");
      })
      .finally(() => setLoading(false));
  }, [form, message, redirect, router]);

  async function saveProfile(values: PortalProfileFormValues) {
    setSaving(true);
    try {
      const payload = toPortalProfileUpdatePayload(values, profile?.idCardNoPresent);
      const nextProfile = await portalApiFetch<PortalCustomerProfile>("/portal/profile", {
        body: JSON.stringify(payload),
        method: "PATCH"
      });
      setProfile(nextProfile);
      form.setFieldsValue(toPortalProfileFormValues(nextProfile));
      void message.success("申请资料已保存");
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
          <PortalProfileTabs activeTab="basic" redirect={redirect} />
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
                <Alert message="进件所需资料已完整，可以继续提交申请。" showIcon type="success" />
              ) : (
                <Alert
                  description={<MissingProfileFields fields={profile?.missingProfileFields ?? []} />}
                  message="请先完善以下资料，才能提交申请。"
                  showIcon
                  type="warning"
                />
              )}

              <Form<PortalProfileFormValues> form={form} layout="vertical" onFinish={saveProfile}>
                <Form.Item
                  label="姓名"
                  name="name"
                  rules={[{ required: true, message: "请输入身份证上的姓名" }]}
                >
                  <Input autoComplete="name" maxLength={64} placeholder="请输入身份证上的姓名" />
                </Form.Item>
                <Form.Item
                  label="身份证号"
                  name="idCardNo"
                  rules={[
                    () => ({
                      validator: async (_, value: string | undefined) => {
                        const normalized = value?.trim();
                        if (!normalized && profile?.idCardNoPresent) return;
                        if (!normalized) throw new Error("请输入 18 位身份证号");
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
                <Form.Item
                  label="省 / 市 / 区县"
                  name="residenceRegion"
                  rules={[{ required: true, message: "请选择省、市和区县" }]}
                >
                  <Cascader
                    options={CHINA_REGION_OPTIONS}
                    placeholder="请选择居住地区"
                    showSearch
                  />
                </Form.Item>
                <Form.Item
                  label="详细地址"
                  name="residenceDetail"
                  rules={[{ required: true, message: "请输入小区、道路和门牌号" }]}
                >
                  <Input.TextArea
                    autoComplete="street-address"
                    maxLength={255}
                    placeholder="例如：北翟路1554弄53号"
                    rows={3}
                    showCount
                  />
                </Form.Item>
                <Form.Item
                  label="紧急联系人姓名"
                  name="emergencyContactName"
                  rules={[{ required: true, message: "请输入紧急联系人姓名" }]}
                >
                  <Input maxLength={64} placeholder="请输入紧急联系人姓名" />
                </Form.Item>
                <Form.Item
                  label="紧急联系人手机号"
                  name="emergencyContactMobile"
                  rules={[
                    { required: true, message: "请输入紧急联系人手机号" },
                    { pattern: /^1\d{10}$/, message: "手机号需为 11 位大陆手机号" },
                    () => ({
                      validator: async (_, value: string | undefined) => {
                        if (value && value === me?.phone) {
                          throw new Error("紧急联系人手机号不能与登录手机号相同");
                        }
                      }
                    })
                  ]}
                >
                  <Input autoComplete="tel" inputMode="tel" maxLength={11} />
                </Form.Item>
                <Space wrap>
                  <Button htmlType="submit" loading={saving} type="primary">
                    保存资料
                  </Button>
                  <Button onClick={() => router.push(redirect ?? "/portal")}>返回</Button>
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
  if (fields.length === 0) return null;
  return (
    <Space direction="vertical" size={2}>
      {fields.map((field) => (
        <Typography.Text key={field.key}>
          {PROFILE_FIELD_LABELS[field.key]}：
          {field.reason === "PLACEHOLDER" ? "请填写真实信息" : "请补全或修正格式"}
        </Typography.Text>
      ))}
    </Space>
  );
}
