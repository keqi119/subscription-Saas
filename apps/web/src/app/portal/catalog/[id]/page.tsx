"use client";

import { ArrowLeftOutlined, CarOutlined, FileDoneOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, Radio, Select, Space, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  PortalCatalogVehicleDetail,
  PortalSubscriptionPlan
} from "../../../../lib/portal-types";

interface CreateApplicationResponse {
  applicationId: string;
  applicationNo: string;
  status: string;
}

export default function PortalCatalogDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<PortalCatalogVehicleDetail>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [selectedPeriod, setSelectedPeriod] = useState<number>();

  useEffect(() => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    portalApiFetch<PortalCatalogVehicleDetail>(`/portal/catalog/vehicles/${params.id}`)
      .then((row) => {
        setDetail(row);
        const firstSubmitPlan = row.subscriptionPlans.find((plan) => plan.canSubmit);
        setSelectedPlanId(firstSubmitPlan?.planId);
        setSelectedPeriod(firstSubmitPlan?.subscriptionPeriodMonths);
      })
      .catch((error) => {
        void message.error(error instanceof PortalApiError ? error.message : "无法加载商品详情");
      })
      .finally(() => setLoading(false));
  }, [message, params.id]);

  const selectedPlan = useMemo(
    () => detail?.subscriptionPlans.find((plan) => plan.planId === selectedPlanId),
    [detail?.subscriptionPlans, selectedPlanId]
  );

  useEffect(() => {
    setSelectedPeriod(selectedPlan?.subscriptionPeriodMonths);
  }, [selectedPlan?.planId, selectedPlan?.subscriptionPeriodMonths]);

  async function submitApplication() {
    if (!detail || !selectedPlan || !selectedPeriod) {
      void message.error("请选择订阅套餐和周期");
      return;
    }

    try {
      setSubmitting(true);
      const result = await portalApiFetch<CreateApplicationResponse>("/portal/self-service-applications", {
        body: JSON.stringify({
          subscriptionPeriodMonths: selectedPeriod,
          subscriptionPlanId: selectedPlan.planId,
          vehicleId: detail.id
        }),
        method: "POST"
      });
      void message.success("申请已提交");
      router.push(`/portal/applications/${result.applicationId}`);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.push(`/portal/login?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "提交审核失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Flex justify="center">
          <Spin />
        </Flex>
      </main>
    );
  }

  if (!detail) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="商品不存在" />
      </main>
    );
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/catalog")} style={{ marginBottom: 16 }}>
          返回列表
        </Button>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 16,
            overflow: "hidden"
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "#eef3f8",
              color: "#246b99",
              display: "flex",
              height: 180,
              justifyContent: "center"
            }}
          >
            <CarOutlined style={{ fontSize: 48 }} />
          </div>
          <div style={{ padding: 18 }}>
            <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
              <div>
                <Typography.Title level={2} style={{ margin: 0 }}>
                  {detail.displayName}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {detail.city ?? "待确认城市"} · {detail.currentMileageKm.toLocaleString("zh-CN")} km
                </Typography.Text>
              </div>
              <Tag color="green">{detail.statusLabel}</Tag>
            </Flex>
            <Space size={[6, 6]} style={{ marginTop: 12 }} wrap>
              {detail.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Space>
          </div>
        </section>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            padding: 18
          }}
        >
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            选择订阅套餐
          </Typography.Title>
          <Alert message={detail.depositNotice} showIcon style={{ marginBottom: 16 }} type="info" />

          {detail.subscriptionPlans.length === 0 ? (
            <Empty description="暂无可选套餐" />
          ) : (
            <Radio.Group
              onChange={(event) => setSelectedPlanId(event.target.value as string)}
              style={{ width: "100%" }}
              value={selectedPlanId}
            >
              <Space direction="vertical" style={{ width: "100%" }}>
                {detail.subscriptionPlans.map((plan) => (
                  <PlanOption key={plan.planId} plan={plan} />
                ))}
              </Space>
            </Radio.Group>
          )}

          {selectedPlan ? (
            <div style={{ marginTop: 18 }}>
              <Typography.Text strong>订阅周期</Typography.Text>
              <Select
                onChange={setSelectedPeriod}
                options={selectedPlan.periodOptions.map((month) => ({
                  label: `${month} 个月`,
                  value: month
                }))}
                style={{ display: "block", marginTop: 8, maxWidth: 220 }}
                value={selectedPeriod}
              />
            </div>
          ) : null}

          <Button
            block
            disabled={!selectedPlan?.canSubmit}
            icon={<FileDoneOutlined />}
            loading={submitting}
            onClick={submitApplication}
            size="large"
            style={{ marginTop: 20 }}
            type="primary"
          >
            提交审核
          </Button>
        </section>
      </section>
    </main>
  );
}

function PlanOption({ plan }: { plan: PortalSubscriptionPlan }) {
  return (
    <div
      style={{
        border: "1px solid #e5eaf2",
        borderRadius: 8,
        padding: 14,
        width: "100%"
      }}
    >
      <Radio disabled={!plan.canSubmit} value={plan.planId}>
        <Space direction="vertical" size={4}>
          <Typography.Text strong>{plan.planName}</Typography.Text>
          <Typography.Text>{plan.monthlyFeeDescription}</Typography.Text>
          <Typography.Text type="secondary">{plan.mileageDescription}</Typography.Text>
          <Typography.Text type="secondary">{plan.energyDescription}</Typography.Text>
          <Typography.Text type="secondary">{plan.benefitDescription}</Typography.Text>
          <Space size={[6, 6]} wrap>
            {plan.packageSummary.map((item) => (
              <Tag key={item}>{item}</Tag>
            ))}
          </Space>
          {!plan.canSubmit ? <Tag color="orange">需后台确认后提交</Tag> : null}
        </Space>
      </Radio>
    </div>
  );
}

