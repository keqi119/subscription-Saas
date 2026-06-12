"use client";

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined
} from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  SALE_PRICE_REVIEW_TYPE_LABELS,
  VEHICLE_VALUATION_REVIEW_SOURCE_LABELS,
  VEHICLE_VALUATION_REVIEW_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  buildQuery,
  formatDate,
  formatDateTime,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  toCentAmount
} from "../../lib/capital-format";

interface VehicleSummary {
  brand?: string | null;
  currentSalePriceAmount?: number | null;
  currentSalePriceReviewedAt?: string | null;
  id: string;
  model?: string | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  salePriceStatus?: string | null;
  series?: string | null;
  status?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface ForecastSummary {
  asOfDate?: string | null;
  forecastNo?: string | null;
  forecastStatus?: string | null;
  id: string;
  vehicleId?: string | null;
}

interface ForecastPointSummary {
  adoptedResidualAmount?: number | null;
  confidenceScore?: number | null;
  horizonMonth?: number | null;
  id: string;
  pointStatus?: string | null;
  predictedResidualAmount?: number | null;
  targetDate?: string | null;
}

interface VehicleValuationReview {
  adoptedResidualAmount?: number | null;
  approvalSnapshot?: unknown;
  approvedAt?: string | null;
  approvedSalePriceAmount?: number | null;
  beforeSnapshot?: unknown;
  cancelReason?: string | null;
  cancelledAt?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  forecast?: ForecastSummary | null;
  forecastAmountSource?: string | null;
  forecastConfidenceScore?: number | null;
  forecastHorizonMonth?: number | null;
  forecastId?: string | null;
  forecastPoint?: ForecastPointSummary | null;
  forecastPointId?: string | null;
  forecastResidualAmount?: number | null;
  forecastSnapshot?: unknown;
  forecastTargetDate?: string | null;
  id: string;
  originalSalePriceAmount?: number | null;
  reason?: string | null;
  rejectReason?: string | null;
  rejectedAt?: string | null;
  requestedAt?: string | null;
  requestedBy?: string | null;
  requestedSalePriceAmount: number;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewNo: string;
  reviewRemark?: string | null;
  reviewSource: string;
  reviewStatus: string;
  snapshot?: unknown;
  updatedAt?: string | null;
  updatedBy?: string | null;
  vehicle?: VehicleSummary | null;
  vehicleId: string;
}

interface VehicleValuationReviewListResponse {
  items: VehicleValuationReview[];
  page: number;
  pageSize: number;
  total: number;
}

interface SalePriceHistory {
  afterSalePriceAmount?: number | null;
  beforeSalePriceAmount?: number | null;
  createdAt?: string | null;
  effectiveFrom?: string | null;
  id: string;
  reason?: string | null;
  remark?: string | null;
  reviewQuarter?: string | null;
  reviewType?: string | null;
}

interface ReviewFilterValues {
  endDate?: Dayjs | null;
  reviewSource?: string;
  reviewStatus?: string;
  startDate?: Dayjs | null;
  vehicleId?: string;
  vehicleNo?: string;
  vin?: string;
}

interface ApproveReviewValues {
  approvedSalePriceAmountYuan: number;
  reviewRemark?: string | null;
}

interface RejectReviewValues {
  rejectReason: string;
}

interface CancelReviewValues {
  cancelReason: string;
}

const reviewStatusOptions = optionsFromLabels(VEHICLE_VALUATION_REVIEW_STATUS_LABELS);
const reviewSourceOptions = optionsFromLabels(VEHICLE_VALUATION_REVIEW_SOURCE_LABELS);

const reviewStatusColors: Record<string, string> = {
  APPROVED: "green",
  CANCELLED: "default",
  PENDING: "orange",
  REJECTED: "red"
};

const reviewSourceColors: Record<string, string> = {
  MANUAL: "default",
  OTHER: "default",
  QUARTERLY_REVIEW: "blue",
  RESIDUAL_FORECAST: "purple",
  RETURN_REINIT: "cyan"
};

const amountSourceLabels: Record<string, string> = {
  ADOPTED_RESIDUAL: "人工采用残值",
  PREDICTED_RESIDUAL: "预测残值"
};

function formatHorizon(value?: number | null) {
  if (value === undefined || value === null) {
    return "-";
  }
  return value === 0 ? "当前" : `未来 ${value} 个月`;
}

function formatScore(value?: number | null) {
  return value === undefined || value === null ? "-" : `${value} / 100`;
}

function reviewStatusTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={reviewStatusColors[value] ?? "default"}>{labelOf(VEHICLE_VALUATION_REVIEW_STATUS_LABELS, value)}</Tag>;
}

function reviewSourceTag(value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={reviewSourceColors[value] ?? "default"}>{labelOf(VEHICLE_VALUATION_REVIEW_SOURCE_LABELS, value)}</Tag>;
}

function vehicleTitle(vehicle?: VehicleSummary | null) {
  if (!vehicle) {
    return "-";
  }
  return [vehicle.vehicleNo, vehicle.plateNo].filter(Boolean).join(" / ") || vehicle.id;
}

function formatSnapshot(value?: unknown) {
  if (value === undefined || value === null) {
    return "-";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "-";
  }
}

function snapshotPanel(key: string, label: string, value?: unknown) {
  const content = formatSnapshot(value);

  return {
    children:
      content === "-" ? (
        "-"
      ) : (
        <pre style={{ margin: 0, maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {content}
        </pre>
      ),
    key,
    label
  };
}

function buildReviewQuery(values: ReviewFilterValues, page: number, pageSize: number) {
  return buildQuery({
    endDate: values.endDate?.format("YYYY-MM-DD"),
    page,
    pageSize,
    reviewSource: values.reviewSource,
    reviewStatus: values.reviewStatus,
    startDate: values.startDate?.format("YYYY-MM-DD"),
    vehicleId: values.vehicleId?.trim(),
    vehicleNo: values.vehicleNo?.trim(),
    vin: values.vin?.trim()
  });
}

function positiveAmountRule(message: string) {
  return {
    validator: (_: unknown, value?: number | null) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Promise.resolve()
        : Promise.reject(new Error(message))
  };
}

export default function VehicleValuationReviewsPage() {
  const { message } = App.useApp();
  const [filterForm] = Form.useForm<ReviewFilterValues>();
  const [approveForm] = Form.useForm<ApproveReviewValues>();
  const [rejectForm] = Form.useForm<RejectReviewValues>();
  const [cancelForm] = Form.useForm<CancelReviewValues>();
  const [approveTarget, setApproveTarget] = useState<VehicleValuationReview | null>(null);
  const [cancelTarget, setCancelTarget] = useState<VehicleValuationReview | null>(null);
  const [detail, setDetail] = useState<VehicleValuationReview | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<SalePriceHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rejectTarget, setRejectTarget] = useState<VehicleValuationReview | null>(null);
  const [rows, setRows] = useState<VehicleValuationReview[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [total, setTotal] = useState(0);

  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("vehicle_valuation_review:view");
  const canViewHistory = permissions.has("vehicle:history_view");

  const loadSalePriceHistory = useCallback(
    async (vehicleId: string) => {
      if (!canViewHistory) {
        setHistoryRows([]);
        return;
      }

      setHistoryLoading(true);
      try {
        setHistoryRows(await apiFetch<SalePriceHistory[]>(`/vehicles/${vehicleId}/sale-price-history`));
      } catch (error) {
        void message.error(getErrorMessage(error));
        setHistoryRows([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    [canViewHistory, message]
  );

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const review = await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${id}`);
        setDetail(review);
        await loadSalePriceHistory(review.vehicleId);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setDetailLoading(false);
      }
    },
    [loadSalePriceHistory, message]
  );

  const loadReviews = useCallback(
    async (nextPage: number, nextPageSize: number, values?: ReviewFilterValues) => {
      if (!canView) {
        return;
      }

      setLoading(true);
      try {
        const query = buildReviewQuery(values ?? filterForm.getFieldsValue(), nextPage, nextPageSize);
        const result = await apiFetch<VehicleValuationReviewListResponse>(`/vehicle-valuation-reviews${query}`);
        setRows(result.items);
        setTotal(result.total);
        setPage(result.page);
        setPageSize(result.pageSize);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [canView, filterForm, message]
  );

  useEffect(() => {
    async function loadMe() {
      setMeLoading(true);
      try {
        setMe(await apiFetch<AuthMeResponse>("/auth/me"));
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setMeLoading(false);
      }
    }

    void loadMe();
  }, [message]);

  useEffect(() => {
    if (canView) {
      void loadReviews(1, 20);
    }
  }, [canView, loadReviews]);

  function searchReviews() {
    void loadReviews(1, pageSize, filterForm.getFieldsValue());
  }

  function resetFilters() {
    filterForm.resetFields();
    void loadReviews(1, pageSize, {});
  }

  async function refreshAfterAction(reviewId: string) {
    await loadReviews(page, pageSize, filterForm.getFieldsValue());
    if (detailOpen && detail?.id === reviewId) {
      await loadDetail(reviewId);
    }
  }

  function openDetail(review: VehicleValuationReview) {
    setDetail(null);
    setHistoryRows([]);
    setDetailOpen(true);
    void loadDetail(review.id);
  }

  function openApprove(review: VehicleValuationReview) {
    setApproveTarget(review);
    approveForm.setFieldsValue({
      approvedSalePriceAmountYuan: review.requestedSalePriceAmount / 100,
      reviewRemark: review.reviewRemark ?? undefined
    });
  }

  function openReject(review: VehicleValuationReview) {
    setRejectTarget(review);
    rejectForm.resetFields();
  }

  function openCancel(review: VehicleValuationReview) {
    setCancelTarget(review);
    cancelForm.resetFields();
  }

  async function approveReview(values: ApproveReviewValues) {
    if (!approveTarget) {
      return;
    }

    Modal.confirm({
      content: "审核通过后将更新车辆当前销售价，并写入车辆销售价历史。",
      okText: "确认通过",
      onOk: async () => {
        setSubmitting(true);
        try {
          await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${approveTarget.id}/approve`, {
            body: JSON.stringify({
              approvedSalePriceAmount: toCentAmount(values.approvedSalePriceAmountYuan),
              reviewRemark: values.reviewRemark
            }),
            method: "POST"
          });
          void message.success("估值复核已通过，车辆当前销售价已更新。");
          const reviewId = approveTarget.id;
          setApproveTarget(null);
          approveForm.resetFields();
          await refreshAfterAction(reviewId);
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setSubmitting(false);
        }
      },
      title: "确认审核通过该车辆估值复核？"
    });
  }

  async function rejectReview(values: RejectReviewValues) {
    if (!rejectTarget) {
      return;
    }

    Modal.confirm({
      content: "拒绝后不会修改车辆当前销售价，也不会写入销售价历史。",
      okText: "确认拒绝",
      onOk: async () => {
        setSubmitting(true);
        try {
          await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${rejectTarget.id}/reject`, {
            body: JSON.stringify({ rejectReason: values.rejectReason }),
            method: "POST"
          });
          void message.success("估值复核已拒绝");
          const reviewId = rejectTarget.id;
          setRejectTarget(null);
          rejectForm.resetFields();
          await refreshAfterAction(reviewId);
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setSubmitting(false);
        }
      },
      title: "确认拒绝该车辆估值复核？"
    });
  }

  async function cancelReview(values: CancelReviewValues) {
    if (!cancelTarget) {
      return;
    }

    Modal.confirm({
      content: "取消后不会修改车辆当前销售价，也不会写入销售价历史。",
      okText: "确认取消",
      onOk: async () => {
        setSubmitting(true);
        try {
          await apiFetch<VehicleValuationReview>(`/vehicle-valuation-reviews/${cancelTarget.id}/cancel`, {
            body: JSON.stringify({ cancelReason: values.cancelReason }),
            method: "POST"
          });
          void message.success("估值复核已取消");
          const reviewId = cancelTarget.id;
          setCancelTarget(null);
          cancelForm.resetFields();
          await refreshAfterAction(reviewId);
        } catch (error) {
          void message.error(getErrorMessage(error));
        } finally {
          setSubmitting(false);
        }
      },
      title: "确认取消该车辆估值复核？"
    });
  }

  const columns: ColumnsType<VehicleValuationReview> = [
    { dataIndex: "reviewNo", render: (value: string | null) => value ?? "-", title: "复核编号", width: 190 },
    { render: (_, record) => vehicleTitle(record.vehicle), title: "车辆", width: 180 },
    { render: (_, record) => record.vehicle?.vin ?? "-", title: "VIN", width: 180 },
    { render: (_, record) => record.vehicle?.plateNo ?? "-", title: "车牌号", width: 120 },
    { dataIndex: "reviewSource", render: reviewSourceTag, title: "来源", width: 120 },
    { dataIndex: "reviewStatus", render: reviewStatusTag, title: "状态", width: 110 },
    { dataIndex: "originalSalePriceAmount", render: formatYuan, title: "原销售价", width: 130 },
    { dataIndex: "forecastResidualAmount", render: formatYuan, title: "预测残值", width: 130 },
    { dataIndex: "adoptedResidualAmount", render: formatYuan, title: "人工采用残值", width: 140 },
    { dataIndex: "requestedSalePriceAmount", render: formatYuan, title: "请求销售价", width: 130 },
    { dataIndex: "approvedSalePriceAmount", render: formatYuan, title: "审核通过销售价", width: 150 },
    { dataIndex: "requestedAt", render: formatDateTime, title: "发起时间", width: 160 },
    { dataIndex: "reviewedAt", render: formatDateTime, title: "审核时间", width: 160 },
    { dataIndex: "reason", render: (value: string | null) => value ?? "-", title: "原因", width: 220 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space size={8}>
          <ActionButton
            icon={<EyeOutlined />}
            onClick={() => openDetail(record)}
            permission="vehicle_valuation_review:view"
            permissions={permissions}
            size="small"
          >
            查看详情
          </ActionButton>
          <ActionButton
            allowed={record.reviewStatus === "PENDING"}
            disabledReason="只有待审核复核可以操作。"
            icon={<CheckCircleOutlined />}
            noPermissionReason="缺少审核权限。"
            onClick={() => openApprove(record)}
            permission="vehicle_valuation_review:approve"
            permissions={permissions}
            size="small"
          >
            审核通过
          </ActionButton>
          <ActionButton
            allowed={record.reviewStatus === "PENDING"}
            danger
            disabledReason="只有待审核复核可以操作。"
            icon={<CloseCircleOutlined />}
            noPermissionReason="缺少审核权限。"
            onClick={() => openReject(record)}
            permission="vehicle_valuation_review:approve"
            permissions={permissions}
            size="small"
          >
            审核拒绝
          </ActionButton>
          <ActionButton
            allowed={record.reviewStatus === "PENDING"}
            danger
            disabledReason="只有待审核复核可以操作。"
            icon={<StopOutlined />}
            noPermissionReason="缺少取消权限。"
            onClick={() => openCancel(record)}
            permission="vehicle_valuation_review:create"
            permissions={permissions}
            size="small"
          >
            取消
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 360
    }
  ];

  const historyColumns: ColumnsType<SalePriceHistory> = [
    { dataIndex: "reviewType", render: (value: string | null) => labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, value), title: "类型", width: 150 },
    { dataIndex: "reviewQuarter", render: (value: string | null) => value ?? "-", title: "季度", width: 110 },
    { dataIndex: "beforeSalePriceAmount", render: formatYuan, title: "复核前销售价", width: 150 },
    { dataIndex: "afterSalePriceAmount", render: formatYuan, title: "复核后销售价", width: 150 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "reason", render: (value: string | null) => value ?? "-", title: "原因", width: 260 },
    { dataIndex: "createdAt", render: formatDateTime, title: "记录时间", width: 170 }
  ];

  if (!meLoading && !canView) {
    return (
      <ProtectedShell>
        <Alert message="无车辆估值复核查看权限。" showIcon type="warning" />
      </ProtectedShell>
    );
  }

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              车辆估值复核
            </Typography.Title>
            <Typography.Text type="secondary">
              车辆估值复核用于将残值预测结果纳入内部车辆销售价复核流程。发起复核不会修改车辆当前销售价；只有审核通过后才会更新 Vehicle.currentSalePriceAmount 并写入销售价历史。
            </Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => loadReviews(page, pageSize)}>
            刷新
          </Button>
        </Space>

        <Form<ReviewFilterValues> form={filterForm} layout="inline">
          <Form.Item label="复核状态" name="reviewStatus">
            <Select allowClear options={reviewStatusOptions} placeholder="全部状态" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="复核来源" name="reviewSource">
            <Select allowClear options={reviewSourceOptions} placeholder="全部来源" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="车辆 ID" name="vehicleId">
            <Input allowClear placeholder="车辆 ID" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item label="车辆编号" name="vehicleNo">
            <Input allowClear placeholder="车辆编号" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="VIN" name="vin">
            <Input allowClear placeholder="VIN" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item label="开始日期" name="startDate">
            <DatePicker style={{ width: 140 }} />
          </Form.Item>
          <Form.Item label="结束日期" name="endDate">
            <DatePicker style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Space size={8}>
              <Button icon={<SearchOutlined />} onClick={searchReviews} type="primary">
                查询
              </Button>
              <Button onClick={resetFilters}>重置</Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          columns={columns}
          dataSource={rows}
          loading={loading || meLoading}
          pagination={{
            current: page,
            onChange: (nextPage, nextPageSize) => {
              void loadReviews(nextPage, nextPageSize);
            },
            pageSize,
            showSizeChanger: true,
            total
          }}
          rowKey="id"
          scroll={{ x: 2320 }}
        />
      </Space>

      <Drawer
        extra={
          detail ? (
            <Space size={8}>
              <ActionButton
                allowed={detail.reviewStatus === "PENDING"}
                disabledReason="只有待审核复核可以操作。"
                icon={<CheckCircleOutlined />}
                noPermissionReason="缺少审核权限。"
                onClick={() => openApprove(detail)}
                permission="vehicle_valuation_review:approve"
                permissions={permissions}
                size="small"
              >
                审核通过
              </ActionButton>
              <ActionButton
                allowed={detail.reviewStatus === "PENDING"}
                danger
                disabledReason="只有待审核复核可以操作。"
                icon={<CloseCircleOutlined />}
                noPermissionReason="缺少审核权限。"
                onClick={() => openReject(detail)}
                permission="vehicle_valuation_review:approve"
                permissions={permissions}
                size="small"
              >
                审核拒绝
              </ActionButton>
              <ActionButton
                allowed={detail.reviewStatus === "PENDING"}
                danger
                disabledReason="只有待审核复核可以操作。"
                icon={<StopOutlined />}
                noPermissionReason="缺少取消权限。"
                onClick={() => openCancel(detail)}
                permission="vehicle_valuation_review:create"
                permissions={permissions}
                size="small"
              >
                取消
              </ActionButton>
            </Space>
          ) : null
        }
        onClose={() => setDetailOpen(false)}
        open={detailOpen}
        title={detail ? `${detail.reviewNo} 估值复核详情` : "估值复核详情"}
        width="80vw"
      >
        {detail ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "复核编号", children: detail.reviewNo },
                { label: "复核来源", children: reviewSourceTag(detail.reviewSource) },
                { label: "复核状态", children: reviewStatusTag(detail.reviewStatus) },
                { label: "发起人", children: detail.requestedBy ?? "-" },
                { label: "发起时间", children: formatDateTime(detail.requestedAt) },
                { label: "审核人", children: detail.reviewedBy ?? "-" },
                { label: "审核时间", children: formatDateTime(detail.reviewedAt) },
                { label: "原因", children: detail.reason ?? "-" },
                { label: "复核备注", children: detail.reviewRemark ?? "-" },
                { label: "拒绝原因", children: detail.rejectReason ?? "-" },
                { label: "取消原因", children: detail.cancelReason ?? "-" }
              ]}
              size="small"
              title="复核基础信息"
            />
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "车辆编号", children: detail.vehicle?.vehicleNo ?? "-" },
                { label: "VIN", children: detail.vehicle?.vin ?? "-" },
                { label: "车牌号", children: detail.vehicle?.plateNo ?? "-" },
                { label: "品牌", children: detail.vehicle?.brand ?? "-" },
                { label: "车系", children: detail.vehicle?.series ?? "-" },
                { label: "车型", children: detail.vehicle?.model ?? "-" },
                { label: "年款", children: "-" },
                { label: "当前销售价", children: formatYuan(detail.vehicle?.currentSalePriceAmount) },
                { label: "原销售价", children: formatYuan(detail.originalSalePriceAmount) }
              ]}
              size="small"
              title="车辆摘要"
            />
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "预测编号", children: detail.forecast?.forecastNo ?? "-" },
                { label: "预测点", children: detail.forecastPointId ?? "-" },
                { label: "预测周期", children: formatHorizon(detail.forecastHorizonMonth ?? detail.forecastPoint?.horizonMonth) },
                { label: "目标日期", children: formatDate(detail.forecastTargetDate ?? detail.forecastPoint?.targetDate) },
                { label: "预测残值", children: formatYuan(detail.forecastResidualAmount ?? detail.forecastPoint?.predictedResidualAmount) },
                { label: "人工采用残值", children: formatYuan(detail.adoptedResidualAmount ?? detail.forecastPoint?.adoptedResidualAmount) },
                { label: "置信度", children: formatScore(detail.forecastConfidenceScore ?? detail.forecastPoint?.confidenceScore) },
                { label: "预测值来源", children: labelOf(amountSourceLabels, detail.forecastAmountSource) }
              ]}
              size="small"
              title="残值预测摘要"
            />
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "原销售价", children: formatYuan(detail.originalSalePriceAmount) },
                { label: "预测残值", children: formatYuan(detail.forecastResidualAmount) },
                { label: "人工采用残值", children: formatYuan(detail.adoptedResidualAmount) },
                { label: "请求销售价", children: formatYuan(detail.requestedSalePriceAmount) },
                { label: "审核通过销售价", children: formatYuan(detail.approvedSalePriceAmount) }
              ]}
              size="small"
              title="价格复核信息"
            />
            <Collapse
              items={[
                snapshotPanel("beforeSnapshot", "beforeSnapshot", detail.beforeSnapshot),
                snapshotPanel("forecastSnapshot", "forecastSnapshot", detail.forecastSnapshot),
                snapshotPanel("approvalSnapshot", "approvalSnapshot", detail.approvalSnapshot),
                snapshotPanel("snapshot", "snapshot", detail.snapshot)
              ]}
            />
            {canViewHistory ? (
              <Table
                columns={historyColumns}
                dataSource={historyRows}
                loading={historyLoading || detailLoading}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1110 }}
                size="small"
                title={() => "车辆销售价历史"}
              />
            ) : (
              <Alert message="当前账号无车辆销售价历史查看权限。" showIcon type="info" />
            )}
          </Space>
        ) : (
          <Empty description={detailLoading ? "正在加载估值复核详情" : "暂无估值复核详情"} />
        )}
      </Drawer>

      <Modal
        destroyOnHidden
        okButtonProps={{ loading: submitting }}
        okText="审核通过"
        onCancel={() => setApproveTarget(null)}
        onOk={() => approveForm.submit()}
        open={Boolean(approveTarget)}
        title="审核通过车辆估值复核"
      >
        <Alert
          message="审核通过后将更新车辆当前销售价，并写入车辆销售价历史。"
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
        />
        <Form<ApproveReviewValues> form={approveForm} layout="vertical" onFinish={approveReview}>
          <Form.Item
            label="审核通过销售价（元）"
            name="approvedSalePriceAmountYuan"
            rules={[{ required: true, message: "请输入审核通过销售价" }, positiveAmountRule("审核通过销售价必须大于 0")]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="审核备注" name="reviewRemark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okButtonProps={{ danger: true, loading: submitting }}
        okText="审核拒绝"
        onCancel={() => setRejectTarget(null)}
        onOk={() => rejectForm.submit()}
        open={Boolean(rejectTarget)}
        title="审核拒绝车辆估值复核"
      >
        <Alert
          message="拒绝后不会修改车辆当前销售价，也不会写入销售价历史。"
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
        />
        <Form<RejectReviewValues> form={rejectForm} layout="vertical" onFinish={rejectReview}>
          <Form.Item label="拒绝原因" name="rejectReason" rules={[{ required: true, message: "请输入拒绝原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        okButtonProps={{ danger: true, loading: submitting }}
        okText="取消复核"
        onCancel={() => setCancelTarget(null)}
        onOk={() => cancelForm.submit()}
        open={Boolean(cancelTarget)}
        title="取消车辆估值复核"
      >
        <Alert
          message="取消后不会修改车辆当前销售价，也不会写入销售价历史。"
          showIcon
          style={{ marginBottom: 12 }}
          type="warning"
        />
        <Form<CancelReviewValues> form={cancelForm} layout="vertical" onFinish={cancelReview}>
          <Form.Item label="取消原因" name="cancelReason" rules={[{ required: true, message: "请输入取消原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}
