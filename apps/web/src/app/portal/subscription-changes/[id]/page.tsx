"use client";

import {
  ArrowLeftOutlined,
  CheckOutlined,
  FilePdfOutlined,
  ReloadOutlined,
  StopOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SUBSCRIPTION_CHANGE_TYPE_LABELS } from "../../../../constants/labels";
import {
  confirmPortalRenewalQuote,
  getPortalSubscriptionChange,
  PortalApiError,
  rejectPortalRenewalQuote
} from "../../../../lib/portal-api";
import type {
  PortalEarlyTerminationSubscriptionChange,
  PortalRenewalQuote,
  PortalSubscriptionChange,
  PortalVehicleSwapSubscriptionChange
} from "../../../../lib/portal-types";

interface RejectFormValues {
  reason: string;
}

interface CustomerDecisionPayload {
  commercialSnapshotHash?: string;
  quoteId: string;
  revision: number;
  version: number;
}

export default function PortalSubscriptionChangeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [rejectForm] = Form.useForm<RejectFormValues>();
  const [change, setChange] = useState<PortalSubscriptionChange>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const decisionKeys = useRef(new Map<string, string>());

  const loadChange = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    setErrorMessage(undefined);
    try {
      setChange(await getPortalSubscriptionChange(params.id));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(
          `/portal/login?redirect=${encodeURIComponent(`/portal/subscription-changes/${params.id}`)}`
        );
        return;
      }
      setErrorMessage(error instanceof PortalApiError ? error.message : "无法加载合同变更");
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void loadChange();
  }, [loadChange]);

  async function confirmChange() {
    if (!change || submitting) return;
    const payload = customerDecisionPayload(change);
    if (!payload) return;
    modal.confirm({
      content: confirmationText(change),
      okText: "确认当前方案",
      onOk: async () => {
        setSubmitting(true);
        try {
          const commandIdentity = `confirm:${change.id}:${payload.quoteId}:${payload.revision}:${payload.version}`;
          const idempotencyKey = decisionKeys.current.get(commandIdentity) ?? crypto.randomUUID();
          decisionKeys.current.set(commandIdentity, idempotencyKey);
          await confirmPortalRenewalQuote(change.id, payload, idempotencyKey);
          void message.success("合同变更方案已确认");
          await loadChange();
        } catch (error) {
          if (error instanceof PortalApiError && error.status === 409) {
            void message.warning("方案已更新或状态已变化，页面将刷新最新版本");
            await loadChange();
            return;
          }
          void message.error(
            error instanceof PortalApiError ? error.message : "无法确认合同变更方案"
          );
        } finally {
          setSubmitting(false);
        }
      },
      title: `确认${changeTypeLabel(change)}`
    });
  }

  async function rejectChange() {
    if (!change || submitting) return;
    const payload = customerDecisionPayload(change);
    if (!payload) return;
    const { reason } = await rejectForm.validateFields();
    setSubmitting(true);
    try {
      const normalizedReason = reason.trim();
      const commandIdentity = `reject:${change.id}:${payload.quoteId}:${payload.revision}:${payload.version}:${normalizedReason}`;
      const idempotencyKey = decisionKeys.current.get(commandIdentity) ?? crypto.randomUUID();
      decisionKeys.current.set(commandIdentity, idempotencyKey);
      await rejectPortalRenewalQuote(
        change.id,
        { ...payload, reason: normalizedReason },
        idempotencyKey
      );
      setRejectOpen(false);
      rejectForm.resetFields();
      void message.success("已拒绝当前方案，运营将看到拒绝原因");
      await loadChange();
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 409) {
        setRejectOpen(false);
        void message.warning("方案已更新或状态已变化，页面将刷新最新版本");
        await loadChange();
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法拒绝合同变更方案");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !change) {
    return (
      <PageShell>
        <Flex justify="center" style={{ padding: 64 }}>
          <Spin />
        </Flex>
      </PageShell>
    );
  }

  if (!change) {
    return (
      <PageShell>
        <Empty description={errorMessage ?? "合同变更不存在"}>
          <Button icon={<ReloadOutlined />} onClick={() => void loadChange()}>
            重试
          </Button>
        </Empty>
      </PageShell>
    );
  }

  const decisionActionable =
    change.allowedActions.includes("CONFIRM_QUOTE") &&
    change.allowedActions.includes("REJECT_QUOTE") &&
    customerDecisionPayload(change) !== null;
  return (
    <PageShell>
      <Modal
        confirmLoading={submitting}
        okButtonProps={{ danger: true }}
        okText="确认拒绝"
        onCancel={() => setRejectOpen(false)}
        onOk={rejectChange}
        open={rejectOpen}
        title={`拒绝当前${changeTypeLabel(change)}方案`}
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item
            label="拒绝原因"
            name="reason"
            rules={[{ message: "请填写拒绝原因", required: true }]}
          >
            <Input.TextArea maxLength={2_000} rows={4} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Flex align="center" justify="space-between" style={{ marginBottom: 18 }} wrap="wrap">
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/portal/orders/${change.orderId}`)}
        >
          返回订单
        </Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadChange()}>
          刷新
        </Button>
      </Flex>

      <Card style={{ marginBottom: 14 }}>
        <Flex align="flex-start" gap={16} justify="space-between" wrap="wrap">
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>
              {changeTypeLabel(change)}进度
            </Typography.Title>
            <Typography.Text type="secondary">订单 {change.orderNo}</Typography.Text>
          </div>
          <Tag
            color={
              change.status === "COMPLETED"
                ? "green"
                : change.status === "CANCELLED"
                  ? "default"
                  : "blue"
            }
          >
            {change.status}
          </Tag>
        </Flex>
        <ChangeStatusAlert change={change} />
        {!change.featureAvailability.enabled ? (
          <Alert
            description={`当前环境已关闭此类合同变更（${change.featureAvailability.flagName}）。页面仅提供历史事实查看。`}
            message="当前变更不可操作"
            showIcon
            style={{ marginTop: 16 }}
            type="warning"
          />
        ) : null}
      </Card>

      <CustomerTermsCard change={change} />
      <CustomerQuoteCard change={change} />

      {decisionActionable ? (
        <Card style={{ marginBottom: 14 }} title="客户确认">
          <Alert
            description="确认或拒绝时将锁定页面展示的精确版本；若运营更新方案，系统会要求刷新后重新确认。"
            message="请核对上述合同变更内容"
            showIcon
            style={{ marginBottom: 14 }}
            type="info"
          />
          <Space wrap>
            <Button
              icon={<CheckOutlined />}
              loading={submitting}
              onClick={() => void confirmChange()}
              type="primary"
            >
              确认当前方案
            </Button>
            <Button danger icon={<StopOutlined />} onClick={() => setRejectOpen(true)}>
              拒绝当前方案
            </Button>
          </Space>
        </Card>
      ) : null}

      <Card title="合同变更补充协议">
        {change.contractId ? (
          <Flex align="center" gap={16} justify="space-between" wrap="wrap">
            <Space align="start">
              <FilePdfOutlined style={{ color: "#cf1322", fontSize: 26 }} />
              <div>
                <Typography.Text strong>协议已生成</Typography.Text>
                <br />
                <Typography.Text type="secondary">
                  可查看待签 PDF、电子签状态和已签文件。
                </Typography.Text>
              </div>
            </Space>
            <Button
              onClick={() => router.push(`/portal/contracts/${change.contractId}`)}
              type="primary"
            >
              查看协议 / 去签署
            </Button>
          </Flex>
        ) : (
          <Empty description="协议尚未生成" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </PageShell>
  );
}

function ChangeStatusAlert({ change }: { change: PortalSubscriptionChange }) {
  if (change.status === "CANCELLED" && change.cancelReason) {
    return (
      <Alert
        description={formatCancelReason(change.cancelReason)}
        message="当前合同变更已取消"
        showIcon
        style={{ marginTop: 16 }}
        type="warning"
      />
    );
  }
  if (change.status === "SCHEDULED" || change.status === "EXECUTING") {
    return (
      <Alert message="协议已归档，等待计划生效" showIcon style={{ marginTop: 16 }} type="success" />
    );
  }
  if (change.status === "SIGNING_OR_PAYMENT") {
    return (
      <Alert
        description="请查看协议并完成电子签署。"
        message="等待签署归档"
        showIcon
        style={{ marginTop: 16 }}
        type="warning"
      />
    );
  }
  return null;
}

function CustomerTermsCard({ change }: { change: PortalSubscriptionChange }) {
  if (isVehicleSwap(change)) {
    return (
      <Card style={{ marginBottom: 14 }} title="换车方案">
        <Descriptions
          column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
          items={[
            { label: "原车辆 ID", children: change.detail.sourceVehicle.id },
            { label: "目标车辆 ID", children: change.detail.targetVehicle.id },
            { label: "目标套餐 ID", children: change.detail.targetSubscriptionPlanId },
            { label: "计划换车时间", children: formatDateTime(change.detail.plannedSwapAt) },
            { label: "精确商业快照", children: change.detail.commercialSnapshotHash }
          ]}
          size="small"
        />
      </Card>
    );
  }

  if (isEarlyTermination(change)) {
    const estimate = recordValue(change.currentEstimate);
    const futureBillBoundary = recordValue(estimate?.futureBillBoundary);
    return (
      <Card style={{ marginBottom: 14 }} title="提前结束试算">
        <Descriptions
          column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
          items={[
            { label: "计划生效日", children: formatDate(change.effectiveDate) },
            { label: "试算 revision", children: change.estimateRevision ?? "待试算" },
            {
              label: "生效日前应收",
              children: formatMoneyValue(estimate?.accruedReceivableAmount)
            },
            {
              label: "提前结束费用",
              children: formatMoneyValue(estimate?.earlyTerminationChargeAmount)
            },
            {
              label: "押金预计抵扣",
              children: formatMoneyValue(estimate?.depositAppliedAmount)
            },
            {
              label: "预计仍需支付",
              children: formatMoneyValue(estimate?.estimatedAmountDue)
            },
            { label: "预计应退", children: formatMoneyValue(estimate?.estimatedRefundAmount) },
            {
              label: "生效日后待取消账单",
              children: formatMoneyValue(futureBillBoundary?.amount)
            },
            {
              label: "车况检查",
              children: estimate?.pendingInspection ? "最终金额待退车检查" : "-"
            }
          ]}
          size="small"
        />
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 14 }} title="续期合同期限">
      <Descriptions
        column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
        items={[
          { label: "原合同到期日", children: formatDate(change.sourceSegment.endDate) },
          { label: "续期开始日", children: formatDate(change.targetStartDate) },
          { label: "拟续期至", children: formatDate(change.targetEndDate) },
          { label: "续期月数", children: `${change.extensionMonths} 个月` },
          { label: "完成期限", children: formatDateTime(change.completionDeadlineAt) }
        ]}
        size="small"
      />
    </Card>
  );
}

function CustomerQuoteCard({ change }: { change: PortalSubscriptionChange }) {
  if (isEarlyTermination(change)) return null;
  const currentQuote = change.currentQuote;
  return (
    <Card style={{ marginBottom: 14 }} title={isVehicleSwap(change) ? "换车报价" : "续期报价"}>
      {currentQuote ? (
        <Descriptions
          column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
          items={quoteDescriptionItems(currentQuote)}
          size="small"
        />
      ) : (
        <Empty description="运营正在准备正式报价" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Card>
  );
}

function quoteDescriptionItems(quote: PortalRenewalQuote) {
  return [
    { label: "报价编号", children: quote.quoteNo },
    { label: "精确版本", children: `revision ${quote.revision}` },
    { label: "月租", children: formatMoneyValue(quote.monthlyFeeAmount) },
    { label: "押金", children: formatMoneyValue(quote.depositAmount) },
    { label: "有效期至", children: formatDateTime(quote.validUntil) },
    {
      label: "月里程额度",
      children: quote.mileageLimitKm ? `${quote.mileageLimitKm} km` : "-"
    },
    { label: "超里程单价", children: formatMoneyValue(quote.overMileageFeeAmount) },
    { label: "商业快照哈希", children: quote.commercialSnapshotHash ?? "-" }
  ];
}

function customerDecisionPayload(change: PortalSubscriptionChange): CustomerDecisionPayload | null {
  if (
    !change.allowedActions.includes("CONFIRM_QUOTE") ||
    change.status !== "QUOTED" ||
    !change.customerConfirmationPublishedAt
  )
    return null;
  if (isEarlyTermination(change)) {
    if (!change.estimateRevision) return null;
    return {
      quoteId: change.id,
      revision: change.estimateRevision,
      version: change.version
    };
  }
  const currentQuote = change.currentQuote;
  if (!currentQuote || currentQuote.status !== "FORMAL") return null;
  if (isVehicleSwap(change)) {
    const commercialSnapshotHash =
      currentQuote.commercialSnapshotHash ?? change.detail.commercialSnapshotHash;
    if (!commercialSnapshotHash) return null;
    return {
      commercialSnapshotHash,
      quoteId: currentQuote.id,
      revision: currentQuote.revision,
      version: change.version
    };
  }
  return {
    quoteId: currentQuote.id,
    revision: currentQuote.revision,
    version: change.version
  };
}

function confirmationText(change: PortalSubscriptionChange) {
  if (isEarlyTermination(change)) {
    return `您将确认提前结束试算 revision ${change.estimateRevision}，计划于 ${formatDate(change.effectiveDate)} 生效。最终金额仍以退车检查和结算为准。`;
  }
  const quote = change.currentQuote;
  if (!quote) return "请确认当前合同变更方案。";
  return `您将确认报价 ${quote.quoteNo}（revision ${quote.revision}），月租 ${formatMoneyValue(quote.monthlyFeeAmount)}。`;
}

function changeTypeLabel(change: PortalSubscriptionChange) {
  return SUBSCRIPTION_CHANGE_TYPE_LABELS[change.changeType ?? "EXTENSION"];
}

function isVehicleSwap(
  change: PortalSubscriptionChange
): change is PortalVehicleSwapSubscriptionChange {
  return change.changeType === "VEHICLE_SWAP";
}

function isEarlyTermination(
  change: PortalSubscriptionChange
): change is PortalEarlyTerminationSubscriptionChange {
  return change.changeType === "EARLY_TERMINATION";
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 920 }}>{children}</section>
    </main>
  );
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatMoneyValue(value: unknown) {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    return "-";
  }
  const cents = BigInt(value);
  return `¥${(cents / 100n).toLocaleString("zh-CN")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatCancelReason(value: string) {
  const prefix = "CUSTOMER_QUOTE_REJECTED:";
  return value.startsWith(prefix) ? `拒绝原因：${value.slice(prefix.length).trim()}` : value;
}
