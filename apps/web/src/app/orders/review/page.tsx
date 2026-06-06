"use client";

import {
  CheckCircleOutlined,
  EyeOutlined,
  FileDoneOutlined,
  ReloadOutlined,
  StopOutlined
} from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import { ORDER_STATUS_LABELS, STATUS_LABELS, VEHICLE_BASE_FEE_MODE_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch, ApiError } from "../../../lib/api";
import { actionAvailability } from "../../../lib/action-guards";
import type { AuthMeResponse } from "../../../lib/auth";

type ReviewDecision = "APPROVED" | "NEED_MORE_INFO" | "REJECTED";
type ReviewType = "credit" | "product" | "vehicle";

interface ReviewOrderRow {
  application?: { applicationNo?: string; status?: string } | null;
  createdAt: string;
  creditReviewStatus?: string | null;
  customer?: { grade?: string | null; name?: string; mobile?: string; status?: string | null } | null;
  customerConfirmedAt?: string | null;
  customerSelectedSnapshot?: unknown;
  depositAmount?: number | null;
  depositStatus?: string | null;
  finalDepositAmount?: number | null;
  finalPlanConfirmedAt?: string | null;
  finalPlanSnapshot?: unknown;
  id: string;
  monthlyFeeAmount?: number | null;
  orderNo: string;
  orderSource: string;
  orderStatus: string;
  periodMonths?: number | null;
  productReviewStatus?: string | null;
  quote?: { id?: string; quoteNo?: string; status?: string } | null;
  quoteSnapshot?: unknown;
  reviewComment?: string | null;
  vehicle?: {
    currentMileageKm?: number | null;
    currentSalePriceAmount?: number | null;
    plateNo?: string | null;
    status?: string | null;
    vehicleModel?: string | null;
    vehicleNo?: string;
    vin?: string | null;
  } | null;
  vehicleModel?: string | null;
  vehicleReviewStatus?: string | null;
}

interface ReviewFormValues {
  creditComment?: string;
  customerGrade?: string;
  productComment?: string;
  rejectComment?: string;
  vehicleComment?: string;
}

interface ReviewActionPayload {
  action: ReviewDecision;
  comment?: string;
  customerGrade?: string;
}

const ORDER_SOURCE_LABELS: Record<string, string> = {
  CUSTOMER_SELF_SERVICE: "客户自动下单",
  SALES_ASSISTED: "销售手动下单"
};

const REVIEW_STATUS_LABELS: Record<string, string> = {
  APPROVED: "已通过",
  NEED_MORE_INFO: "需补充资料",
  PENDING: "待审核",
  REJECTED: "已拒绝"
};

const DEPOSIT_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "押金已确认",
  PENDING_CONFIRM: "押金待确认",
  REJECTED: "押金已拒绝",
  WAIVED: "已免押"
};

const statusColors: Record<string, string> = {
  APPROVED: "green",
  CONFIRMED: "green",
  NEED_MORE_INFO: "orange",
  PENDING: "blue",
  PENDING_CONFIRM: "orange",
  PENDING_CONTRACT: "cyan",
  PENDING_CUSTOMER_CONFIRMATION: "purple",
  PENDING_REVIEW: "blue",
  REJECTED: "red",
  RESERVED: "green",
  REVIEW_RESERVED: "gold",
  WAIVED: "green"
};

const customerGradeOptions = [
  { label: "A", value: "A" },
  { label: "B", value: "B" },
  { label: "C", value: "C" }
];

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function formatYuan(value?: unknown) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }
  return `${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })} 元`;
}

function formatMonths(value?: unknown) {
  const months = toNumber(value);
  return months === null ? "-" : `${months.toLocaleString("zh-CN")} 个月`;
}

function formatTime(value?: unknown) {
  return typeof value === "string" && value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function safeText(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    return "-";
  }
  return String(value);
}

function toNumber(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const number = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return toRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readPath(source: unknown, path: string) {
  let current: unknown = source;
  for (const key of path.split(".")) {
    const record = toRecord(current);
    if (!record || !(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function snapshotValue(source: unknown, ...paths: string[]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function joinText(...values: unknown[]) {
  const parts = values
    .map((value) => safeText(value))
    .filter((value, index, array) => value !== "-" && array.indexOf(value) === index);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function statusLabel(value?: string | null, labels: Record<string, string> = STATUS_LABELS) {
  if (!value) {
    return "-";
  }
  return labels[value] ?? labelOf(STATUS_LABELS, value);
}

function StatusTag({
  labels,
  value
}: {
  labels?: Record<string, string>;
  value?: string | null;
}) {
  return <Tag color={value ? statusColors[value] : undefined}>{statusLabel(value, labels)}</Tag>;
}

function planLabel(record: ReviewOrderRow) {
  return joinText(
    snapshotValue(record.quoteSnapshot, "packageSnapshot.subscriptionPlan.planNo", "subscriptionPlan.planNo"),
    snapshotValue(record.quoteSnapshot, "packageSnapshot.subscriptionPlan.planName", "subscriptionPlan.planName")
  );
}

function vehicleLabel(record: ReviewOrderRow) {
  return joinText(
    record.vehicle?.vehicleNo ?? snapshotValue(record.quoteSnapshot, "vehicleSnapshot.vehicleNo"),
    record.vehicle?.plateNo ?? snapshotValue(record.quoteSnapshot, "vehicleSnapshot.plateNo"),
    record.vehicle?.vin ?? snapshotValue(record.quoteSnapshot, "vehicleSnapshot.vin")
  );
}

function vehicleModelLabel(record: ReviewOrderRow) {
  return safeText(
    record.vehicle?.vehicleModel ??
      record.vehicleModel ??
      snapshotValue(record.quoteSnapshot, "vehicleSnapshot.vehicleModel", "vehicleSnapshot.model", "vehicleModel")
  );
}

function productVersionLabel(record: ReviewOrderRow) {
  return joinText(
    snapshotValue(record.quoteSnapshot, "productVersion.versionNo"),
    snapshotValue(record.quoteSnapshot, "productVersion.versionName")
  );
}

function vehicleBaseFeeModeLabel(record: ReviewOrderRow) {
  const mode = safeText(
    snapshotValue(
      record.quoteSnapshot,
      "vehicleBaseFeeMode",
      "packageSnapshot.pricing.vehicleBaseFeeMode",
      "packageSnapshot.subscriptionPlan.monthlyFeeMode"
    )
  );
  return mode === "-" ? "-" : VEHICLE_BASE_FEE_MODE_LABELS[mode] ?? mode;
}

function packageMonthlyFee(record: ReviewOrderRow) {
  return (
    record.monthlyFeeAmount ??
    snapshotValue(record.quoteSnapshot, "monthlyFeeAmount", "packageSnapshot.pricing.monthlyFeeAmount")
  );
}

function customerSelectedVehicleBaseFee(record: ReviewOrderRow) {
  return snapshotValue(
    record.customerSelectedSnapshot,
    "vehicleBaseFeeAmount",
    "pricing.vehicleBaseFeeAmount"
  ) ?? snapshotValue(record.quoteSnapshot, "vehicleBaseFeeAmount", "packageSnapshot.pricing.vehicleBaseFeeAmount");
}

function canFinalize(record: ReviewOrderRow) {
  return (
    ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(record.orderStatus) &&
    record.creditReviewStatus === "APPROVED" &&
    record.productReviewStatus === "APPROVED" &&
    record.vehicleReviewStatus === "APPROVED" &&
    record.depositStatus === "CONFIRMED" &&
    record.finalDepositAmount !== null &&
    record.finalDepositAmount !== undefined
  );
}

function canShowReviewActions(record: ReviewOrderRow) {
  return record.orderStatus === "PENDING_REVIEW";
}

export default function OrderReviewQueuePage() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<ReviewFormValues>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [orders, setOrders] = useState<ReviewOrderRow[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<ReviewOrderRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const roles = useMemo(() => new Set(me?.user.roles ?? []), [me]);
  const isAdminOrOperator = roles.has("ADMIN") || roles.has("OP") || roles.has("GM");
  const hasReviewPermission = permissions.has("order:review");
  const canReviewCredit = hasReviewPermission && (isAdminOrOperator || roles.has("RC"));
  const canReviewProduct = hasReviewPermission && isAdminOrOperator;
  const canReviewVehicle = hasReviewPermission && (isAdminOrOperator || roles.has("AS"));
  const canRejectOrder = permissions.has("order:reject") || isAdminOrOperator;
  const canConfirmFinalPlan = permissions.has("order:confirm_final_plan");

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOrders, nextMe] = await Promise.all([
        apiFetch<ReviewOrderRow[]>("/orders/review-queue"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setOrders(nextOrders);
      setMe(nextMe);
      return nextOrders;
    } catch (error) {
      void message.error(getErrorMessage(error));
      return [];
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  function openDrawer(record: ReviewOrderRow) {
    setSelectedOrder(record);
    form.setFieldsValue({
      creditComment: record.reviewComment ?? undefined,
      customerGrade: safeText(record.customer?.grade) === "-" ? "A" : safeText(record.customer?.grade),
      productComment: record.reviewComment ?? undefined,
      rejectComment: undefined,
      vehicleComment: record.reviewComment ?? undefined
    });
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    setSelectedOrder(null);
    form.resetFields();
  }

  async function refreshSelected(orderId: string) {
    const nextOrders = await loadOrders();
    const nextSelected = nextOrders.find((order) => order.id === orderId) ?? null;
    setSelectedOrder(nextSelected);
    if (!nextSelected) {
      closeDrawer();
      return;
    }
    form.setFieldsValue({
      customerGrade: safeText(nextSelected.customer?.grade) === "-" ? form.getFieldValue("customerGrade") : safeText(nextSelected.customer?.grade)
    });
  }

  async function submitReview(type: ReviewType, action: ReviewDecision) {
    if (!selectedOrder) {
      return;
    }

    const commentField = `${type}Comment` as "creditComment" | "productComment" | "vehicleComment";
    const payload: ReviewActionPayload = {
      action,
      comment: form.getFieldValue(commentField)
    };

    if (type === "credit" && action === "APPROVED") {
      const values = await form.validateFields(["customerGrade"]);
      payload.customerGrade = values.customerGrade;
    }

    setSubmitting(true);
    try {
      await apiFetch(`/orders/${selectedOrder.id}/reviews/${type}`, {
        body: JSON.stringify(payload),
        method: "POST"
      });
      void message.success("审核状态已更新");
      await refreshSelected(selectedOrder.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function confirmRejectOrder() {
    if (!selectedOrder) {
      return;
    }

    modal.confirm({
      content: "拒绝后订单将终止，审核占用车辆会释放回可用状态。",
      okButtonProps: { danger: true },
      okText: "确认拒绝",
      onOk: () => rejectOrder(),
      title: "拒绝订单申请"
    });
  }

  async function rejectOrder() {
    if (!selectedOrder) {
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch(`/orders/${selectedOrder.id}/reject`, {
        body: JSON.stringify({
          action: "REJECTED",
          comment: form.getFieldValue("rejectComment") ?? "后台审核拒绝"
        }),
        method: "POST"
      });
      void message.success("订单已拒绝，车辆已释放");
      await refreshSelected(selectedOrder.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmFinalPlanFlow(record: ReviewOrderRow) {
    setSubmitting(true);
    try {
      await apiFetch(`/orders/${record.id}/finalize-plan`, { method: "POST" });
      await apiFetch(`/orders/${record.id}/customer-confirm`, { method: "POST" });
      void message.success("最终方案已确认，订单已进入待生成合同");
      await refreshSelected(record.id);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const columns: ColumnsType<ReviewOrderRow> = [
    {
      dataIndex: "orderNo",
      render: (value: string, record) => (
        <Button onClick={() => openDrawer(record)} size="small" type="link">
          {value}
        </Button>
      ),
      title: "订单编号",
      width: 170
    },
    {
      dataIndex: "orderSource",
      render: (value: string) => ORDER_SOURCE_LABELS[value] ?? value,
      title: "订单来源",
      width: 130
    },
    {
      dataIndex: ["customer", "name"],
      render: (value?: string) => safeText(value),
      title: "客户姓名",
      width: 120
    },
    {
      dataIndex: ["customer", "mobile"],
      render: (value?: string) => safeText(value),
      title: "手机号",
      width: 140
    },
    { render: (_, record) => vehicleLabel(record), title: "车辆", width: 210 },
    { render: (_, record) => planLabel(record), title: "套餐", width: 220 },
    {
      dataIndex: "creditReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "客户审核状态",
      width: 130
    },
    {
      dataIndex: "productReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "产品审核状态",
      width: 130
    },
    {
      dataIndex: "vehicleReviewStatus",
      render: (value?: string | null) => <StatusTag labels={REVIEW_STATUS_LABELS} value={value} />,
      title: "车辆审核状态",
      width: 130
    },
    {
      dataIndex: "depositStatus",
      render: (value?: string | null) => <StatusTag labels={DEPOSIT_STATUS_LABELS} value={value} />,
      title: "押金状态",
      width: 130
    },
    {
      dataIndex: "orderStatus",
      render: (value: string) => <StatusTag labels={ORDER_STATUS_LABELS} value={value} />,
      title: "订单状态",
      width: 130
    },
    {
      dataIndex: "createdAt",
      render: formatTime,
      title: "创建时间",
      width: 160
    },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => openDrawer(record)} size="small">
            审核
          </Button>
          <ActionButton
            availability={actionAvailability({
              allowed: canFinalize(record),
              disabledReason: "三项审核通过且押金确认后，才能确认最终方案",
              noPermissionReason: "无确认最终方案权限",
              permission: "order:confirm_final_plan",
              permissions
            })}
            icon={<FileDoneOutlined />}
            onClick={() => confirmFinalPlanFlow(record)}
            size="small"
            type="primary"
          >
            最终确认
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 190
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            旧版订单审核
          </Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={() => loadOrders()} loading={loading}>
            刷新
          </Button>
        </Space>

        <Alert
          message="旧版订单审核入口，后续将迁移至进件审核。新自助进件请在进件管理中审核。"
          showIcon
          type="warning"
        />

        <Table columns={columns} dataSource={orders} loading={loading} rowKey="id" scroll={{ x: 1780 }} />

        <Drawer
          destroyOnHidden
          extra={
            selectedOrder ? (
              <ActionButton
                availability={actionAvailability({
                  allowed: canFinalize(selectedOrder),
                  disabledReason: "三项审核通过且押金确认后，才能确认最终方案",
                  noPermissionReason: "无确认最终方案权限",
                  permission: "order:confirm_final_plan",
                  permissions
                })}
                icon={<FileDoneOutlined />}
                loading={submitting}
                onClick={() => confirmFinalPlanFlow(selectedOrder)}
                type="primary"
              >
                确认最终方案并进入签约
              </ActionButton>
            ) : null
          }
          onClose={closeDrawer}
          open={drawerOpen}
          title={selectedOrder ? `旧版订单审核：${selectedOrder.orderNo}` : "旧版订单审核"}
          width={980}
        >
          {selectedOrder ? (
            <Form form={form} layout="vertical">
              <ReviewDrawerContent
                canConfirmFinalPlan={canConfirmFinalPlan}
                canRejectOrder={canRejectOrder}
                canReviewCredit={canReviewCredit}
                canReviewProduct={canReviewProduct}
                canReviewVehicle={canReviewVehicle}
                loading={submitting}
                onConfirmFinalPlan={() => confirmFinalPlanFlow(selectedOrder)}
                onRejectOrder={confirmRejectOrder}
                onReview={submitReview}
                order={selectedOrder}
              />
            </Form>
          ) : null}
        </Drawer>
      </Space>
    </ProtectedShell>
  );
}

function ReviewDrawerContent({
  canConfirmFinalPlan,
  canRejectOrder,
  canReviewCredit,
  canReviewProduct,
  canReviewVehicle,
  loading,
  onConfirmFinalPlan,
  onRejectOrder,
  onReview,
  order
}: {
  canConfirmFinalPlan: boolean;
  canRejectOrder: boolean;
  canReviewCredit: boolean;
  canReviewProduct: boolean;
  canReviewVehicle: boolean;
  loading: boolean;
  onConfirmFinalPlan: () => Promise<void>;
  onRejectOrder: () => void;
  onReview: (type: ReviewType, action: ReviewDecision) => Promise<void>;
  order: ReviewOrderRow;
}) {
  const reviewEditable = canShowReviewActions(order);

  return (
    <Space orientation="vertical" size={20} style={{ width: "100%" }}>
      <SectionTitle title="客户选择快照" />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "车辆", children: vehicleLabel(order) },
          { label: "套餐", children: planLabel(order) },
          {
            label: "订阅周期",
            children: formatMonths(
              snapshotValue(order.customerSelectedSnapshot, "periodMonths") ??
                snapshotValue(order.quoteSnapshot, "periodMonths") ??
                order.periodMonths
            )
          },
          { label: "车辆基础费", children: formatYuan(customerSelectedVehicleBaseFee(order)) },
          { label: "套餐月费合计", children: formatYuan(packageMonthlyFee(order)) },
          { label: "押金", children: "审核后确认" }
        ]}
      />

      <SectionTitle title="客户资质审核" />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "客户信息", children: joinText(order.customer?.name, order.customer?.mobile) },
          {
            label: "资料状态",
            children: statusLabel(order.application?.status ?? order.customer?.status ?? order.creditReviewStatus, REVIEW_STATUS_LABELS)
          },
          {
            label: "客户等级",
            children: safeText(
              order.customer?.grade ??
                snapshotValue(order.quoteSnapshot, "customerGrade", "depositRuleSnapshot.customerGrade", "depositRuleSnapshot.grade")
            )
          },
          {
            label: "押金规则",
            children: joinText(
              snapshotValue(order.quoteSnapshot, "depositRuleSnapshot.grade", "depositRuleSnapshot.customerGrade"),
              formatYuan(snapshotValue(order.quoteSnapshot, "depositRuleSnapshot.depositAmount"))
            )
          },
          { label: "最终押金", children: formatYuan(order.finalDepositAmount) },
          { label: "审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.creditReviewStatus} /> },
          { label: "审核意见", children: safeText(order.reviewComment) }
        ]}
      />
      {canReviewCredit && reviewEditable ? (
        <Space align="end" wrap>
          <Form.Item label="客户等级" name="customerGrade" rules={[{ required: true, message: "请选择客户等级" }]}>
            <Select options={customerGradeOptions} style={{ width: 120 }} />
          </Form.Item>
          <Form.Item label="审核意见" name="creditComment">
            <Input.TextArea placeholder="填写客户资质审核意见" rows={2} style={{ width: 360 }} />
          </Form.Item>
          <Button icon={<CheckCircleOutlined />} loading={loading} onClick={() => onReview("credit", "APPROVED")} type="primary">
            通过
          </Button>
          <Button loading={loading} onClick={() => onReview("credit", "NEED_MORE_INFO")}>
            补件
          </Button>
          <Button danger icon={<StopOutlined />} loading={loading} onClick={() => onReview("credit", "REJECTED")}>
            拒绝
          </Button>
        </Space>
      ) : null}

      <SectionTitle title="产品匹配审核" />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "套餐信息", children: planLabel(order) },
          { label: "车辆车型", children: vehicleModelLabel(order) },
          {
            label: "产品版本状态",
            children: statusLabel(
              safeText(snapshotValue(order.quoteSnapshot, "productVersion.status", "packageSnapshot.subscriptionPlan.productVersionStatus"))
            )
          },
          {
            label: "套餐状态",
            children: statusLabel(
              safeText(snapshotValue(order.quoteSnapshot, "packageSnapshot.subscriptionPlan.status", "subscriptionPlan.status"))
            )
          },
          { label: "产品版本", children: productVersionLabel(order) },
          { label: "车辆基础月费模式", children: vehicleBaseFeeModeLabel(order) },
          { label: "审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.productReviewStatus} /> }
        ]}
      />
      {canReviewProduct && reviewEditable ? (
        <Space align="end" wrap>
          <Form.Item label="审核意见" name="productComment">
            <Input.TextArea placeholder="填写产品匹配审核意见" rows={2} style={{ width: 420 }} />
          </Form.Item>
          <Button icon={<CheckCircleOutlined />} loading={loading} onClick={() => onReview("product", "APPROVED")} type="primary">
            通过
          </Button>
          <Button danger icon={<StopOutlined />} loading={loading} onClick={() => onReview("product", "REJECTED")}>
            拒绝
          </Button>
        </Space>
      ) : null}

      <SectionTitle title="车辆库存审核" />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "VIN", children: safeText(order.vehicle?.vin ?? snapshotValue(order.quoteSnapshot, "vehicleSnapshot.vin")) },
          { label: "车牌号", children: safeText(order.vehicle?.plateNo ?? snapshotValue(order.quoteSnapshot, "vehicleSnapshot.plateNo")) },
          { label: "车型", children: vehicleModelLabel(order) },
          { label: "车辆状态", children: <StatusTag value={order.vehicle?.status ?? safeText(snapshotValue(order.quoteSnapshot, "vehicleSnapshot.status"))} /> },
          {
            label: "当前销售价",
            children: formatYuan(order.vehicle?.currentSalePriceAmount ?? snapshotValue(order.quoteSnapshot, "vehicleSnapshot.currentSalePriceAmount"))
          },
          { label: "是否 REVIEW_RESERVED", children: order.vehicle?.status === "REVIEW_RESERVED" ? "是" : "否" },
          { label: "审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.vehicleReviewStatus} /> }
        ]}
      />
      {canReviewVehicle && reviewEditable ? (
        <Space align="end" wrap>
          <Form.Item label="审核意见" name="vehicleComment">
            <Input.TextArea placeholder="填写车辆库存审核意见" rows={2} style={{ width: 420 }} />
          </Form.Item>
          <Button icon={<CheckCircleOutlined />} loading={loading} onClick={() => onReview("vehicle", "APPROVED")} type="primary">
            通过
          </Button>
          <Button danger icon={<StopOutlined />} loading={loading} onClick={() => onReview("vehicle", "REJECTED")}>
            拒绝
          </Button>
        </Space>
      ) : null}

      <SectionTitle title="最终方案确认" />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "客户审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.creditReviewStatus} /> },
          { label: "产品审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.productReviewStatus} /> },
          { label: "车辆审核状态", children: <StatusTag labels={REVIEW_STATUS_LABELS} value={order.vehicleReviewStatus} /> },
          { label: "押金状态", children: <StatusTag labels={DEPOSIT_STATUS_LABELS} value={order.depositStatus} /> },
          { label: "最终押金", children: formatYuan(order.finalDepositAmount) },
          { label: "订单状态", children: <StatusTag labels={ORDER_STATUS_LABELS} value={order.orderStatus} /> },
          { label: "最终方案确认时间", children: formatTime(order.finalPlanConfirmedAt) },
          { label: "客户确认时间", children: formatTime(order.customerConfirmedAt) }
        ]}
      />
      <Space align="end" wrap>
        <ActionButton
          availability={actionAvailability({
            allowed: canConfirmFinalPlan && canFinalize(order),
            disabledReason: canConfirmFinalPlan ? "三项审核通过且押金确认后，才能确认最终方案" : "无确认最终方案权限"
          })}
          icon={<FileDoneOutlined />}
          loading={loading}
          onClick={onConfirmFinalPlan}
          type="primary"
        >
          后台确认客户最终方案
        </ActionButton>
        <Form.Item label="拒绝原因" name="rejectComment">
          <Input.TextArea placeholder="填写拒绝原因" rows={2} style={{ width: 360 }} />
        </Form.Item>
        <ActionButton
          availability={actionAvailability({
            allowed: canRejectOrder && ["PENDING_REVIEW", "PENDING_CUSTOMER_CONFIRMATION"].includes(order.orderStatus),
            disabledReason: canRejectOrder ? "当前订单状态不允许拒绝" : "无拒绝订单权限"
          })}
          danger
          icon={<StopOutlined />}
          loading={loading}
          onClick={onRejectOrder}
        >
          拒绝订单
        </ActionButton>
      </Space>
    </Space>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <Typography.Title level={5} style={{ margin: 0 }}>
      {title}
    </Typography.Title>
  );
}
