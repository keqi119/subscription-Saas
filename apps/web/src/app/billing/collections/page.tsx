"use client";

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  FileSearchOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  COLLECTION_ACTION_RESULT_LABELS,
  COLLECTION_ACTION_TYPE_LABELS,
  COLLECTION_CASE_STATUS_LABELS,
  COLLECTION_LEVEL_LABELS,
  CONTACT_METHOD_LABELS,
  labelOf
} from "../../../constants/labels";
import { actionAvailability } from "../../../lib/action-guards";
import { ApiError, apiFetch } from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";

interface RefreshOverdueFormValues {
  asOfDate?: Dayjs;
}

interface OverdueBillFilterValues {
  billType?: string;
  collectionLevel?: string;
  customerName?: string;
  maxOverdueDays?: number;
  minOverdueDays?: number;
  orderNo?: string;
}

interface CollectionCaseFilterValues {
  assignedTo?: string;
  caseStatus?: string;
  collectionLevel?: string;
  customerName?: string;
  orderNo?: string;
}

interface CollectionActionFormValues {
  actionResult?: string;
  actionType?: string;
  contactMethod?: string;
  content?: string;
  nextFollowUpAt?: Dayjs;
  promisedAmountYuan?: number;
  promisedPayAt?: Dayjs;
}

interface CloseCaseFormValues {
  closeReason?: string;
}

interface RefreshOverdueItem {
  amount?: number | null;
  billId?: string | null;
  billNo?: string | null;
  billStatus?: string | null;
  billType?: string | null;
  collectionLevel?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  dueDate?: string | null;
  orderId?: string | null;
  orderNo?: string | null;
  overdueDays?: number | null;
  paidAmount?: number | null;
  remainingAmount?: number | null;
  reason?: string | null;
}

interface RefreshOverdueResult {
  asOfDate?: string | null;
  createdCaseCount: number;
  dryRun: boolean;
  items?: RefreshOverdueItem[];
  overdueBillCount: number;
  updatedCaseCount: number;
}

interface CustomerBrief {
  id?: string | null;
  mobile?: string | null;
  name?: string | null;
}

interface OrderBrief {
  id?: string | null;
  orderNo?: string | null;
}

interface ReceivableBill {
  amount?: number | null;
  billNo?: string | null;
  billPeriodEnd?: string | null;
  billPeriodStart?: string | null;
  billStatus?: string | null;
  billType?: string | null;
  dueDate?: string | null;
  id?: string | null;
  paidAmount?: number | null;
  paidAt?: string | null;
  remainingAmount?: number | null;
  remark?: string | null;
}

interface OverdueBillRow {
  amount?: number | null;
  billId: string;
  billNo?: string | null;
  billStatus?: string | null;
  billType?: string | null;
  collectionCaseId?: string | null;
  collectionCaseStatus?: string | null;
  collectionLevel?: string | null;
  customer?: CustomerBrief | null;
  dueDate?: string | null;
  order?: OrderBrief | null;
  overdueDays?: number | null;
  paidAmount?: number | null;
  remainingAmount?: number | null;
}

interface CollectionCaseRow {
  assignedTo?: string | null;
  caseNo?: string | null;
  caseStatus?: string | null;
  closeReason?: string | null;
  closedAt?: string | null;
  collectionLevel?: string | null;
  createdAt?: string | null;
  customer?: CustomerBrief | null;
  id: string;
  latestDueDate?: string | null;
  maxOverdueDays?: number | null;
  nextFollowUpAt?: string | null;
  order?: OrderBrief | null;
  totalOverdueAmount?: number | null;
  updatedAt?: string | null;
}

interface CollectionCaseBill {
  bill?: ReceivableBill | null;
  billId?: string | null;
  overdueAmount?: number | null;
  overdueDays?: number | null;
}

interface CollectionActionRow {
  actionResult?: string | null;
  actionType?: string | null;
  contactMethod?: string | null;
  content?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  id: string;
  nextFollowUpAt?: string | null;
  promisedAmount?: number | null;
  promisedPayAt?: string | null;
}

interface CollectionCaseDetail extends CollectionCaseRow {
  actions: CollectionActionRow[];
  bills: CollectionCaseBill[];
  closeReason?: string | null;
  closedAt?: string | null;
}

const levelColors: Record<string, string> = {
  D1: "blue",
  D2: "cyan",
  D3: "gold",
  D4: "orange",
  D5: "red"
};

const caseStatusColors: Record<string, string> = {
  ACTIVE: "orange",
  CLOSED: "green",
  PAUSED: "default"
};

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function safeText(value?: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value : "-";
}

function formatYuan(value?: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return `¥${(value / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "-";
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD HH:mm") : "-";
}

function formatCustomer(customer?: CustomerBrief | null) {
  if (!customer) {
    return "-";
  }

  const name = safeText(customer.name);
  const mobile = safeText(customer.mobile);
  return mobile === "-" ? name : `${name} / ${mobile}`;
}

function formatOrderLink(order?: OrderBrief | null) {
  if (!order?.id) {
    return safeText(order?.orderNo);
  }

  return <Link href={`/orders/${order.id}`}>{safeText(order.orderNo)}</Link>;
}

function formatTag(labels: Record<string, string>, value?: string | null, colors?: Record<string, string>) {
  if (!value) {
    return "-";
  }

  return <Tag color={colors?.[value]}>{labelOf(labels, value)}</Tag>;
}

function optionsFromLabels(labels: Record<string, string>) {
  return Object.entries(labels).map(([value, label]) => ({ label, value }));
}

function buildQuery(values: object) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

function toCentAmount(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

function isBillSettled(caseBill: CollectionCaseBill) {
  const bill = caseBill.bill;
  return (bill?.remainingAmount ?? caseBill.overdueAmount ?? 1) <= 0 || bill?.billStatus === "PAID";
}

function isCaseSettled(caseDetail?: CollectionCaseDetail | null) {
  if (!caseDetail) {
    return false;
  }

  return caseDetail.bills.every(isBillSettled);
}

export default function CollectionsPage() {
  const { message, modal } = App.useApp();
  const [refreshForm] = Form.useForm<RefreshOverdueFormValues>();
  const [overdueFilterForm] = Form.useForm<OverdueBillFilterValues>();
  const [caseFilterForm] = Form.useForm<CollectionCaseFilterValues>();
  const [actionForm] = Form.useForm<CollectionActionFormValues>();
  const [closeForm] = Form.useForm<CloseCaseFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshOverdueResult | null>(null);
  const [overdueBills, setOverdueBills] = useState<OverdueBillRow[]>([]);
  const [cases, setCases] = useState<CollectionCaseRow[]>([]);
  const [loadingOverdueBills, setLoadingOverdueBills] = useState(false);
  const [loadingCases, setLoadingCases] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedCase, setSelectedCase] = useState<CollectionCaseDetail | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [actionTargetId, setActionTargetId] = useState<string | null>(null);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<CollectionCaseRow | CollectionCaseDetail | null>(null);
  const [submittingClose, setSubmittingClose] = useState(false);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("collection:view");
  const refreshAvailability = actionAvailability({
    noPermissionReason: "无刷新逾期权限",
    permission: "collection:refresh_overdue",
    permissions
  });

  const loadOverdueBills = useCallback(async () => {
    setLoadingOverdueBills(true);
    try {
      const query = buildQuery(overdueFilterForm.getFieldsValue());
      setOverdueBills(await apiFetch<OverdueBillRow[]>(`/billing/overdue-bills${query}`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoadingOverdueBills(false);
    }
  }, [message, overdueFilterForm]);

  const loadCases = useCallback(async () => {
    setLoadingCases(true);
    try {
      const query = buildQuery(caseFilterForm.getFieldsValue());
      setCases(await apiFetch<CollectionCaseRow[]>(`/collection-cases${query}`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoadingCases(false);
    }
  }, [caseFilterForm, message]);

  const loadCaseDetail = useCallback(
    async (caseId: string) => {
      setDetailLoading(true);
      try {
        const detail = await apiFetch<CollectionCaseDetail>(`/collection-cases/${caseId}`);
        setSelectedCase(detail);
        return detail;
      } catch (error) {
        void message.error(getErrorMessage(error));
        return null;
      } finally {
        setDetailLoading(false);
      }
    },
    [message]
  );

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then((nextMe) => {
        setMe(nextMe);
      })
      .catch((error) => {
        void message.error(getErrorMessage(error));
      })
      .finally(() => setLoadingMe(false));
  }, [message]);

  useEffect(() => {
    if (!loadingMe && canView) {
      void loadOverdueBills();
      void loadCases();
    }
  }, [canView, loadCases, loadOverdueBills, loadingMe]);

  async function submitRefresh(dryRun: boolean) {
    const values = await refreshForm.validateFields();
    if (!values.asOfDate) {
      void message.error("请选择截止日期");
      return;
    }

    setRefreshing(true);
    try {
      const result = await apiFetch<RefreshOverdueResult>("/billing/overdue/refresh", {
        body: JSON.stringify({
          asOfDate: values.asOfDate.format("YYYY-MM-DD"),
          dryRun
        }),
        method: "POST"
      });
      setRefreshResult(result);
      void message.success(dryRun ? "逾期试算完成" : "逾期刷新完成");

      if (!dryRun) {
        await Promise.all([loadOverdueBills(), loadCases()]);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function runDryRun() {
    await submitRefresh(true);
  }

  async function confirmRefresh() {
    const values = await refreshForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "本操作会将符合条件的账单标记为已逾期，并创建或更新催收案件。",
      okText: "确认刷新",
      onOk: () => submitRefresh(false),
      title: "确认正式刷新逾期账单？"
    });
    refreshForm.setFieldsValue(values);
  }

  async function openCaseDetail(caseId?: string | null) {
    if (!caseId) {
      return;
    }
    setDetailOpen(true);
    await loadCaseDetail(caseId);
  }

  function openActionModal(caseId: string) {
    setActionTargetId(caseId);
    actionForm.setFieldsValue({
      actionResult: "CUSTOMER_PROMISED",
      actionType: "FOLLOW_UP",
      contactMethod: "PHONE"
    });
    setActionModalOpen(true);
  }

  async function submitAction() {
    if (!actionTargetId) {
      return;
    }

    const values = await actionForm.validateFields();
    setSubmittingAction(true);
    try {
      const promisedAmount = toCentAmount(values.promisedAmountYuan);
      await apiFetch(`/collection-cases/${actionTargetId}/actions`, {
        body: JSON.stringify({
          actionResult: values.actionResult,
          actionType: values.actionType,
          contactMethod: values.contactMethod,
          content: values.content,
          nextFollowUpAt: values.nextFollowUpAt?.toISOString(),
          promisedAmount,
          promisedPayAt: values.promisedPayAt?.format("YYYY-MM-DD")
        }),
        method: "POST"
      });
      void message.success("催收跟进记录已新增");
      setActionModalOpen(false);
      actionForm.resetFields();
      await loadCases();
      if (selectedCase?.id === actionTargetId) {
        await loadCaseDetail(actionTargetId);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmittingAction(false);
    }
  }

  function openCloseModal(record: CollectionCaseRow | CollectionCaseDetail) {
    setCloseTarget(record);
    closeForm.resetFields();
    closeForm.setFieldsValue({ closeReason: "账单已结清" });
    setCloseModalOpen(true);
  }

  async function submitClose() {
    if (!closeTarget?.id) {
      return;
    }

    const values = await closeForm.validateFields();
    setSubmittingClose(true);
    try {
      await apiFetch(`/collection-cases/${closeTarget.id}/close`, {
        body: JSON.stringify({ closeReason: values.closeReason }),
        method: "POST"
      });
      void message.success("催收案件已关闭");
      setCloseModalOpen(false);
      closeForm.resetFields();
      await Promise.all([loadCases(), loadOverdueBills()]);
      if (selectedCase?.id === closeTarget.id) {
        await loadCaseDetail(closeTarget.id);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmittingClose(false);
    }
  }

  function getActionCreateAvailability(record?: CollectionCaseRow | CollectionCaseDetail | null) {
    return actionAvailability({
      allowed: record?.caseStatus !== "CLOSED",
      disabledReason: "已关闭催收案件不能新增催收动作",
      noPermissionReason: "无新增催收动作权限",
      permission: "collection:action_create",
      permissions
    });
  }

  function getCloseAvailability(record?: CollectionCaseRow | CollectionCaseDetail | null, checkSettled = false) {
    const closed = record?.caseStatus === "CLOSED";
    const unsettled = checkSettled && !isCaseSettled(record as CollectionCaseDetail);
    return actionAvailability({
      allowed: !closed && !unsettled,
      disabledReason: closed ? "催收案件已关闭" : "存在未结清账单，不能关闭案件",
      noPermissionReason: "无关闭催收案件权限",
      permission: "collection:close",
      permissions
    });
  }

  const refreshItemColumns: ColumnsType<RefreshOverdueItem> = [
    { dataIndex: "billNo", render: safeText, title: "账单编号", width: 170 },
    {
      dataIndex: "orderNo",
      render: (value: string | null | undefined, record) =>
        record.orderId ? <Link href={`/orders/${record.orderId}`}>{safeText(value)}</Link> : safeText(value),
      title: "订单编号",
      width: 170
    },
    { dataIndex: "customerName", render: safeText, title: "客户", width: 150 },
    {
      dataIndex: "billType",
      render: (value: string | null | undefined) => labelOf(BILL_TYPE_LABELS, value),
      title: "账单类型",
      width: 130
    },
    { dataIndex: "remainingAmount", render: formatYuan, title: "剩余金额", width: 130 },
    { dataIndex: "dueDate", render: formatDate, title: "到期日", width: 120 },
    { dataIndex: "overdueDays", render: safeText, title: "逾期天数", width: 110 },
    {
      dataIndex: "collectionLevel",
      render: (value: string | null | undefined) => formatTag(COLLECTION_LEVEL_LABELS, value, levelColors),
      title: "逾期等级",
      width: 130
    },
    {
      render: () => (refreshResult?.dryRun ? "试算命中" : "已刷新"),
      title: "处理结果",
      width: 120
    },
    { dataIndex: "reason", render: safeText, title: "原因", width: 180 }
  ];

  const overdueBillColumns: ColumnsType<OverdueBillRow> = [
    { dataIndex: "billNo", render: safeText, title: "账单编号", width: 170 },
    {
      dataIndex: "order",
      render: (value: OrderBrief | null | undefined) => formatOrderLink(value),
      title: "订单编号",
      width: 170
    },
    {
      dataIndex: "customer",
      render: (value: CustomerBrief | null | undefined) => formatCustomer(value),
      title: "客户",
      width: 180
    },
    {
      dataIndex: "billType",
      render: (value: string | null | undefined) => labelOf(BILL_TYPE_LABELS, value),
      title: "账单类型",
      width: 130
    },
    { dataIndex: "amount", render: formatYuan, title: "应收金额", width: 130 },
    { dataIndex: "paidAmount", render: formatYuan, title: "已收金额", width: 130 },
    { dataIndex: "remainingAmount", render: formatYuan, title: "剩余金额", width: 130 },
    { dataIndex: "dueDate", render: formatDate, title: "到期日", width: 120 },
    { dataIndex: "overdueDays", render: safeText, title: "逾期天数", width: 110 },
    {
      dataIndex: "collectionLevel",
      render: (value: string | null | undefined) => formatTag(COLLECTION_LEVEL_LABELS, value, levelColors),
      title: "逾期等级",
      width: 130
    },
    {
      dataIndex: "collectionCaseStatus",
      render: (value: string | null | undefined) => formatTag(COLLECTION_CASE_STATUS_LABELS, value, caseStatusColors),
      title: "催收案件状态",
      width: 140
    },
    {
      fixed: "right",
      render: (_, record) => (
        <ActionButton
          availability={actionAvailability({
            allowed: Boolean(record.collectionCaseId),
            disabledReason: "该账单尚未关联催收案件",
            noPermissionReason: "无催收查看权限",
            permission: "collection:view",
            permissions
          })}
          icon={<EyeOutlined />}
          onClick={() => openCaseDetail(record.collectionCaseId)}
          size="small"
        >
          查看案件
        </ActionButton>
      ),
      title: "操作",
      width: 120
    }
  ];

  const caseColumns: ColumnsType<CollectionCaseRow> = [
    { dataIndex: "caseNo", render: safeText, title: "案件编号", width: 180 },
    {
      dataIndex: "customer",
      render: (value: CustomerBrief | null | undefined) => formatCustomer(value),
      title: "客户",
      width: 180
    },
    {
      dataIndex: "order",
      render: (value: OrderBrief | null | undefined) => formatOrderLink(value),
      title: "订单编号",
      width: 170
    },
    { dataIndex: "totalOverdueAmount", render: formatYuan, title: "逾期总金额", width: 130 },
    { dataIndex: "maxOverdueDays", render: safeText, title: "最大逾期天数", width: 130 },
    {
      dataIndex: "collectionLevel",
      render: (value: string | null | undefined) => formatTag(COLLECTION_LEVEL_LABELS, value, levelColors),
      title: "逾期等级",
      width: 130
    },
    {
      dataIndex: "caseStatus",
      render: (value: string | null | undefined) => formatTag(COLLECTION_CASE_STATUS_LABELS, value, caseStatusColors),
      title: "案件状态",
      width: 120
    },
    { dataIndex: "assignedTo", render: safeText, title: "负责人", width: 150 },
    { dataIndex: "nextFollowUpAt", render: formatDateTime, title: "下次跟进时间", width: 170 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 170 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <ActionButton
            icon={<EyeOutlined />}
            onClick={() => openCaseDetail(record.id)}
            permission="collection:view"
            permissions={permissions}
            size="small"
          >
            查看详情
          </ActionButton>
          <ActionButton
            availability={getActionCreateAvailability(record)}
            icon={<PlusOutlined />}
            onClick={() => openActionModal(record.id)}
            size="small"
          >
            新增跟进
          </ActionButton>
          <ActionButton
            availability={getCloseAvailability(record)}
            icon={<CloseCircleOutlined />}
            onClick={() => openCloseModal(record)}
            size="small"
          >
            关闭案件
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 280
    }
  ];

  const detailBillColumns: ColumnsType<CollectionCaseBill> = [
    { dataIndex: ["bill", "billNo"], render: safeText, title: "账单编号", width: 170 },
    {
      dataIndex: ["bill", "billType"],
      render: (value: string | null | undefined) => labelOf(BILL_TYPE_LABELS, value),
      title: "账单类型",
      width: 130
    },
    { dataIndex: ["bill", "amount"], render: formatYuan, title: "应收金额", width: 130 },
    { dataIndex: ["bill", "paidAmount"], render: formatYuan, title: "已收金额", width: 130 },
    { dataIndex: ["bill", "remainingAmount"], render: formatYuan, title: "剩余金额", width: 130 },
    { dataIndex: ["bill", "dueDate"], render: formatDate, title: "到期日", width: 120 },
    { dataIndex: "overdueDays", render: safeText, title: "逾期天数", width: 110 },
    {
      dataIndex: ["bill", "billStatus"],
      render: (value: string | null | undefined) => formatTag(BILL_STATUS_LABELS, value),
      title: "账单状态",
      width: 120
    }
  ];

  const actionColumns: ColumnsType<CollectionActionRow> = [
    {
      dataIndex: "actionType",
      render: (value: string | null | undefined) => formatTag(COLLECTION_ACTION_TYPE_LABELS, value),
      title: "动作类型",
      width: 130
    },
    {
      dataIndex: "contactMethod",
      render: (value: string | null | undefined) => labelOf(CONTACT_METHOD_LABELS, value),
      title: "联系方式",
      width: 110
    },
    {
      dataIndex: "actionResult",
      render: (value: string | null | undefined) => labelOf(COLLECTION_ACTION_RESULT_LABELS, value),
      title: "动作结果",
      width: 120
    },
    { dataIndex: "content", render: safeText, title: "内容", width: 260 },
    { dataIndex: "promisedPayAt", render: formatDate, title: "承诺付款日期", width: 140 },
    { dataIndex: "promisedAmount", render: formatYuan, title: "承诺付款金额", width: 140 },
    { dataIndex: "nextFollowUpAt", render: formatDateTime, title: "下次跟进时间", width: 170 },
    { dataIndex: "createdBy", render: safeText, title: "创建人", width: 140 },
    { dataIndex: "createdAt", render: formatDateTime, title: "创建时间", width: 170 }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space orientation="vertical" size={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            逾期催收
          </Typography.Title>
          <Typography.Text type="secondary">
            本页面用于人工识别逾期账单并记录催收跟进。当前阶段不包含短信发送、电话外呼、自动催收、法务流转或征信上报。
          </Typography.Text>
        </Space>

        {!loadingMe && !canView ? <Alert showIcon title="无催收查看权限" type="warning" /> : null}

        {canView ? (
          <>
            <Card title="逾期刷新">
              <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                <Form form={refreshForm} initialValues={{ asOfDate: dayjs() }} layout="inline">
                  <Form.Item
                    label="截止日期"
                    name="asOfDate"
                    rules={[{ required: true, message: "请选择截止日期" }]}
                  >
                    <DatePicker allowClear={false} />
                  </Form.Item>
                  <Form.Item>
                    <Space>
                      <ActionButton
                        availability={refreshAvailability}
                        icon={<FileSearchOutlined />}
                        loading={refreshing}
                        onClick={runDryRun}
                        type="primary"
                      >
                        试算逾期
                      </ActionButton>
                      <ActionButton
                        availability={refreshAvailability}
                        icon={<CheckCircleOutlined />}
                        loading={refreshing}
                        onClick={confirmRefresh}
                      >
                        正式刷新
                      </ActionButton>
                    </Space>
                  </Form.Item>
                </Form>
              </Space>
            </Card>

            {refreshResult ? (
              <Card title="逾期刷新结果">
                <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                  <Alert
                    title={
                      refreshResult.dryRun
                        ? "当前为试算结果，未更新账单状态，也未创建催收案件。"
                        : "逾期账单刷新完成。"
                    }
                    showIcon
                    type={refreshResult.dryRun ? "info" : "success"}
                  />
                  <Descriptions
                    bordered
                    column={4}
                    items={[
                      { label: "逾期账单数量", children: refreshResult.overdueBillCount },
                      { label: "新建催收案件数量", children: refreshResult.createdCaseCount },
                      { label: "更新催收案件数量", children: refreshResult.updatedCaseCount },
                      {
                        label: "是否试算",
                        children: refreshResult.dryRun ? <Tag color="blue">是</Tag> : <Tag color="green">否</Tag>
                      }
                    ]}
                  />
                  <Table
                    columns={refreshItemColumns}
                    dataSource={refreshResult.items ?? []}
                    pagination={{ pageSize: 10, showSizeChanger: true }}
                    rowKey={(record, index) => `${record.billId ?? "bill"}-${index}`}
                    scroll={{ x: 1380 }}
                    size="small"
                  />
                </Space>
              </Card>
            ) : null}

            <Tabs
              items={[
                {
                  children: (
                    <Card>
                      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                        <Form form={overdueFilterForm} layout="inline" onFinish={loadOverdueBills}>
                          <Form.Item label="订单编号" name="orderNo">
                            <Input allowClear placeholder="订单编号" />
                          </Form.Item>
                          <Form.Item label="客户姓名" name="customerName">
                            <Input allowClear placeholder="客户姓名" />
                          </Form.Item>
                          <Form.Item label="账单类型" name="billType">
                            <Select allowClear options={optionsFromLabels(BILL_TYPE_LABELS)} style={{ width: 150 }} />
                          </Form.Item>
                          <Form.Item label="逾期等级" name="collectionLevel">
                            <Select allowClear options={optionsFromLabels(COLLECTION_LEVEL_LABELS)} style={{ width: 160 }} />
                          </Form.Item>
                          <Form.Item label="最小逾期天数" name="minOverdueDays">
                            <InputNumber min={0} style={{ width: 120 }} />
                          </Form.Item>
                          <Form.Item label="最大逾期天数" name="maxOverdueDays">
                            <InputNumber min={0} style={{ width: 120 }} />
                          </Form.Item>
                          <Form.Item>
                            <Space>
                              <ActionButton icon={<ReloadOutlined />} onClick={loadOverdueBills} permission="collection:view" permissions={permissions}>
                                查询
                              </ActionButton>
                              <ActionButton
                                onClick={() => {
                                  overdueFilterForm.resetFields();
                                  void loadOverdueBills();
                                }}
                                permission="collection:view"
                                permissions={permissions}
                              >
                                重置
                              </ActionButton>
                            </Space>
                          </Form.Item>
                        </Form>
                        <Table
                          columns={overdueBillColumns}
                          dataSource={overdueBills}
                          loading={loadingOverdueBills}
                          pagination={{ pageSize: 20, showSizeChanger: true }}
                          rowKey={(record) => record.billId}
                          scroll={{ x: 1690 }}
                          size="small"
                        />
                      </Space>
                    </Card>
                  ),
                  key: "overdue-bills",
                  label: "逾期账单"
                },
                {
                  children: (
                    <Card>
                      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
                        <Form form={caseFilterForm} layout="inline" onFinish={loadCases}>
                          <Form.Item label="案件状态" name="caseStatus">
                            <Select allowClear options={optionsFromLabels(COLLECTION_CASE_STATUS_LABELS)} style={{ width: 150 }} />
                          </Form.Item>
                          <Form.Item label="逾期等级" name="collectionLevel">
                            <Select allowClear options={optionsFromLabels(COLLECTION_LEVEL_LABELS)} style={{ width: 160 }} />
                          </Form.Item>
                          <Form.Item label="负责人" name="assignedTo">
                            <Input allowClear placeholder="负责人 ID" />
                          </Form.Item>
                          <Form.Item label="客户姓名" name="customerName">
                            <Input allowClear placeholder="客户姓名" />
                          </Form.Item>
                          <Form.Item label="订单编号" name="orderNo">
                            <Input allowClear placeholder="订单编号" />
                          </Form.Item>
                          <Form.Item>
                            <Space>
                              <ActionButton icon={<ReloadOutlined />} onClick={loadCases} permission="collection:view" permissions={permissions}>
                                查询
                              </ActionButton>
                              <ActionButton
                                onClick={() => {
                                  caseFilterForm.resetFields();
                                  void loadCases();
                                }}
                                permission="collection:view"
                                permissions={permissions}
                              >
                                重置
                              </ActionButton>
                            </Space>
                          </Form.Item>
                        </Form>
                        <Table
                          columns={caseColumns}
                          dataSource={cases}
                          loading={loadingCases}
                          pagination={{ pageSize: 20, showSizeChanger: true }}
                          rowKey={(record) => record.id}
                          scroll={{ x: 1900 }}
                          size="small"
                        />
                      </Space>
                    </Card>
                  ),
                  key: "cases",
                  label: "催收案件"
                }
              ]}
            />
          </>
        ) : null}

        <Drawer
          destroyOnHidden
          extra={
            selectedCase ? (
              <Space>
                <ActionButton
                  availability={getActionCreateAvailability(selectedCase)}
                  icon={<PlusOutlined />}
                  onClick={() => openActionModal(selectedCase.id)}
                >
                  新增跟进记录
                </ActionButton>
                <ActionButton
                  availability={getCloseAvailability(selectedCase, true)}
                  icon={<CloseCircleOutlined />}
                  onClick={() => openCloseModal(selectedCase)}
                >
                  关闭案件
                </ActionButton>
              </Space>
            ) : null
          }
          onClose={() => {
            setDetailOpen(false);
            setSelectedCase(null);
          }}
          open={detailOpen}
          size="large"
          title="催收案件详情"
        >
          {selectedCase ? (
            <Space orientation="vertical" size={16} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "案件编号", children: safeText(selectedCase.caseNo) },
                  { label: "客户", children: formatCustomer(selectedCase.customer) },
                  { label: "订单编号", children: formatOrderLink(selectedCase.order) },
                  { label: "逾期总金额", children: formatYuan(selectedCase.totalOverdueAmount) },
                  { label: "最大逾期天数", children: safeText(selectedCase.maxOverdueDays) },
                  { label: "逾期等级", children: formatTag(COLLECTION_LEVEL_LABELS, selectedCase.collectionLevel, levelColors) },
                  { label: "案件状态", children: formatTag(COLLECTION_CASE_STATUS_LABELS, selectedCase.caseStatus, caseStatusColors) },
                  { label: "负责人", children: safeText(selectedCase.assignedTo) },
                  { label: "下次跟进时间", children: formatDateTime(selectedCase.nextFollowUpAt) },
                  { label: "创建时间", children: formatDateTime(selectedCase.createdAt) },
                  { label: "关闭时间", children: formatDateTime(selectedCase.closedAt) },
                  { label: "关闭原因", children: safeText(selectedCase.closeReason) }
                ]}
                title="案件基础信息"
              />
              <Table
                columns={detailBillColumns}
                dataSource={selectedCase.bills}
                pagination={false}
                rowKey={(record, index) => `${record.billId ?? "bill"}-${index}`}
                scroll={{ x: 1030 }}
                size="small"
                title={() => "关联逾期账单"}
              />
              <Table
                columns={actionColumns}
                dataSource={selectedCase.actions}
                pagination={{ pageSize: 8 }}
                rowKey={(record) => record.id}
                scroll={{ x: 1480 }}
                size="small"
                title={() => "催收动作记录"}
              />
            </Space>
          ) : (
            <Alert showIcon title={detailLoading ? "正在加载案件详情" : "请选择催收案件"} type="info" />
          )}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="提交"
          onCancel={() => setActionModalOpen(false)}
          onOk={submitAction}
          open={actionModalOpen}
          confirmLoading={submittingAction}
          title="新增跟进记录"
          width={720}
        >
          <Form form={actionForm} layout="vertical">
            <Form.Item label="动作类型" name="actionType" rules={[{ required: true, message: "请选择动作类型" }]}>
              <Select options={optionsFromLabels(COLLECTION_ACTION_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="联系方式" name="contactMethod" rules={[{ required: true, message: "请选择联系方式" }]}>
              <Select options={optionsFromLabels(CONTACT_METHOD_LABELS)} />
            </Form.Item>
            <Form.Item label="动作结果" name="actionResult" rules={[{ required: true, message: "请选择动作结果" }]}>
              <Select options={optionsFromLabels(COLLECTION_ACTION_RESULT_LABELS)} />
            </Form.Item>
            <Form.Item label="跟进内容" name="content">
              <Input.TextArea rows={4} />
            </Form.Item>
            <Space align="start" size={16}>
              <Form.Item label="承诺付款日期" name="promisedPayAt">
                <DatePicker />
              </Form.Item>
              <Form.Item label="承诺付款金额" name="promisedAmountYuan">
                <InputNumber min={0.01} precision={2} addonBefore="¥" style={{ width: 180 }} />
              </Form.Item>
              <Form.Item label="下次跟进时间" name="nextFollowUpAt">
                <DatePicker showTime />
              </Form.Item>
            </Space>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="关闭案件"
          onCancel={() => setCloseModalOpen(false)}
          onOk={submitClose}
          open={closeModalOpen}
          confirmLoading={submittingClose}
          title="关闭催收案件"
        >
          <Form form={closeForm} layout="vertical">
            <Form.Item label="关闭原因" name="closeReason" rules={[{ required: true, message: "请填写关闭原因" }]}>
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
