"use client";

/* eslint-disable @next/next/no-img-element -- Listing media previews are private API streams, not optimizer-friendly public assets. */

import { ArrowLeftOutlined, CarOutlined, FileDoneOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Collapse,
  Descriptions,
  Empty,
  Flex,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography
} from "antd";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { PortalSourceDocumentImage } from "../../../../components/portal/portal-source-document-image";
import { buildPortalAssetUrl, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  PortalCatalogVehicleDetail,
  PortalCatalogVehicleMedia,
  PortalApplicationPrecheck,
  PortalSubscriptionPlan
} from "../../../../lib/portal-types";

interface CreateApplicationResponse {
  applicationId: string;
  applicationNo: string;
  materialComplete?: boolean;
  missingMaterials?: Array<{ label: string; type: string }>;
  status: string;
}

export default function PortalCatalogDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<PortalCatalogVehicleDetail>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [precheck, setPrecheck] = useState<PortalApplicationPrecheck>();
  const [precheckModalOpen, setPrecheckModalOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [selectedPeriod, setSelectedPeriod] = useState<number>();
  const [selectedMediaId, setSelectedMediaId] = useState<string>();

  useEffect(() => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    portalApiFetch<PortalCatalogVehicleDetail>(`/portal/catalog/vehicles/${params.id}`)
      .then((row) => {
        setDetail(row);
        const firstSubmitPlan = row.subscriptionPlans.find((plan) => plan.canSubmit);
        const cover = row.gallery.find((item) => item.isCover) ?? row.gallery[0];
        setSelectedPlanId(firstSubmitPlan?.planId);
        setSelectedPeriod(firstSubmitPlan?.subscriptionPeriodMonths);
        setSelectedMediaId(cover?.id);
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

  const selectedMedia = useMemo(
    () => detail?.gallery.find((item) => item.id === selectedMediaId) ?? detail?.gallery[0],
    [detail?.gallery, selectedMediaId]
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
      const precheckResult = await portalApiFetch<PortalApplicationPrecheck>(
        "/portal/self-service-applications/precheck",
        {
          body: JSON.stringify({
            subscriptionPeriodMonths: selectedPeriod,
            subscriptionPlanId: selectedPlan.planId,
            vehicleId: detail.id
          }),
          method: "POST"
        }
      );

      if (
        precheckResult.profileComplete === false ||
        (!precheckResult.materialComplete && precheckResult.missingMaterials.length > 0)
      ) {
        setPrecheck(precheckResult);
        setPrecheckModalOpen(true);
        return;
      }

      await createApplication();
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

  async function continueSubmitAfterPrecheck() {
    if (precheck?.profileComplete === false) {
      if (detail) {
        router.push(`/portal/me?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`);
      }
      return;
    }
    setPrecheckModalOpen(false);
    try {
      setSubmitting(true);
      await createApplication();
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401 && detail) {
        router.push(`/portal/login?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "提交审核失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function createApplication() {
    if (!detail || !selectedPlan || !selectedPeriod) {
      return;
    }

    const result = await portalApiFetch<CreateApplicationResponse>("/portal/self-service-applications", {
        body: JSON.stringify({
          subscriptionPeriodMonths: selectedPeriod,
          subscriptionPlanId: selectedPlan.planId,
          vehicleId: detail.id
        }),
        method: "POST"
      });
    void message.success(result.materialComplete === false ? "申请已提交，请尽快补充资料" : "申请已提交");
    router.push(`/portal/applications/${result.applicationId}`);
  }

  const profileBlocked = precheck?.profileComplete === false;

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
    <>
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 1120 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/catalog")} style={{ marginBottom: 16 }}>
          返回列表
        </Button>

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            marginBottom: 16
          }}
        >
          <GalleryBlock detail={detail} selectedMedia={selectedMedia} setSelectedMediaId={setSelectedMediaId} />
          <SubmitPanel
            detail={detail}
            selectedPeriod={selectedPeriod}
            selectedPlan={selectedPlan}
            selectedPlanId={selectedPlanId}
            setSelectedPeriod={setSelectedPeriod}
            setSelectedPlanId={setSelectedPlanId}
            submitApplication={submitApplication}
            submitting={submitting}
          />
        </div>

        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <InfoSection title="车辆配置与核心参数">
            <Descriptions
              bordered
              column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
              items={[
                { label: "品牌", children: detail.brand },
                { label: "车系", children: detail.series ?? "-" },
                { label: "车型", children: detail.modelDisplayName ?? detail.model ?? "-" },
                { label: "车型代码", children: detail.modelDefinition?.modelCode ?? "-" },
                { label: "年款", children: detail.modelYear ? `${detail.modelYear}款` : "-" },
                { label: "上牌日期", children: formatDate(detail.registrationDate) },
                { label: "当前里程", children: `${detail.currentMileageKm.toLocaleString("zh-CN")} km` },
                { label: "所在地", children: detail.city ?? "-" },
                { label: "电池容量", children: formatKwh(detail.battery.capacityKwh) },
                { label: "预计续航", children: detail.battery.estimatedRangeKm ? `${detail.battery.estimatedRangeKm} km` : "-" }
              ]}
              size="small"
            />
            {detail.sourceDocuments.configurationSheet ? (
              <div style={{ marginTop: 16 }}>
                <PortalSourceDocumentImage document={detail.sourceDocuments.configurationSheet} />
              </div>
            ) : null}
          </InfoSection>

          <InfoSection title="一车一况">
            <ConditionPresentation
              detail={detail}
              onOpenStructuredReport={() =>
                router.push(`/portal/catalog/${detail.id}/condition-report`)
              }
            />
          </InfoSection>

          <InfoSection title="电池与续航">
            <Descriptions
              bordered
              column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
              items={[
                { label: "电池容量", children: formatKwh(detail.battery.capacityKwh) },
                { label: "电池使用方式", children: detail.battery.usageTypeLabel },
                { label: "电池健康度", children: detail.battery.healthPercent ? `${detail.battery.healthPercent}%` : "-" },
                { label: "检测日期", children: formatDate(detail.battery.checkedAt) },
                { label: "预计续航", children: detail.battery.estimatedRangeKm ? `${detail.battery.estimatedRangeKm} km` : "-" },
                { label: "说明", children: detail.battery.remark ?? "续航受环境、路况和驾驶习惯影响。" }
              ]}
              size="small"
            />
          </InfoSection>

          <InfoSection title="订阅方案">
            {detail.subscriptionPlans.length === 0 ? (
              <Empty description="暂无可选套餐" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {detail.subscriptionPlans.map((plan) => (
                  <PlanOption key={plan.planId} plan={plan} />
                ))}
              </Space>
            )}
          </InfoSection>

          <InfoSection title="费用说明">
            <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-line" }}>
              {detail.feeDescription}
            </Typography.Paragraph>
          </InfoSection>

          <InfoSection title="服务保障">
            <Space size={[8, 8]} wrap>
              {detail.serviceHighlights.map((item) => (
                <Tag key={item} color="blue">
                  {item}
                </Tag>
              ))}
            </Space>
          </InfoSection>

          <InfoSection title="申请流程">
            <Steps
              current={0}
              items={detail.applicationProcess.map((title) => ({ title }))}
              size="small"
              style={{ overflowX: "auto" }}
            />
            <Alert message={detail.applicationNotice} showIcon style={{ marginTop: 14 }} type="info" />
          </InfoSection>

          <InfoSection title="FAQ">
            <Collapse
              bordered={false}
              items={detail.faq.map((item, index) => ({
                children: item.answer,
                key: String(index),
                label: item.question
              }))}
            />
          </InfoSection>
        </Space>
      </section>
    </main>
    <Modal
      cancelText="取消"
      okText="去补充资料"
      onCancel={() => setPrecheckModalOpen(false)}
      onOk={() => {
        if (detail) {
          router.push(`/portal/materials?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`);
        }
      }}
      open={precheckModalOpen}
      title="资料待补充"
      footer={(_, { CancelBtn }) => (
        <Flex gap={8} justify="flex-end" wrap="wrap">
          <CancelBtn />
          {profileBlocked ? null : (
          <Button onClick={() => void continueSubmitAfterPrecheck()} loading={submitting}>
            继续提交，稍后补充
          </Button>
          )}
          <Button
            type="primary"
            onClick={() => {
              if (detail) {
                router.push(
                  profileBlocked
                    ? `/portal/me?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`
                    : `/portal/materials?redirect=${encodeURIComponent(`/portal/catalog/${detail.id}`)}`
                );
              }
            }}
          >
            去补充资料
          </Button>
        </Flex>
      )}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text>
          为加快审核，建议先补充以下资料：
        </Typography.Text>
        <Space direction="vertical" size={4}>
          {(profileBlocked ? precheck?.missingProfileFields ?? [] : []).map((item) => (
            <Typography.Text key={item.key}>- {item.label}</Typography.Text>
          ))}
          {(precheck?.missingMaterials ?? []).map((item) => (
            <Typography.Text key={item.type}>- {item.label}</Typography.Text>
          ))}
        </Space>
        {profileBlocked ? (
          <Alert message="请先完成实名资料，再继续提交进件。" showIcon type="warning" />
        ) : (
        <Alert
          message="你也可以先提交审核，稍后在申请进度中补充资料。"
          showIcon
          type="warning"
        />
        )}
      </Space>
    </Modal>
    </>
  );
}

function GalleryBlock({
  detail,
  selectedMedia,
  setSelectedMediaId
}: Readonly<{
  detail: PortalCatalogVehicleDetail;
  selectedMedia?: PortalCatalogVehicleMedia;
  setSelectedMediaId: (id: string) => void;
}>) {
  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e5eaf2",
        borderRadius: 8,
        overflow: "hidden"
      }}
    >
      <div
        style={{
          alignItems: "center",
          aspectRatio: "16 / 10",
          background: "#eef3f8",
          color: "#246b99",
          display: "flex",
          justifyContent: "center",
          width: "100%"
        }}
      >
        {selectedMedia ? (
          <img
            alt={selectedMedia.caption ?? detail.displayName}
            src={buildPortalAssetUrl(selectedMedia.previewUrl)}
            style={{ height: "100%", objectFit: "cover", width: "100%" }}
          />
        ) : (
          <CarOutlined style={{ fontSize: 56 }} />
        )}
      </div>
      <div style={{ padding: 16 }}>
        <Typography.Title level={2} style={{ margin: 0 }}>
          {detail.displayName}
        </Typography.Title>
        {detail.subtitle ? <Typography.Text type="secondary">{detail.subtitle}</Typography.Text> : null}
        <Space size={[6, 6]} style={{ marginTop: 12 }} wrap>
          {detail.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </Space>
        {detail.gallery.length > 1 ? (
          <Flex gap={8} style={{ marginTop: 14, overflowX: "auto" }}>
            {detail.gallery.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedMediaId(item.id)}
                style={{
                  background: "transparent",
                  border: item.id === selectedMedia?.id ? "2px solid #1677ff" : "1px solid #d9e2ef",
                  borderRadius: 8,
                  cursor: "pointer",
                  padding: 0
                }}
                type="button"
              >
                <img
                  alt={item.caption ?? item.category}
                  src={buildPortalAssetUrl(item.previewUrl)}
                  style={{
                    aspectRatio: "4 / 3",
                    borderRadius: 6,
                    display: "block",
                    objectFit: "cover",
                    width: 84
                  }}
                />
              </button>
            ))}
          </Flex>
        ) : null}
      </div>
    </section>
  );
}

function SubmitPanel({
  detail,
  selectedPeriod,
  selectedPlan,
  selectedPlanId,
  setSelectedPeriod,
  setSelectedPlanId,
  submitApplication,
  submitting
}: Readonly<{
  detail: PortalCatalogVehicleDetail;
  selectedPeriod?: number;
  selectedPlan?: PortalSubscriptionPlan;
  selectedPlanId?: string;
  setSelectedPeriod: (value: number) => void;
  setSelectedPlanId: (value: string) => void;
  submitApplication: () => void;
  submitting: boolean;
}>) {
  return (
    <section
      style={{
        alignSelf: "start",
        background: "#ffffff",
        border: "1px solid #e5eaf2",
        borderRadius: 8,
        padding: 18
      }}
    >
      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        <Flex align="center" justify="space-between">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {detail.shortTitle ?? detail.displayName}
          </Typography.Title>
          <Tag color="green">{detail.statusLabel}</Tag>
        </Flex>
        <Descriptions
          column={1}
          items={[
            { label: "月租起", children: detail.monthlyFeeFromAmount ? `${formatYuan(detail.monthlyFeeFromAmount)} / 月` : "审核后确认" },
            { label: "押金", children: "审核后确认" },
            { label: "可选订阅期", children: selectedPlan ? `${selectedPlan.subscriptionPeriodRange.min}-${selectedPlan.subscriptionPeriodRange.max} 个月` : "-" },
            { label: "所在地", children: detail.city ?? "-" }
          ]}
          size="small"
        />
        <Radio.Group
          onChange={(event) => setSelectedPlanId(event.target.value as string)}
          style={{ width: "100%" }}
          value={selectedPlanId}
        >
          <Space direction="vertical" style={{ width: "100%" }}>
            {detail.subscriptionPlans.map((plan) => (
              <Radio disabled={!plan.canSubmit} key={plan.planId} value={plan.planId}>
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>
                    {plan.planName}
                    {plan.recommended ? <Tag color="gold" style={{ marginLeft: 8 }}>推荐</Tag> : null}
                  </Typography.Text>
                  <Typography.Text type="secondary">{plan.monthlyFeeDescription}</Typography.Text>
                </Space>
              </Radio>
            ))}
          </Space>
        </Radio.Group>
        {selectedPlan ? (
          <Select
            onChange={setSelectedPeriod}
            options={selectedPlan.periodOptions.map((month) => ({
              label: `${month} 个月`,
              value: month
            }))}
            style={{ width: "100%" }}
            value={selectedPeriod}
          />
        ) : null}
        <Button
          block
          disabled={!selectedPlan?.canSubmit}
          icon={<FileDoneOutlined />}
          loading={submitting}
          onClick={submitApplication}
          size="large"
          type="primary"
        >
          提交审核
        </Button>
        <Typography.Text type="secondary">不是立即下单，最终费用和押金以审核方案为准。</Typography.Text>
      </Space>
    </section>
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
      <Space direction="vertical" size={6}>
        <Typography.Text strong>
          {plan.planName}
          {plan.recommended ? <Tag color="gold" style={{ marginLeft: 8 }}>推荐</Tag> : null}
        </Typography.Text>
        <Typography.Text>{plan.monthlyFeeDescription}</Typography.Text>
        <Typography.Text type="secondary">{plan.mileageDescription}</Typography.Text>
        <Typography.Text type="secondary">{plan.energyDescription}</Typography.Text>
        <Typography.Text type="secondary">{plan.benefitDescription}</Typography.Text>
        <Space size={[6, 6]} wrap>
          {plan.packageSummary.map((item) => (
            <Tag key={item}>{item}</Tag>
          ))}
        </Space>
      </Space>
    </div>
  );
}

function ConditionPresentation({
  detail,
  onOpenStructuredReport
}: Readonly<{
  detail: PortalCatalogVehicleDetail;
  onOpenStructuredReport: () => void;
}>) {
  if (
    detail.conditionDisplayMode === "SOURCE_DOCUMENT" &&
    detail.sourceDocuments.conditionReport
  ) {
    return <PortalSourceDocumentImage document={detail.sourceDocuments.conditionReport} />;
  }

  if (
    detail.conditionDisplayMode === "STRUCTURED_REPORT" &&
    detail.conditionReportSummary
  ) {
    return (
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Space size={[8, 8]} wrap>
          {detail.condition.grade ? (
            <Tag color="blue">车况 {detail.condition.grade}</Tag>
          ) : (
            <Tag>车况待确认</Tag>
          )}
          {detail.condition.hasMajorAccident === false ? <Tag color="green">未标记重大事故</Tag> : null}
          {detail.condition.hasFloodDamage === false ? <Tag color="green">未标记水泡</Tag> : null}
          {detail.condition.hasFireDamage === false ? <Tag color="green">未标记火烧</Tag> : null}
          {detail.condition.hasStructuralDamage === false ? <Tag color="green">未标记结构件损伤</Tag> : null}
        </Space>
        <Typography.Paragraph style={{ margin: 0 }}>
          {detail.condition.summary ?? detail.vehicleHistorySummary}
        </Typography.Paragraph>
        {detail.condition.knownDefectsSummary ? (
          <Alert message={detail.condition.knownDefectsSummary} showIcon type="warning" />
        ) : null}
        <Alert
          action={<Button onClick={onOpenStructuredReport} size="small" type="link">查看完整车况报告</Button>}
          description={[
            detail.conditionReportSummary.inspectionDate
              ? `检测日期：${formatDate(detail.conditionReportSummary.inspectionDate)}`
              : null,
            detail.conditionReportSummary.inspectorOrg
              ? `检测机构：${detail.conditionReportSummary.inspectorOrg}`
              : null,
            detail.conditionReportSummary.defectSummary
              ? `主要瑕疵：${detail.conditionReportSummary.defectSummary}`
              : null
          ].filter(Boolean).join(" / ")}
          message={`正式车况报告 ${detail.conditionReportSummary.reportNo}${
            detail.conditionReportSummary.overallGrade
              ? ` / 综合等级 ${detail.conditionReportSummary.overallGrade}`
              : ""
          }`}
          showIcon
          type="success"
        />
      </Space>
    );
  }

  return <Empty description="暂无可展示的车况报告" />;
}

function InfoSection({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <section
      style={{
        background: "#ffffff",
        border: "1px solid #e5eaf2",
        borderRadius: 8,
        padding: 18
      }}
    >
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </section>
  );
}

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().slice(0, 10);
}

function formatKwh(value?: number | null) {
  return value === undefined || value === null ? "-" : `${value.toLocaleString("zh-CN")} kWh`;
}

function formatYuan(amount: number) {
  return `¥${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 0
  })}`;
}
