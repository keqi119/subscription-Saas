"use client";

import {
  ArrowLeftOutlined,
  AuditOutlined,
  DownloadOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  RENEWAL_REMINDER_STATUS_LABELS,
  SUBSCRIPTION_CHANGE_PRICING_MODE_LABELS,
  SUBSCRIPTION_CHANGE_STATUS_LABELS,
  SUBSCRIPTION_CHANGE_TYPE_LABELS
} from "../../../constants/labels";
import { ProtectedShell } from "../../../components/protected-shell";
import { canRunSubscriptionChangeAction } from "../../../lib/action-guards";
import { API_BASE_URL, apiFetch } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import {
  approveManagedOtherChange,
  approveSubscriptionChangePrice,
  cancelSubscriptionChange,
  createSubscriptionChangeQuote,
  executeManagedOtherChange,
  generateSubscriptionChangeContract,
  getSubscriptionChange,
  getSubscriptionChangeTimeline,
  listSubscriptionChangeESignTasks,
  publishSubscriptionChangeQuote,
  retryRenewalReminder,
  retrySubscriptionChangeJob,
  startSubscriptionChangeESign,
  takeOverSubscriptionChange,
  type AdminContractESignTask,
  type AdminEarlyTerminationChangeDetail,
  type AdminExtensionChangeDetail,
  type AdminManagedOtherChangeDetail,
  type AdminRenewalReminder,
  type AdminSubscriptionChange,
  type AdminSubscriptionChangeTimelineItem,
  type AdminVehicleSwapChangeDetail
} from "../../../lib/subscription-change-api";
import {
  formatSubscriptionChangeMoney,
  getLatestFailedSubscriptionChangeJob,
  getSubscriptionChangeContractDates,
  getSubscriptionChangeNextAction,
  getSubscriptionChangePriceApproval
} from "../../../lib/subscription-change-view-model";

interface QuoteFormValues {
  discountedMonthlyFeeAmount?: string;
  requestedVehicleBaseFeeAmount?: string;
  subscriptionPlanId?: string;
}

interface ReasonFormValues {
  approvalReference?: string;
  executionNote?: string;
  reason?: string;
  supplementContractId?: string;
}

type ReasonAction =
  | "APPROVE_PRICE"
  | "APPROVE_MANAGED_OTHER"
  | "CANCEL"
  | "EXECUTE_MANAGED_OTHER"
  | "MANUAL";

export default function SubscriptionChangeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [quoteForm] = Form.useForm<QuoteFormValues>();
  const [reasonForm] = Form.useForm<ReasonFormValues>();
  const [change, setChange] = useState<AdminSubscriptionChange | null>(null);
  const [esignTasks, setEsignTasks] = useState<AdminContractESignTask[]>([]);
  const [timeline, setTimeline] = useState<AdminSubscriptionChangeTimelineItem[]>([]);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const changePromise = getSubscriptionChange(params.id);
      const timelinePromise = getSubscriptionChangeTimeline(params.id);
      const profilePromise = apiFetch<AuthMeResponse>("/auth/me");
      const nextChange = await changePromise;
      const esignTasksPromise = nextChange.contract
        ? listSubscriptionChangeESignTasks(nextChange.contract.id).catch(() => [])
        : Promise.resolve([]);
      const [nextTimeline, profile, nextESignTasks] = await Promise.all([
        timelinePromise,
        profilePromise,
        esignTasksPromise
      ]);
      setChange(nextChange);
      setTimeline(nextTimeline);
      setMe(profile);
      setEsignTasks(nextESignTasks);
      quoteForm.setFieldsValue({
        subscriptionPlanId: nextChange.currentQuote?.subscriptionPlanId ?? undefined
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "合同变更详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [params.id, quoteForm]);

  useEffect(() => {
    void load();
  }, [load]);

  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me?.user.permissions]);
  const nextAction = change ? getSubscriptionChangeNextAction(change) : null;
  const availability = nextAction
    ? canRunSubscriptionChangeAction(nextAction.kind, permissions)
    : { allowed: false, reason: "数据加载完成后才可操作" };

  async function runAction() {
    if (!change || !nextAction || !nextAction.enabled || !availability.allowed) return;
    setSubmitting(true);
    try {
      switch (nextAction.kind) {
        case "QUOTE": {
          const values = await quoteForm.validateFields();
          await createSubscriptionChangeQuote(change.id, {
            discountedMonthlyFeeAmount: values.discountedMonthlyFeeAmount?.trim() || undefined,
            requestedVehicleBaseFeeAmount:
              values.requestedVehicleBaseFeeAmount?.trim() || undefined,
            subscriptionPlanId: values.subscriptionPlanId?.trim() || undefined,
            version: change.version
          });
          break;
        }
        case "APPROVE_PRICE":
          setReasonAction("APPROVE_PRICE");
          return;
        case "APPROVE_MANAGED_OTHER":
          setReasonAction("APPROVE_MANAGED_OTHER");
          return;
        case "EXECUTE_MANAGED_OTHER":
          setReasonAction("EXECUTE_MANAGED_OTHER");
          return;
        case "WAIT_CUSTOMER":
          await publishSubscriptionChangeQuote(change.id, change.version);
          break;
        case "GENERATE_CONTRACT":
          await generateSubscriptionChangeContract(change.id, change.version);
          break;
        case "START_ESIGN":
          if (!change.contract) throw new Error("补充协议尚未生成");
          await startSubscriptionChangeESign(
            change.id,
            change.version,
            esignTasks.some((task) => task.taskStatus === "FAILED")
          );
          break;
        case "RETRY": {
          const failedJob = getLatestFailedSubscriptionChangeJob(change);
          if (!failedJob) throw new Error("没有可安全重试的失败任务");
          await retrySubscriptionChangeJob(change.id, failedJob.id, change.version);
          break;
        }
        default:
          return;
      }
      void message.success("操作已提交");
      await load();
    } catch (actionError) {
      void message.error(actionError instanceof Error ? actionError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReason() {
    if (!change || !reasonAction) return;
    const values = await reasonForm.validateFields();
    const reason = values.reason?.trim() ?? "";
    setSubmitting(true);
    try {
      if (reasonAction === "APPROVE_PRICE") {
        await approveSubscriptionChangePrice(change.id, change.version, reason);
      } else if (reasonAction === "APPROVE_MANAGED_OTHER") {
        await approveManagedOtherChange(change.id, {
          approvalReason: reason,
          approvalReference: values.approvalReference?.trim() ?? "",
          supplementContractId: values.supplementContractId?.trim() || undefined,
          version: change.version
        });
      } else if (reasonAction === "EXECUTE_MANAGED_OTHER") {
        await executeManagedOtherChange(change.id, {
          executionNote: values.executionNote?.trim() ?? "",
          version: change.version
        });
      } else if (reasonAction === "MANUAL") {
        await takeOverSubscriptionChange(change.id, change.version, reason);
      } else {
        await cancelSubscriptionChange(change.id, change.version, reason);
      }
      setReasonAction(null);
      reasonForm.resetFields();
      void message.success("操作已提交");
      await load();
    } catch (actionError) {
      void message.error(actionError instanceof Error ? actionError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryReminder(reminder: AdminRenewalReminder) {
    const considerationId = change?.renewalConsideration?.id;
    if (!considerationId) return;
    setSubmitting(true);
    try {
      await retryRenewalReminder(considerationId, reminder.slot);
      void message.success("提醒重试已提交");
      await load();
    } catch (actionError) {
      void message.error(actionError instanceof Error ? actionError.message : "提醒重试失败");
    } finally {
      setSubmitting(false);
    }
  }

  const canManual = Boolean(change?.allowedActions?.includes("MANUAL_TAKEOVER"));
  const canCancel = Boolean(change?.allowedActions?.includes("CANCEL"));
  const managedOperation =
    change?.changeType === "MANAGED_OTHER"
      ? managedOperationName(
          (change.detail as AdminManagedOtherChangeDetail | undefined)
            ?.approvedOperationSnapshot
        )
      : null;
  const managedSupplementRequired =
    managedOperation === "RECORD_CONTRACT_CLARIFICATION" ||
    managedOperation === "RECORD_SERVICE_ACCOMMODATION";

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Card
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
                刷新
              </Button>
              <Button
                icon={<ArrowLeftOutlined />}
                onClick={() => router.push("/subscription-changes")}
              >
                返回列表
              </Button>
            </Space>
          }
          title={
            change
              ? `${change.changeNo} · ${SUBSCRIPTION_CHANGE_TYPE_LABELS[change.changeType]}`
              : "合同变更详情"
          }
        >
          {error ? (
            <Alert
              action={<Button onClick={() => void load()}>重试加载</Button>}
              message={error}
              showIcon
              type="error"
            />
          ) : loading && !change ? (
            <div style={{ padding: 48, textAlign: "center" }}>
              <Spin />
            </div>
          ) : change ? (
            <ChangeOverview change={change} />
          ) : null}
        </Card>

        {change && nextAction ? (
          <Card title="下一步动作">
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              <Alert
                description={nextAction.reason ?? availability.reason}
                message={nextAction.label}
                showIcon
                type={
                  nextAction.kind === "MANUAL" || nextAction.kind === "RETRY" ? "warning" : "info"
                }
              />
              {nextAction.kind === "QUOTE" ? (
                <Form<QuoteFormValues> form={quoteForm} layout="vertical">
                  <Form.Item
                    label="订阅套餐 ID"
                    name="subscriptionPlanId"
                    rules={
                      change.pricingMode === "CURRENT_VERSION" ||
                      change.pricingMode === "APPROVED_DISCOUNT"
                        ? [{ required: true, message: "请选择当前有效订阅套餐" }]
                        : undefined
                    }
                  >
                    <Input placeholder="当前有效套餐 UUID" />
                  </Form.Item>
                  {change.pricingMode === "APPROVED_DISCOUNT" ? (
                    <Form.Item
                      label="折后月费（分）"
                      name="discountedMonthlyFeeAmount"
                      rules={[{ required: true }]}
                    >
                      <Input inputMode="numeric" />
                    </Form.Item>
                  ) : null}
                  {change.pricingMode === "CURRENT_VERSION" ? (
                    <Form.Item
                      label="申请车辆基础月费（分，可选）"
                      name="requestedVehicleBaseFeeAmount"
                    >
                      <Input inputMode="numeric" />
                    </Form.Item>
                  ) : null}
                </Form>
              ) : null}
              <Space wrap>
                {nextAction.enabled ? (
                  <Button
                    disabled={!availability.allowed}
                    loading={submitting}
                    onClick={() => void runAction()}
                    title={availability.reason}
                    type="primary"
                  >
                    {nextAction.label}
                  </Button>
                ) : null}
                {canManual ? (
                  <Button icon={<AuditOutlined />} onClick={() => setReasonAction("MANUAL")}>
                    人工接管
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button danger onClick={() => setReasonAction("CANCEL")}>
                    取消变更
                  </Button>
                ) : null}
              </Space>
            </Space>
          </Card>
        ) : null}

        {change ? (
          <>
            {change.changeType === "EXTENSION" ? <PriceApprovalCard change={change} /> : null}
            <ContractCard change={change} esignTasks={esignTasks} />
            {change.changeType === "EXTENSION" ? (
              <ReminderCard
                canRetry={permissions.has("notification:manage")}
                onRetry={retryReminder}
                reminders={change.renewalConsideration?.reminders ?? []}
                retrying={submitting}
              />
            ) : null}
            <AutomationJobCard change={change} />
            <Card title="审计时间线">
              <Timeline
                items={timeline.map((item) => ({
                  children: `${item.action} · ${item.entityType} · ${formatDateTime(item.createdAt)}`
                }))}
              />
            </Card>
          </>
        ) : null}
      </Space>

      <Modal
        confirmLoading={submitting}
        destroyOnHidden
        okText="确认提交"
        onCancel={() => setReasonAction(null)}
        onOk={() => void submitReason()}
        open={reasonAction !== null}
        title={
          reasonAction === "APPROVE_PRICE"
            ? "审批价格例外"
            : reasonAction === "APPROVE_MANAGED_OTHER"
              ? "审批其他合同变更"
              : reasonAction === "EXECUTE_MANAGED_OTHER"
                ? "记录其他合同变更结果"
            : reasonAction === "MANUAL"
              ? "人工接管"
              : "取消合同变更"
        }
      >
        <Form form={reasonForm} layout="vertical">
          {reasonAction === "EXECUTE_MANAGED_OTHER" ? (
            <Form.Item
              label="执行结果说明"
              name="executionNote"
              rules={[{ required: true, message: "请填写执行结果说明" }]}
            >
              <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={2_000} />
            </Form.Item>
          ) : (
            <Form.Item
              label="原因"
              name="reason"
              rules={[{ required: true, message: "请填写原因" }]}
            >
              <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={2_000} />
            </Form.Item>
          )}
          {reasonAction === "APPROVE_MANAGED_OTHER" ? (
            <>
              <Form.Item
                label="审批依据编号"
                name="approvalReference"
                rules={[{ required: true, message: "请填写审批依据编号" }]}
              >
                <Input maxLength={255} />
              </Form.Item>
              <Form.Item
                extra="涉及合同权利义务调整时必须填写已签署、已归档的补充协议合同 ID。"
                label="已归档补充协议合同 ID"
                name="supplementContractId"
                rules={
                  managedSupplementRequired
                    ? [{ required: true, message: "该操作必须填写已归档补充协议合同 ID" }]
                    : undefined
                }
              >
                <Input maxLength={64} />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

export function ChangeOverview({ change }: { change: AdminSubscriptionChange }) {
  const items = subscriptionChangeOverviewItems(change);
  return (
    <Descriptions
      bordered
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={items}
      size="small"
    />
  );
}

function subscriptionChangeOverviewItems(change: AdminSubscriptionChange) {
  const common = [
    {
      label: "订单",
      children: <Link href={`/orders/${change.orderId}?tab=change`}>{change.order.orderNo}</Link>
    },
    { label: "变更类型", children: SUBSCRIPTION_CHANGE_TYPE_LABELS[change.changeType] },
    {
      label: "状态",
      children: (
        <Tag color={change.status === "COMPLETED" ? "green" : "blue"}>
          {SUBSCRIPTION_CHANGE_STATUS_LABELS[change.status] ?? change.status}
        </Tag>
      )
    },
    { label: "完成期限", children: formatDateTime(change.completionDeadlineAt) },
    { label: "版本", children: `V${change.version}` },
    {
      label: "后台开放动作",
      children: change.allowedActions?.length ? change.allowedActions.join(" / ") : "无"
    }
  ];

  if (change.changeType === "EXTENSION") {
    const detail = change.detail as AdminExtensionChangeDetail | undefined;
    const dates = getSubscriptionChangeContractDates(change);
    return [
      ...common,
      {
        label: "计价方式",
        children:
          SUBSCRIPTION_CHANGE_PRICING_MODE_LABELS[detail?.pricingMode ?? change.pricingMode ?? ""] ??
          detail?.pricingMode ??
          change.pricingMode ??
          "-"
      },
      { label: "原合同到期日", children: formatDate(dates.originalEndDate) },
      { label: "拟续期至", children: formatDate(detail?.targetEndDate ?? dates.proposedEndDate) },
      { label: "已签约至", children: formatDate(dates.contractedThrough) },
      {
        label: "续期月数",
        children: `${detail?.extensionMonths ?? change.extensionMonths ?? "-"} 个月`
      }
    ];
  }

  if (change.changeType === "VEHICLE_SWAP") {
    const detail = change.detail as AdminVehicleSwapChangeDetail | undefined;
    return [
      ...common,
      { label: "原车辆 ID", children: detail?.sourceVehicleId ?? "-" },
      { label: "目标车辆 ID", children: detail?.targetVehicleId ?? "-" },
      { label: "目标套餐 ID", children: detail?.targetSubscriptionPlanId ?? "-" },
      { label: "计划换车时间", children: formatDateTime(detail?.plannedSwapAt) },
      { label: "实际换车时间", children: formatDateTime(detail?.actualSwapAt) },
      { label: "交回工单 ID", children: detail?.inboundWorkOrderId ?? "待创建" },
      { label: "交付工单 ID", children: detail?.outboundWorkOrderId ?? "待创建" },
      { label: "商业快照哈希", children: detail?.commercialSnapshotHash ?? "待报价" }
    ];
  }

  if (change.changeType === "EARLY_TERMINATION") {
    const detail = change.detail as AdminEarlyTerminationChangeDetail | undefined;
    return [
      ...common,
      { label: "计划生效日", children: formatDate(detail?.effectiveDate) },
      { label: "结算试算 revision", children: detail?.estimatedSettlementRevision ?? "待试算" },
      {
        label: "退车 / 结算闭环",
        children: detail?.closureCaseId ? (
          <Link href={`/orders/${change.orderId}?tab=overview`}>
            Closure {detail.closureCaseId}
          </Link>
        ) : (
          "待创建"
        )
      },
      { label: "提前结束协议 ID", children: detail?.agreementContractId ?? "待生成" }
    ];
  }

  const detail = change.detail as AdminManagedOtherChangeDetail | undefined;
  return [
    ...common,
    {
      label: "受控操作",
      children: managedOperationName(detail?.approvedOperationSnapshot) ?? "-"
    },
    { label: "生效日", children: formatDate(detail?.effectiveDate) },
    { label: "补充协议合同 ID", children: detail?.supplementContractId ?? "不适用 / 待提供" },
    { label: "变更前事实", children: <SnapshotValue value={detail?.beforeSnapshot} /> },
    { label: "批准后事实", children: <SnapshotValue value={detail?.afterSnapshot} /> },
    { label: "证据快照", children: <SnapshotValue value={detail?.evidenceSnapshot} /> }
  ];
}

function SnapshotValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return "-";
  return (
    <Typography.Text code style={{ whiteSpace: "pre-wrap" }}>
      {JSON.stringify(value, null, 2)}
    </Typography.Text>
  );
}

function managedOperationName(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const request =
    snapshot.request &&
    typeof snapshot.request === "object" &&
    !Array.isArray(snapshot.request)
      ? (snapshot.request as Record<string, unknown>)
      : null;
  const operation = snapshot.operation ?? request?.operation;
  return typeof operation === "string" ? operation : null;
}

function PriceApprovalCard({ change }: { change: AdminSubscriptionChange }) {
  const approval = getSubscriptionChangePriceApproval(change);
  return (
    <Card title="报价与价格审批">
      {approval ? (
        <Descriptions
          bordered
          column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
          items={[
            { label: "当前报价", children: change.currentQuote?.quoteNo ?? "-" },
            {
              label: "报价 revision",
              children: change.currentQuote ? `V${change.currentQuote.revision}` : "-"
            },
            { label: "报价有效期", children: formatDateTime(change.currentQuote?.validUntil) },
            {
              label: "基准月费",
              children: formatSubscriptionChangeMoney(approval.baselineMonthlyFeeAmount)
            },
            {
              label: "拟议月费",
              children: formatSubscriptionChangeMoney(approval.proposedMonthlyFeeAmount)
            },
            { label: "差额", children: formatSubscriptionChangeMoney(approval.differenceAmount) },
            { label: "例外原因", children: approval.reason ?? "-" },
            { label: "报价提交人", children: approval.createdBy ?? "-" },
            { label: "审批人", children: approval.approvedBy ?? "待审批" }
          ]}
          size="small"
        />
      ) : (
        <Typography.Text type="secondary">尚未生成正式报价</Typography.Text>
      )}
    </Card>
  );
}

function ContractCard({
  change,
  esignTasks
}: {
  change: AdminSubscriptionChange;
  esignTasks: AdminContractESignTask[];
}) {
  const contract = change.contract;
  return (
    <Card title="补充协议与电子签">
      {contract ? (
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Descriptions
            bordered
            column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
            items={[
              {
                label: "合同编号",
                children: <Link href={`/contracts/${contract.id}`}>{contract.contractNo}</Link>
              },
              { label: "合同状态", children: contract.status },
              { label: "归档时间", children: formatDateTime(contract.archivedAt) }
            ]}
            size="small"
          />
          <Space wrap>
            <Button href={`/contracts/${contract.id}`}>查看合同详情</Button>
            <Button
              href={`${API_BASE_URL}/contracts/${encodeURIComponent(contract.id)}/generated-pdf/preview`}
              icon={<DownloadOutlined />}
              rel="noreferrer"
              target="_blank"
            >
              预览 / 下载 PDF
            </Button>
          </Space>
          <Table
            columns={[
              { dataIndex: "taskNo", title: "电子签任务" },
              {
                dataIndex: "taskStatus",
                render: (value: string) => <Tag>{value}</Tag>,
                title: "状态"
              },
              { dataIndex: "failedAt", render: formatDateTime, title: "失败时间" },
              { dataIndex: "completedAt", render: formatDateTime, title: "完成时间" }
            ]}
            dataSource={esignTasks}
            pagination={false}
            rowKey="id"
            size="small"
          />
        </Space>
      ) : (
        <Typography.Text type="secondary">补充协议尚未生成</Typography.Text>
      )}
    </Card>
  );
}

function ReminderCard({
  canRetry,
  onRetry,
  reminders,
  retrying
}: {
  canRetry: boolean;
  onRetry: (reminder: AdminRenewalReminder) => void;
  reminders: AdminRenewalReminder[];
  retrying: boolean;
}) {
  const columns: ColumnsType<AdminRenewalReminder> = [
    { dataIndex: "slot", title: "提醒批次" },
    { dataIndex: "scheduledAt", render: formatDateTime, title: "计划时间" },
    {
      dataIndex: "status",
      render: (value: string) => <Tag>{RENEWAL_REMINDER_STATUS_LABELS[value] ?? value}</Tag>,
      title: "总状态"
    },
    { dataIndex: "inAppStatus", render: nullableTag, title: "站内信" },
    { dataIndex: "smsStatus", render: nullableTag, title: "短信" },
    {
      dataIndex: "errorMessage",
      render: (value?: string | null) => value ?? "-",
      title: "失败原因"
    },
    {
      key: "action",
      render: (_value, reminder) =>
        reminder.status === "FAILED" || reminder.smsStatus === "FAILED" ? (
          <Button
            disabled={!canRetry}
            loading={retrying}
            onClick={() => onRetry(reminder)}
            size="small"
            title={canRetry ? undefined : "无通知重试权限"}
          >
            重试提醒
          </Button>
        ) : (
          "-"
        ),
      title: "操作"
    }
  ];
  return (
    <Card title="提醒与渠道状态">
      <Table
        columns={columns}
        dataSource={reminders}
        locale={{ emptyText: "无关联提醒" }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 840 }}
        size="small"
      />
    </Card>
  );
}

function AutomationJobCard({ change }: { change: AdminSubscriptionChange }) {
  return (
    <Card title="自动任务与安全恢复">
      <Table
        columns={[
          { dataIndex: "jobType", title: "任务" },
          {
            dataIndex: "jobStatus",
            render: (value: string) => (
              <Tag color={value === "DEAD_LETTER" ? "red" : undefined}>{value}</Tag>
            ),
            title: "状态"
          },
          { dataIndex: "attemptCount", title: "尝试次数" },
          {
            dataIndex: "lastErrorMessage",
            render: (value?: string | null) => value ?? "-",
            title: "最近错误"
          }
        ]}
        dataSource={change.automationJobs}
        locale={{ emptyText: "暂无自动任务" }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 760 }}
        size="small"
      />
      {change.failureMessage ? (
        <Alert message={change.failureMessage} showIcon style={{ marginTop: 12 }} type="error" />
      ) : null}
      {change.manualTakeoverReason ? (
        <Alert
          message={`人工接管：${change.manualTakeoverReason}`}
          showIcon
          style={{ marginTop: 12 }}
          type="warning"
        />
      ) : null}
    </Card>
  );
}

function nullableTag(value?: string | null) {
  return value ? (
    <Tag color={value === "FAILED" || value === "CONFIG_MISSING" ? "red" : undefined}>{value}</Tag>
  ) : (
    "-"
  );
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
