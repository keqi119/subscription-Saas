"use client";

import { CheckCircleOutlined, FileSearchOutlined } from "@ant-design/icons";
import { Alert, App, Card, Checkbox, DatePicker, Descriptions, Form, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import { actionAvailability } from "../../../lib/action-guards";
import { apiFetch, ApiError } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";

interface MonthlyRentBatchFormValues {
  billingDate?: Dayjs;
  dryRun?: boolean;
}

interface MonthlyRentBatchItem {
  action: string;
  amount?: number | null;
  billId?: string | null;
  dryRun?: boolean;
  error?: string | null;
  orderId: string;
  orderNo: string;
  periodEnd?: string | null;
  periodStart?: string | null;
  reason?: string | null;
}

interface MonthlyRentBatchResult {
  billingDate?: string | null;
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
  SKIPPED_EXISTING: "已存在账单",
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
  return formattedStart === "-" || formattedEnd === "-" ? "-" : `${formattedStart} 至 ${formattedEnd}`;
}

function safeText(value?: unknown) {
  return typeof value === "string" && value ? value : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function MonthlyRentBatchPage() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<MonthlyRentBatchFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MonthlyRentBatchResult | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("billing:view") || permissions.has("billing:generate");
  const generateAvailability = actionAvailability({
    allowed: canView,
    disabledReason: "无生成账单权限",
    noPermissionReason: "无生成账单权限",
    permission: "billing:generate",
    permissions
  });

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => {
        void message.error(getErrorMessage(error));
      })
      .finally(() => setLoadingMe(false));
  }, [message]);

  async function submit(values: MonthlyRentBatchFormValues, dryRun: boolean) {
    if (!values.billingDate) {
      void message.error("请选择账单生成日期");
      return;
    }

    setSubmitting(true);
    try {
      const nextResult = await apiFetch<MonthlyRentBatchResult>("/billing/monthly-rent/generate", {
        body: JSON.stringify({
          billingDate: values.billingDate.format("YYYY-MM-DD"),
          dryRun
        }),
        method: "POST"
      });
      setResult(nextResult);
      form.setFieldsValue({ dryRun });
      void message.success(dryRun ? "试算完成" : "月租账单生成完成");
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function runDryRun() {
    const values = await form.validateFields();
    await submit(values, true);
  }

  async function confirmGenerate() {
    const values = await form.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "本操作将为符合条件的在租订单创建 MONTHLY_RENT 应收账单。",
      okText: "确认生成",
      onOk: () => submit(values, false),
      title: "确认正式生成月租账单？"
    });
  }

  const columns: ColumnsType<MonthlyRentBatchItem> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => <Link href={`/orders/${record.orderId}`}>{value}</Link>,
      title: "订单编号",
      width: 170
    },
    { dataIndex: "orderId", render: safeText, title: "订单 ID", width: 230 },
    {
      dataIndex: "action",
      render: (value: string) => <Tag color={actionColors[value]}>{actionLabels[value] ?? value}</Tag>,
      title: "动作",
      width: 130
    },
    { dataIndex: "billId", render: safeText, title: "账单 ID", width: 230 },
    {
      render: (_, record) => formatPeriod(record.periodStart, record.periodEnd),
      title: "账期",
      width: 210
    },
    { dataIndex: "amount", render: formatYuan, title: "应收金额", width: 130 },
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
            月租账单生成
          </Typography.Title>
          <Typography.Text type="secondary">
            本页面用于人工批量生成在租订单的月租应收账单。当前阶段不包含自动定时任务、逾期催收或自动扣款。
          </Typography.Text>
        </Space>

        {!loadingMe && !canView ? <Alert message="无财务查看权限" showIcon type="warning" /> : null}

        <Card title="批量生成条件">
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              message="试算模式不会写入数据库，仅展示本次将生成、跳过或失败的订单明细。正式生成会创建 MONTHLY_RENT 应收账单，并写入审计日志。"
              showIcon
              type="info"
            />
            <Form
              form={form}
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
                <Checkbox>是否试算</Checkbox>
              </Form.Item>
              <Form.Item>
                <Space>
                  <ActionButton
                    availability={generateAvailability}
                    icon={<FileSearchOutlined />}
                    loading={submitting}
                    onClick={runDryRun}
                    type="primary"
                  >
                    试算
                  </ActionButton>
                  <ActionButton
                    availability={generateAvailability}
                    icon={<CheckCircleOutlined />}
                    loading={submitting}
                    onClick={confirmGenerate}
                  >
                    正式生成
                  </ActionButton>
                </Space>
              </Form.Item>
            </Form>
          </Space>
        </Card>

        {result ? (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              message={result.dryRun ? "当前为试算结果，未创建任何账单。" : "月租账单生成完成。"}
              showIcon
              type={result.dryRun ? "info" : "success"}
            />
            <Descriptions
              bordered
              column={4}
              items={[
                { label: "生成数量", children: result.generatedCount },
                { label: "跳过数量", children: result.skippedCount },
                { label: "失败数量", children: result.failedCount },
                { label: "是否试算", children: result.dryRun ? <Tag color="blue">是</Tag> : <Tag color="green">否</Tag> }
              ]}
              title="结果汇总"
            />
            <Table
              columns={columns}
              dataSource={result.items}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              rowKey={(record, index) => `${record.orderId}-${record.action}-${record.periodStart ?? index}`}
              scroll={{ x: 1380 }}
              size="small"
              title={() => "结果明细"}
            />
          </Space>
        ) : null}
      </Space>
    </ProtectedShell>
  );
}
