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
  SUBSCRIPTION_CHANGE_STATUS_LABELS
} from "../../../constants/labels";
import { ProtectedShell } from "../../../components/protected-shell";
import { canRunSubscriptionChangeAction } from "../../../lib/action-guards";
import { API_BASE_URL, apiFetch } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import {
  approveSubscriptionChangePrice,
  cancelSubscriptionChange,
  createSubscriptionChangeQuote,
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
  type AdminRenewalReminder,
  type AdminSubscriptionChange,
  type AdminSubscriptionChangeTimelineItem
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

type ReasonAction = "APPROVE" | "CANCEL" | "MANUAL";

export default function SubscriptionChangeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [quoteForm] = Form.useForm<QuoteFormValues>();
  const [reasonForm] = Form.useForm<{ reason: string }>();
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
          setReasonAction("APPROVE");
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
    const { reason } = await reasonForm.validateFields();
    setSubmitting(true);
    try {
      if (reasonAction === "APPROVE") {
        await approveSubscriptionChangePrice(change.id, change.version, reason.trim());
      } else if (reasonAction === "MANUAL") {
        await takeOverSubscriptionChange(change.id, change.version, reason.trim());
      } else {
        await cancelSubscriptionChange(change.id, change.version, reason.trim());
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

  const canManual = permissions.has("subscription_change:manual_takeover");
  const canCancel = permissions.has("subscription_change:cancel");
  const cancellable = Boolean(
    change &&
    ["DRAFT", "QUOTED", "CUSTOMER_CONFIRMED", "SIGNING_OR_PAYMENT", "MANUAL_TAKEOVER"].includes(
      change.status
    )
  );

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
          title={change ? `${change.changeNo} · 协议延长` : "合同变更详情"}
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
                {change.status === "FAILED" && canManual ? (
                  <Button icon={<AuditOutlined />} onClick={() => setReasonAction("MANUAL")}>
                    人工接管
                  </Button>
                ) : null}
                {cancellable && canCancel ? (
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
            <PriceApprovalCard change={change} />
            <ContractCard change={change} esignTasks={esignTasks} />
            <ReminderCard
              canRetry={permissions.has("notification:manage")}
              onRetry={retryReminder}
              reminders={change.renewalConsideration?.reminders ?? []}
              retrying={submitting}
            />
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
          reasonAction === "APPROVE"
            ? "审批价格例外"
            : reasonAction === "MANUAL"
              ? "人工接管"
              : "取消合同变更"
        }
      >
        <Form form={reasonForm} layout="vertical">
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请填写原因" }]}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

export function ChangeOverview({ change }: { change: AdminSubscriptionChange }) {
  const dates = getSubscriptionChangeContractDates(change);
  return (
    <Descriptions
      bordered
      column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
      items={[
        {
          label: "订单",
          children: (
            <Link href={`/orders/${change.orderId}?tab=change`}>{change.order.orderNo}</Link>
          )
        },
        {
          label: "状态",
          children: (
            <Tag color={change.status === "COMPLETED" ? "green" : "blue"}>
              {SUBSCRIPTION_CHANGE_STATUS_LABELS[change.status] ?? change.status}
            </Tag>
          )
        },
        {
          label: "计价方式",
          children:
            SUBSCRIPTION_CHANGE_PRICING_MODE_LABELS[change.pricingMode] ?? change.pricingMode
        },
        { label: "原合同到期日", children: formatDate(dates.originalEndDate) },
        { label: "拟续期至", children: formatDate(dates.proposedEndDate) },
        { label: "已签约至", children: formatDate(dates.contractedThrough) },
        { label: "续期月数", children: `${change.extensionMonths} 个月` },
        { label: "完成期限", children: formatDateTime(change.completionDeadlineAt) },
        { label: "版本", children: `V${change.version}` }
      ]}
      size="small"
    />
  );
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
