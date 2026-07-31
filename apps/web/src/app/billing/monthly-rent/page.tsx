"use client";

import {
  CheckCircleOutlined,
  FileSearchOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SyncOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import { actionAvailability } from "../../../lib/action-guards";
import { apiFetch, ApiError } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import {
  automationErrorText,
  formatAutomationDate,
  jobStatusView,
  jobTypeLabel,
  scheduleStatusView
} from "../../../lib/billing-automation-view-model";

interface AutomationSummary {
  jobs: Record<string, number>;
  nextSchedule: {
    nextGenerateAt: string;
    nextPeriodEnd: string;
    nextPeriodStart: string;
    orderId: string;
  } | null;
  oldestPendingJob: {
    availableAt: string;
    id: string;
  } | null;
  schedules: Record<string, number>;
}

interface BillingScheduleItem {
  customerName: string | null;
  id: string;
  lastGeneratedAt: string | null;
  lastGeneratedBillId: string | null;
  lastGeneratedBillNo: string | null;
  nextCycleNo: number;
  nextGenerateAt: string;
  nextPeriodEnd: string;
  nextPeriodStart: string;
  orderId: string;
  orderNo: string | null;
  pauseReason: string | null;
  status: string;
}

interface BillingJobItem {
  attemptCount: number;
  availableAt: string;
  billId: string | null;
  billNo: string | null;
  id: string;
  jobStatus: string;
  jobType: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  maxAttempts: number;
  orderId: string | null;
  orderNo: string | null;
}

interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface ReconcileResult {
  createdCount: number;
  dryRun: boolean;
  eligibleCount: number;
  existingCount: number;
  items: ReconcileItem[];
}

interface ReconcileItem {
  action: "EXISTING" | "CREATED" | "WOULD_CREATE";
  amountSource: string;
  baselineReason: string;
  basisBillId: string | null;
  basisPeriodStart: string | null;
  monthlyRentAmount: number | null;
  nextCycleNo: number;
  nextGenerateAt: string;
  nextPeriodEnd: string;
  nextPeriodStart: string;
  orderId: string;
  orderNo: string;
  scheduleId: string | null;
}

interface MonthlyRentBatchFormValues {
  billingDate?: Dayjs;
  dryRun?: boolean;
}

interface MonthlyRentBatchItem {
  action: string;
  amount?: number | null;
  billId?: string | null;
  error?: string | null;
  orderId: string;
  orderNo: string;
  periodEnd?: string | null;
  periodStart?: string | null;
  reason?: string | null;
}

interface MonthlyRentBatchResult {
  dryRun: boolean;
  failedCount: number;
  generatedCount: number;
  items: MonthlyRentBatchItem[];
  skippedCount: number;
}

const actionLabels: Record<string, string> = {
  DRY_RUN_FAILED: "试算失败",
  DRY_RUN_GENERATE: "试算可生成",
  DRY_RUN_SKIP: "试算跳过",
  FAILED: "生成失败",
  GENERATED: "已生成",
  SKIPPED_EXISTING: "已有账单",
  SKIPPED_NOT_DUE: "未到生成日期"
};

const actionColors: Record<string, string> = {
  DRY_RUN_FAILED: "red",
  DRY_RUN_GENERATE: "blue",
  DRY_RUN_SKIP: "default",
  FAILED: "red",
  GENERATED: "green",
  SKIPPED_EXISTING: "default",
  SKIPPED_NOT_DUE: "default"
};

export default function MonthlyRentAutomationPage() {
  const { message, modal } = App.useApp();
  const [manualForm] = Form.useForm<MonthlyRentBatchFormValues>();
  const [pauseForm] = Form.useForm<{ reason: string }>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [summary, setSummary] = useState<AutomationSummary | null>(null);
  const [schedules, setSchedules] = useState<BillingScheduleItem[]>([]);
  const [jobs, setJobs] = useState<BillingJobItem[]>([]);
  const [schedulePage, setSchedulePage] = useState({
    current: 1,
    pageSize: 10,
    total: 0
  });
  const [jobPage, setJobPage] = useState({
    current: 1,
    pageSize: 10,
    total: 0
  });
  const [showJobHistory, setShowJobHistory] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);
  const [pauseTarget, setPauseTarget] = useState<BillingScheduleItem | null>(null);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualResult, setManualResult] = useState<MonthlyRentBatchResult | null>(null);

  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("billing:view") || permissions.has("billing:generate");
  const generateAvailability = actionAvailability({
    allowed: canView,
    disabledReason: "当前账号无账单自动化操作权限",
    noPermissionReason: "当前账号无账单自动化操作权限",
    permission: "billing:generate",
    permissions
  });

  const loadAutomation = useCallback(async () => {
    setAutomationLoading(true);
    try {
      const [nextSummary, scheduleResult, jobResult] = await Promise.all([
        apiFetch<AutomationSummary>("/billing/automation/summary"),
        apiFetch<PageResult<BillingScheduleItem>>(
          `/billing/automation/schedules?page=${schedulePage.current}&pageSize=${schedulePage.pageSize}`
        ),
        apiFetch<PageResult<BillingJobItem>>(
          `/billing/automation/jobs?page=${jobPage.current}&pageSize=${jobPage.pageSize}${
            showJobHistory ? "" : "&actionableOnly=true"
          }`
        )
      ]);
      setSummary(nextSummary);
      setSchedules(scheduleResult.items);
      setJobs(jobResult.items);
      setSchedulePage((current) => ({
        ...current,
        current: scheduleResult.page,
        pageSize: scheduleResult.pageSize,
        total: scheduleResult.total
      }));
      setJobPage((current) => ({
        ...current,
        current: jobResult.page,
        pageSize: jobResult.pageSize,
        total: jobResult.total
      }));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setAutomationLoading(false);
    }
  }, [
    jobPage.current,
    jobPage.pageSize,
    message,
    schedulePage.current,
    schedulePage.pageSize,
    showJobHistory
  ]);

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => {
        void message.error(getErrorMessage(error));
      })
      .finally(() => setLoadingMe(false));
  }, [message]);

  useEffect(() => {
    if (!loadingMe && canView) {
      void loadAutomation();
    }
  }, [canView, loadAutomation, loadingMe]);

  async function reconcile(dryRun: boolean) {
    const key = dryRun ? "reconcile-preview" : "reconcile-apply";
    setActionLoading(key);
    try {
      const result = await apiFetch<ReconcileResult>("/billing/automation/reconcile", {
        body: JSON.stringify({ dryRun }),
        method: "POST"
      });
      setReconcileResult(result);
      void message.success(dryRun ? "协调预览完成" : "账单计划协调完成");
      if (!dryRun) {
        await loadAutomation();
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setActionLoading(null);
    }
  }

  function confirmReconcile() {
    modal.confirm({
      cancelText: "取消",
      content: "系统将为满足条件、但尚无账单计划的在租订单初始化计划。已有计划不会被覆盖。",
      okText: "确认执行",
      onOk: () => reconcile(false),
      title: "执行账单计划协调"
    });
  }

  async function submitPause() {
    if (!pauseTarget) {
      return;
    }
    const values = await pauseForm.validateFields();
    setActionLoading(`pause:${pauseTarget.id}`);
    try {
      await apiFetch(`/billing/automation/schedules/${pauseTarget.id}/pause`, {
        body: JSON.stringify(values),
        method: "POST"
      });
      setPauseTarget(null);
      pauseForm.resetFields();
      void message.success("账单计划已暂停");
      await loadAutomation();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setActionLoading(null);
    }
  }

  function confirmResume(schedule: BillingScheduleItem) {
    modal.confirm({
      cancelText: "取消",
      content: "恢复后，系统会继续执行该订单尚未完成的权威账期计划。",
      okText: "确认恢复",
      onOk: async () => {
        setActionLoading(`resume:${schedule.id}`);
        try {
          await apiFetch(`/billing/automation/schedules/${schedule.id}/resume`, { method: "POST" });
          void message.success("账单计划已恢复");
          await loadAutomation();
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setActionLoading(null);
        }
      },
      title: "恢复账单计划"
    });
  }

  function confirmRetry(job: BillingJobItem) {
    modal.confirm({
      cancelText: "取消",
      content: "请确认确定性配置错误已经修复。重试会复用原任务及幂等键，不会创建新的业务事实。",
      okText: "确认重试",
      onOk: async () => {
        setActionLoading(`retry:${job.id}`);
        try {
          await apiFetch(`/billing/automation/jobs/${job.id}/retry`, {
            method: "POST"
          });
          void message.success("任务已恢复为待执行");
          await loadAutomation();
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setActionLoading(null);
        }
      },
      title: "重试死信任务"
    });
  }

  async function submitManual(values: MonthlyRentBatchFormValues, dryRun: boolean) {
    if (!values.billingDate) {
      void message.error("请选择账单生成日期");
      return;
    }
    setManualSubmitting(true);
    try {
      const result = await apiFetch<MonthlyRentBatchResult>("/billing/monthly-rent/generate", {
        body: JSON.stringify({
          billingDate: values.billingDate.format("YYYY-MM-DD"),
          dryRun
        }),
        method: "POST"
      });
      setManualResult(result);
      manualForm.setFieldsValue({ dryRun });
      void message.success(dryRun ? "人工批量试算完成" : "人工月租账单生成完成");
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setManualSubmitting(false);
    }
  }

  const reconcileColumns: ColumnsType<ReconcileItem> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => (
        <Link href={`/orders/${record.orderId}`}>{value}</Link>
      ),
      title: "订单",
      width: 170
    },
    {
      dataIndex: "action",
      render: (value: ReconcileItem["action"]) =>
        ({
          CREATED: "已创建",
          EXISTING: "已有计划",
          WOULD_CREATE: "预计创建"
        })[value],
      title: "协调结果",
      width: 100
    },
    {
      render: (_, record) =>
        `${formatDate(record.nextPeriodStart)} 至 ${formatDate(record.nextPeriodEnd)}`,
      title: "下一账期",
      width: 210
    },
    {
      dataIndex: "nextGenerateAt",
      render: formatAutomationDate,
      title: "计划生成时间",
      width: 170
    },
    {
      render: (_, record) =>
        record.monthlyRentAmount === null
          ? "缺少月租金额"
          : `¥${(record.monthlyRentAmount / 100).toFixed(2)}（${record.amountSource}）`,
      title: "月租金额来源",
      width: 220
    },
    {
      render: (_, record) =>
        record.basisBillId
          ? `${record.basisBillId} / ${formatDate(record.basisPeriodStart)}`
          : record.baselineReason,
      title: "期初依据",
      width: 260
    }
  ];

  const scheduleColumns: ColumnsType<BillingScheduleItem> = [
    {
      render: (_, record) => (
        <Space orientation="vertical" size={0}>
          <Link href={`/orders/${record.orderId}`}>{record.orderNo ?? record.orderId}</Link>
          <Typography.Text type="secondary">{record.customerName ?? "-"}</Typography.Text>
        </Space>
      ),
      title: "订单 / 客户",
      width: 220
    },
    {
      dataIndex: "status",
      render: (value: string) => {
        const view = scheduleStatusView(value);
        return <Tag color={view.color}>{view.label}</Tag>;
      },
      title: "计划状态",
      width: 100
    },
    {
      render: (_, record) =>
        `${formatDate(record.nextPeriodStart)} 至 ${formatDate(record.nextPeriodEnd)}`,
      title: "下一账期",
      width: 210
    },
    {
      dataIndex: "nextGenerateAt",
      render: formatAutomationDate,
      title: "计划生成时间",
      width: 170
    },
    {
      render: (_, record) =>
        record.lastGeneratedBillId ? (
          <Link href={`/orders/${record.orderId}?tab=billing`}>
            {record.lastGeneratedBillNo ?? record.lastGeneratedBillId}
          </Link>
        ) : (
          "-"
        ),
      title: "最近账单",
      width: 180
    },
    {
      dataIndex: "pauseReason",
      render: safeText,
      title: "暂停原因",
      width: 180
    },
    {
      fixed: "right",
      render: (_, record) =>
        record.status === "PAUSED" ? (
          <ActionButton
            availability={generateAvailability}
            icon={<PlayCircleOutlined />}
            loading={actionLoading === `resume:${record.id}`}
            onClick={() => confirmResume(record)}
            size="small"
          >
            恢复
          </ActionButton>
        ) : (
          <ActionButton
            availability={
              record.status === "ACTIVE"
                ? generateAvailability
                : {
                    allowed: false,
                    reason: "只有运行中的账单计划可以暂停"
                  }
            }
            icon={<PauseCircleOutlined />}
            loading={actionLoading === `pause:${record.id}`}
            onClick={() => setPauseTarget(record)}
            size="small"
          >
            暂停
          </ActionButton>
        ),
      title: "操作",
      width: 100
    }
  ];

  const jobColumns: ColumnsType<BillingJobItem> = [
    {
      dataIndex: "jobStatus",
      render: (value: string) => {
        const view = jobStatusView(value);
        return <Tag color={view.color}>{view.label}</Tag>;
      },
      title: "状态",
      width: 110
    },
    {
      dataIndex: "jobType",
      render: jobTypeLabel,
      title: "任务类型",
      width: 150
    },
    {
      render: (_, record) =>
        record.orderId ? (
          <Link href={`/orders/${record.orderId}`}>{record.orderNo ?? record.orderId}</Link>
        ) : (
          "-"
        ),
      title: "关联订单",
      width: 180
    },
    {
      dataIndex: "billNo",
      render: (value: string | null, record) => value ?? record.billId ?? "-",
      title: "关联账单",
      width: 180
    },
    {
      dataIndex: "availableAt",
      render: formatAutomationDate,
      title: "可执行时间",
      width: 170
    },
    {
      render: (_, record) => `${record.attemptCount} / ${record.maxAttempts}`,
      title: "尝试次数",
      width: 100
    },
    {
      render: (_, record) => automationErrorText(record.lastErrorCode, record.lastErrorMessage),
      title: "异常摘要",
      width: 260
    },
    {
      fixed: "right",
      render: (_, record) =>
        record.jobStatus === "DEAD_LETTER" ? (
          <ActionButton
            availability={generateAvailability}
            icon={<ReloadOutlined />}
            loading={actionLoading === `retry:${record.id}`}
            onClick={() => confirmRetry(record)}
            size="small"
          >
            重试
          </ActionButton>
        ) : (
          "-"
        ),
      title: "操作",
      width: 90
    }
  ];

  const manualColumns: ColumnsType<MonthlyRentBatchItem> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => <Link href={`/orders/${record.orderId}`}>{value}</Link>,
      title: "订单编号",
      width: 170
    },
    {
      dataIndex: "action",
      render: (value: string) => (
        <Tag color={actionColors[value]}>{actionLabels[value] ?? value}</Tag>
      ),
      title: "动作",
      width: 130
    },
    {
      render: (_, record) => formatPeriod(record.periodStart, record.periodEnd),
      title: "账期",
      width: 210
    },
    {
      dataIndex: "amount",
      render: formatYuan,
      title: "应收金额",
      width: 130
    },
    {
      render: (_, record) => safeText(record.error ?? record.reason),
      title: "跳过 / 失败原因",
      width: 260
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space orientation="vertical" size={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            月租账单自动化
          </Typography.Title>
          <Typography.Text type="secondary">
            以交付激活后的订阅合同为基础，持续生成月租账单、发送到期提醒并在 D+5
            确认逾期；人工仅处理暂停、异常修复和死信重试。
          </Typography.Text>
        </Space>

        {!loadingMe && !canView ? <Alert message="无账单查看权限" showIcon type="warning" /> : null}

        <Row gutter={[12, 12]}>
          <SummaryCard
            loading={automationLoading}
            title="账单计划"
            value={sumCounts(summary?.schedules)}
          />
          <SummaryCard
            loading={automationLoading}
            title="运行中"
            value={summary?.schedules.ACTIVE ?? 0}
          />
          <SummaryCard
            loading={automationLoading}
            title="已暂停"
            value={summary?.schedules.PAUSED ?? 0}
          />
          <SummaryCard
            loading={automationLoading}
            title="死信任务"
            value={summary?.jobs.DEAD_LETTER ?? 0}
            valueStyle={(summary?.jobs.DEAD_LETTER ?? 0) > 0 ? { color: "#cf1322" } : undefined}
          />
        </Row>

        <Card
          extra={
            <Space>
              <Button
                icon={<SyncOutlined />}
                loading={automationLoading}
                onClick={() => void loadAutomation()}
              >
                刷新
              </Button>
              <ActionButton
                availability={generateAvailability}
                icon={<FileSearchOutlined />}
                loading={actionLoading === "reconcile-preview"}
                onClick={() => void reconcile(true)}
              >
                协调预览
              </ActionButton>
              <ActionButton
                availability={generateAvailability}
                icon={<CheckCircleOutlined />}
                loading={actionLoading === "reconcile-apply"}
                onClick={confirmReconcile}
                type="primary"
              >
                执行协调
              </ActionButton>
            </Space>
          }
          title="自动化运行概览"
        >
          <Descriptions
            column={3}
            items={[
              {
                children: summary?.nextSchedule
                  ? formatAutomationDate(summary.nextSchedule.nextGenerateAt)
                  : "-",
                label: "最近计划生成时间"
              },
              {
                children: summary?.nextSchedule
                  ? `${formatDate(summary.nextSchedule.nextPeriodStart)} 至 ${formatDate(
                      summary.nextSchedule.nextPeriodEnd
                    )}`
                  : "-",
                label: "最近待生成账期"
              },
              {
                children: summary?.oldestPendingJob
                  ? formatAutomationDate(summary.oldestPendingJob.availableAt)
                  : "-",
                label: "最早待执行任务"
              }
            ]}
            size="small"
          />
          {reconcileResult ? (
            <Space
              orientation="vertical"
              size={12}
              style={{ marginTop: 16, width: "100%" }}
            >
              <Alert
                message={
                  reconcileResult.dryRun
                    ? "当前为协调预览，未写入任何计划。"
                    : "账单计划协调已执行。"
                }
                description={`符合条件 ${reconcileResult.eligibleCount} 单；已有计划 ${reconcileResult.existingCount} 单；${
                  reconcileResult.dryRun ? "预计新增" : "实际新增"
                } ${reconcileResult.createdCount} 单。`}
                showIcon
                type={reconcileResult.dryRun ? "info" : "success"}
              />
              <Table
                columns={reconcileColumns}
                dataSource={reconcileResult.items}
                pagination={{ pageSize: 10 }}
                rowKey="orderId"
                scroll={{ x: 1130 }}
                size="small"
              />
            </Space>
          ) : null}
        </Card>

        <Card title="订单账单计划">
          <Table
            columns={scheduleColumns}
            dataSource={schedules}
            loading={automationLoading}
            onChange={(pagination) =>
              setSchedulePage((current) => ({
                ...current,
                current: pagination.current ?? 1,
                pageSize: pagination.pageSize ?? current.pageSize
              }))
            }
            pagination={{
              current: schedulePage.current,
              pageSize: schedulePage.pageSize,
              showSizeChanger: true,
              total: schedulePage.total
            }}
            rowKey="id"
            scroll={{ x: 1260 }}
            size="small"
          />
        </Card>

        <Card
          extra={
            <Checkbox
              checked={showJobHistory}
              onChange={(event) => {
                setShowJobHistory(event.target.checked);
                setJobPage((current) => ({ ...current, current: 1 }));
              }}
            >
              包含已完成历史
            </Checkbox>
          }
          title="自动化任务与异常"
        >
          <Table
            columns={jobColumns}
            dataSource={jobs}
            loading={automationLoading}
            onChange={(pagination) =>
              setJobPage((current) => ({
                ...current,
                current: pagination.current ?? 1,
                pageSize: pagination.pageSize ?? current.pageSize
              }))
            }
            pagination={{
              current: jobPage.current,
              pageSize: jobPage.pageSize,
              showSizeChanger: true,
              total: jobPage.total
            }}
            rowKey="id"
            scroll={{ x: 1300 }}
            size="small"
          />
        </Card>

        <Card title="应急兜底：人工批量生成">
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              message="仅在 Worker 关闭或自动化异常尚未恢复时使用。请先试算；正式生成仍复用账单来源键，不会重复创建同一账期账单。"
              showIcon
              type="warning"
            />
            <Form
              form={manualForm}
              initialValues={{ billingDate: dayjs(), dryRun: true }}
              layout="inline"
            >
              <Form.Item
                label="账单生成日期"
                name="billingDate"
                rules={[{ required: true, message: "请选择账单生成日期" }]}
              >
                <DatePicker allowClear={false} />
              </Form.Item>
              <Form.Item name="dryRun" valuePropName="checked">
                <Checkbox>试算</Checkbox>
              </Form.Item>
              <Form.Item>
                <Space>
                  <ActionButton
                    availability={generateAvailability}
                    icon={<FileSearchOutlined />}
                    loading={manualSubmitting}
                    onClick={async () => submitManual(await manualForm.validateFields(), true)}
                  >
                    试算
                  </ActionButton>
                  <ActionButton
                    availability={generateAvailability}
                    icon={<CheckCircleOutlined />}
                    loading={manualSubmitting}
                    onClick={() =>
                      modal.confirm({
                        cancelText: "取消",
                        content: "系统将为符合条件的订单创建月租应收账单。",
                        okText: "确认生成",
                        onOk: async () => submitManual(await manualForm.validateFields(), false),
                        title: "正式生成人工月租账单"
                      })
                    }
                    type="primary"
                  >
                    正式生成
                  </ActionButton>
                </Space>
              </Form.Item>
            </Form>
            {manualResult ? (
              <>
                <Descriptions
                  bordered
                  column={4}
                  items={[
                    {
                      children: manualResult.generatedCount,
                      label: "生成数量"
                    },
                    {
                      children: manualResult.skippedCount,
                      label: "跳过数量"
                    },
                    {
                      children: manualResult.failedCount,
                      label: "失败数量"
                    },
                    {
                      children: manualResult.dryRun ? "是" : "否",
                      label: "是否试算"
                    }
                  ]}
                  size="small"
                />
                <Table
                  columns={manualColumns}
                  dataSource={manualResult.items}
                  pagination={{ pageSize: 10 }}
                  rowKey={(record, index) =>
                    `${record.orderId}-${record.action}-${record.periodStart ?? index}`
                  }
                  scroll={{ x: 900 }}
                  size="small"
                />
              </>
            ) : null}
          </Space>
        </Card>
      </Space>

      <Modal
        cancelText="取消"
        confirmLoading={pauseTarget ? actionLoading === `pause:${pauseTarget.id}` : false}
        onCancel={() => {
          setPauseTarget(null);
          pauseForm.resetFields();
        }}
        onOk={() => void submitPause()}
        open={Boolean(pauseTarget)}
        okText="确认暂停"
        title="暂停账单计划"
      >
        <Alert
          message="暂停后不再生成新的月租账单；已形成的账单、应收和催收事实保持不变。"
          showIcon
          style={{ marginBottom: 16 }}
          type="warning"
        />
        <Form form={pauseForm} layout="vertical">
          <Form.Item
            label="暂停原因"
            name="reason"
            rules={[
              { required: true, whitespace: true, message: "请输入暂停原因" },
              { max: 255, message: "暂停原因不能超过 255 个字符" }
            ]}
          >
            <Input.TextArea
              maxLength={255}
              placeholder="例如：合同变更处理中，待确认新账期"
              rows={3}
              showCount
            />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

function SummaryCard({
  loading,
  title,
  value,
  valueStyle
}: {
  loading: boolean;
  title: string;
  value: number;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <Col lg={6} md={12} xs={24}>
      <Card loading={loading} size="small">
        <Statistic title={title} value={value} valueStyle={valueStyle} />
      </Card>
    </Col>
  );
}

function sumCounts(counts?: Record<string, number>) {
  return counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0;
}

function formatYuan(value?: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "-";
}

function formatPeriod(start?: string | null, end?: string | null) {
  const formattedStart = formatDate(start);
  const formattedEnd = formatDate(end);
  return formattedStart === "-" || formattedEnd === "-"
    ? "-"
    : `${formattedStart} 至 ${formattedEnd}`;
}

function safeText(value?: unknown) {
  return typeof value === "string" && value ? value : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}
