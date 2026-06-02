"use client";

import {
  CarOutlined,
  DollarOutlined,
  HistoryOutlined,
  ReloadOutlined,
  SyncOutlined
} from "@ant-design/icons";
import {
  App,
  Button,
  DatePicker,
  Empty,
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
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { SALE_PRICE_REVIEW_TYPE_LABELS, STATUS_LABELS, labelOf } from "../../constants/labels";
import { apiFetch, ApiError } from "../../lib/api";

interface Vehicle {
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount?: number | null;
  currentSalePriceInitializedAt?: string | null;
  currentSalePriceReviewedAt?: string | null;
  id: string;
  model?: string | null;
  modelYear?: number | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  salePriceHistories?: SalePriceHistory[];
  salePriceReinitRequiredAt?: string | null;
  salePriceStatus: string;
  series?: string | null;
  status: string;
  vehicleModel?: string | null;
  vehicleNo: string;
  vin?: string | null;
}

interface SalePriceHistory {
  afterSalePriceAmount: number;
  beforeSalePriceAmount?: number | null;
  createdAt: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  id: string;
  reason: string;
  remark?: string | null;
  reviewQuarter?: string | null;
  reviewType: string;
}

interface InitializeSalePriceValues {
  currentSalePriceAmountYuan: number;
  effectiveFrom: Dayjs;
  reason: string;
  remark?: string | null;
  reviewType: "INITIAL_POOL" | "RETURN_REINIT";
}

interface ReviewSalePriceValues {
  effectiveFrom: Dayjs;
  newSalePriceAmountYuan: number;
  reason: string;
  remark?: string | null;
  reviewQuarter: string;
}

interface StatusValues {
  remark?: string | null;
  status: string;
}

const salePriceStatusColors: Record<string, string> = {
  EFFECTIVE: "green",
  EXPIRED: "default",
  PENDING_INITIALIZE: "orange",
  REVIEW_DUE: "red"
};

const vehicleStatusColors: Record<string, string> = {
  AVAILABLE: "green",
  DRAFT: "default",
  IN_PREPARATION: "gold",
  LEASED: "purple",
  MAINTENANCE: "orange",
  RENTED: "purple",
  RESERVED: "blue",
  RETIRED: "default",
  RETURNED: "volcano"
};

const vehicleStatusOptions = [
  "DRAFT",
  "IN_PREPARATION",
  "AVAILABLE",
  "RESERVED",
  "LEASED",
  "RENTED",
  "RETURNED",
  "MAINTENANCE",
  "RETIRED"
].map((value) => ({ label: labelOf(STATUS_LABELS, value), value }));

const returnReinitSourceStatuses = new Set(["LEASED", "RENTED", "RESERVED", "RETURNED", "MAINTENANCE"]);

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function formatDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function toCents(value: number) {
  return Math.round(value * 100);
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function vehicleModelText(vehicle: Vehicle) {
  return [vehicle.brand, vehicle.series, vehicle.model, vehicle.vehicleModel].filter(Boolean).join(" / ") || "-";
}

function toReviewQuarter(date: Dayjs) {
  return `${date.year()}Q${Math.floor(date.month() / 3) + 1}`;
}

export default function VehiclesPage() {
  const { message } = App.useApp();
  const [initializeForm] = Form.useForm<InitializeSalePriceValues>();
  const [reviewForm] = Form.useForm<ReviewSalePriceValues>();
  const [statusForm] = Form.useForm<StatusValues>();
  const [activeTab, setActiveTab] = useState("vehicles");
  const [dueReviews, setDueReviews] = useState<Vehicle[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<SalePriceHistory[]>([]);
  const [historyVehicle, setHistoryVehicle] = useState<Vehicle | null>(null);
  const [initializingVehicle, setInitializingVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewingVehicle, setReviewingVehicle] = useState<Vehicle | null>(null);
  const [statusVehicle, setStatusVehicle] = useState<Vehicle | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [vehicleRows, dueRows] = await Promise.all([
        apiFetch<Vehicle[]>("/vehicles"),
        apiFetch<Vehicle[]>("/vehicles/sale-price-reviews/due")
      ]);
      setVehicles(vehicleRows);
      setDueReviews(dueRows);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const columns = useMemo(
    () => buildVehicleColumns(openInitialize, openReview, openHistory, openStatus),
    []
  );

  function openInitialize(vehicle: Vehicle) {
    const reviewType =
      vehicle.currentSalePriceAmount || returnReinitSourceStatuses.has(vehicle.status)
        ? "RETURN_REINIT"
        : "INITIAL_POOL";
    setInitializingVehicle(vehicle);
    initializeForm.setFieldsValue({
      currentSalePriceAmountYuan: vehicle.currentSalePriceAmount
        ? vehicle.currentSalePriceAmount / 100
        : undefined,
      effectiveFrom: dayjs(),
      reason: reviewType === "RETURN_REINIT" ? "合同终止退回后重新入池" : "新入池初始化",
      reviewType
    });
  }

  function openReview(vehicle: Vehicle) {
    const effectiveFrom = vehicle.nextSalePriceReviewAt ? dayjs(vehicle.nextSalePriceReviewAt) : dayjs();
    setReviewingVehicle(vehicle);
    reviewForm.setFieldsValue({
      effectiveFrom,
      newSalePriceAmountYuan: vehicle.currentSalePriceAmount ? vehicle.currentSalePriceAmount / 100 : undefined,
      reason: "季度市场价格复核",
      reviewQuarter: toReviewQuarter(effectiveFrom)
    });
  }

  async function openHistory(vehicle: Vehicle) {
    setHistoryVehicle(vehicle);
    setActiveTab("history");
    setHistoryLoading(true);
    try {
      setHistoryRows(await apiFetch<SalePriceHistory[]>(`/vehicles/${vehicle.id}/sale-price-history`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  }

  function openStatus(vehicle: Vehicle) {
    setStatusVehicle(vehicle);
    statusForm.setFieldsValue({ remark: vehicle.salePriceReinitRequiredAt ? "退回车辆重新入池" : undefined, status: vehicle.status });
  }

  async function saveInitialize(values: InitializeSalePriceValues) {
    if (!initializingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${initializingVehicle.id}/initialize-sale-price`, {
        body: JSON.stringify({
          currentSalePriceAmount: toCents(values.currentSalePriceAmountYuan),
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          reason: values.reason,
          remark: values.remark,
          reviewType: values.reviewType
        }),
        method: "POST"
      });
      void message.success(values.reviewType === "RETURN_REINIT" ? "退车再入池销售价已初始化" : "销售价已初始化");
      setInitializingVehicle(null);
      initializeForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function saveReview(values: ReviewSalePriceValues) {
    if (!reviewingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${reviewingVehicle.id}/review-sale-price`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          newSalePriceAmount: toCents(values.newSalePriceAmountYuan),
          reason: values.reason,
          remark: values.remark,
          reviewQuarter: values.reviewQuarter
        }),
        method: "POST"
      });
      void message.success("季度销售价复核已保存");
      setReviewingVehicle(null);
      reviewForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function saveStatus(values: StatusValues) {
    if (!statusVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${statusVehicle.id}/update-status`, {
        body: JSON.stringify(values),
        method: "POST"
      });
      void message.success("车辆状态已更新");
      setStatusVehicle(null);
      statusForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              车辆资产
            </Typography.Title>
            <Typography.Text type="secondary">销售价初始化、季度复核与退车再入池管理</Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
            刷新
          </Button>
        </Space>

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              children: <VehicleTable columns={columns} loading={loading} rows={vehicles} />,
              key: "vehicles",
              label: "车辆列表"
            },
            {
              children: <VehicleTable columns={columns} loading={loading} rows={dueReviews} />,
              key: "due",
              label: `待销售价复核 (${dueReviews.length})`
            },
            {
              children: (
                <HistoryTable
                  loading={historyLoading}
                  rows={historyRows}
                  vehicle={historyVehicle}
                />
              ),
              key: "history",
              label: "销售价历史"
            }
          ]}
        />
      </Space>

      <Modal
        okText="保存"
        onCancel={() => setInitializingVehicle(null)}
        onOk={() => initializeForm.submit()}
        open={Boolean(initializingVehicle)}
        title={initializingVehicle ? `${initializingVehicle.vehicleNo} 初始化销售价` : "初始化销售价"}
        width={620}
      >
        <Form<InitializeSalePriceValues> form={initializeForm} layout="vertical" onFinish={saveInitialize}>
          <Form.Item label="初始化类型" name="reviewType" rules={[{ required: true, message: "请选择初始化类型" }]}>
            <Select
              options={[
                { label: "新入池初始化", value: "INITIAL_POOL" },
                { label: "退车再入池初始化", value: "RETURN_REINIT" }
              ]}
              onChange={(value) =>
                initializeForm.setFieldValue(
                  "reason",
                  value === "RETURN_REINIT" ? "合同终止退回后重新入池" : "新入池初始化"
                )
              }
            />
          </Form.Item>
          <Form.Item
            label="当前销售价（元）"
            name="currentSalePriceAmountYuan"
            rules={[{ required: true, message: "请输入当前销售价" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setReviewingVehicle(null)}
        onOk={() => reviewForm.submit()}
        open={Boolean(reviewingVehicle)}
        title={reviewingVehicle ? `${reviewingVehicle.vehicleNo} 季度复核` : "季度复核"}
        width={620}
      >
        <Form<ReviewSalePriceValues> form={reviewForm} layout="vertical" onFinish={saveReview}>
          <Form.Item
            label="新销售价（元）"
            name="newSalePriceAmountYuan"
            rules={[{ required: true, message: "请输入新销售价" }]}
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="复核季度" name="reviewQuarter" rules={[{ required: true, message: "请输入复核季度" }]}>
            <Input placeholder="2026Q3" />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker
              style={{ width: "100%" }}
              onChange={(value) => {
                if (value) {
                  reviewForm.setFieldValue("reviewQuarter", toReviewQuarter(value));
                }
              }}
            />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setStatusVehicle(null)}
        onOk={() => statusForm.submit()}
        open={Boolean(statusVehicle)}
        title={statusVehicle ? `${statusVehicle.vehicleNo} 更新状态` : "更新状态"}
        width={520}
      >
        <Form<StatusValues> form={statusForm} layout="vertical" onFinish={saveStatus}>
          <Form.Item label="车辆状态" name="status" rules={[{ required: true, message: "请选择车辆状态" }]}>
            <Select options={vehicleStatusOptions} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

function VehicleTable({
  columns,
  loading,
  rows
}: Readonly<{
  columns: ColumnsType<Vehicle>;
  loading: boolean;
  rows: Vehicle[];
}>) {
  return (
    <Table
      columns={columns}
      dataSource={rows}
      loading={loading}
      rowKey="id"
      scroll={{ x: 1380 }}
    />
  );
}

function HistoryTable({
  loading,
  rows,
  vehicle
}: Readonly<{
  loading: boolean;
  rows: SalePriceHistory[];
  vehicle: Vehicle | null;
}>) {
  if (!vehicle) {
    return <Empty description="请在车辆列表中选择查看历史" />;
  }

  const columns: ColumnsType<SalePriceHistory> = [
    { dataIndex: "reviewType", render: (value: string) => labelOf(SALE_PRICE_REVIEW_TYPE_LABELS, value), title: "类型", width: 150 },
    { dataIndex: "reviewQuarter", title: "季度", width: 110 },
    { dataIndex: "beforeSalePriceAmount", render: formatYuan, title: "复核前销售价", width: 150 },
    { dataIndex: "afterSalePriceAmount", render: formatYuan, title: "复核后销售价", width: 150 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "reason", title: "原因", width: 260 },
    { dataIndex: "createdAt", render: formatDateTime, title: "记录时间", width: 170 }
  ];

  return (
    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        {vehicle.vehicleNo} / {vehicle.plateNo ?? vehicle.vin ?? "-"}
      </Typography.Text>
      <Table columns={columns} dataSource={rows} loading={loading} rowKey="id" scroll={{ x: 1100 }} />
    </Space>
  );
}

function buildVehicleColumns(
  openInitialize: (vehicle: Vehicle) => void,
  openReview: (vehicle: Vehicle) => void,
  openHistory: (vehicle: Vehicle) => void,
  openStatus: (vehicle: Vehicle) => void
): ColumnsType<Vehicle> {
  return [
    { dataIndex: "vin", render: (value: string | null) => value ?? "-", title: "VIN", width: 180 },
    { dataIndex: "plateNo", render: (value: string | null) => value ?? "-", title: "车牌号", width: 120 },
    { render: (_, record) => vehicleModelText(record), title: "车型", width: 220 },
    { dataIndex: "currentSalePriceAmount", render: formatYuan, title: "当前销售价", width: 140 },
    { dataIndex: "currentSalePriceReviewedAt", render: formatDateTime, title: "最近复核时间", width: 170 },
    { dataIndex: "nextSalePriceReviewAt", render: formatDate, title: "下次复核时间", width: 140 },
    {
      dataIndex: "salePriceStatus",
      render: (value: string) => <Tag color={salePriceStatusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>,
      title: "销售价状态",
      width: 130
    },
    {
      dataIndex: "status",
      render: (value: string) => <Tag color={vehicleStatusColors[value] ?? "default"}>{labelOf(STATUS_LABELS, value)}</Tag>,
      title: "车辆状态",
      width: 120
    },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button icon={<DollarOutlined />} onClick={() => openInitialize(record)} size="small">
            初始化销售价
          </Button>
          <Button
            disabled={!record.currentSalePriceAmount}
            icon={<SyncOutlined />}
            onClick={() => openReview(record)}
            size="small"
          >
            季度复核
          </Button>
          <Button icon={<HistoryOutlined />} onClick={() => openHistory(record)} size="small">
            查看历史
          </Button>
          <Button icon={<CarOutlined />} onClick={() => openStatus(record)} size="small">
            更新状态
          </Button>
        </Space>
      ),
      title: "操作",
      width: 430
    }
  ];
}
