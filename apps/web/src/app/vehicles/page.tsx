"use client";

import {
  CarOutlined,
  DollarOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined
} from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
  DatePicker,
  Descriptions,
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

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import { SALE_PRICE_REVIEW_TYPE_LABELS, STATUS_LABELS, VEHICLE_BATTERY_USAGE_TYPE_LABELS, labelOf } from "../../constants/labels";
import {
  actionAvailability,
  canInitializeVehicleSalePrice,
  canReviewVehicleSalePrice,
  canUpdateVehicleStatus
} from "../../lib/action-guards";
import { apiFetch, ApiError } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";

interface Vehicle {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  batteryUsageTypeLabel?: string | null;
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
  purchaseDate?: string | null;
  purchasePriceAmount: number;
  remark?: string | null;
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

interface CreateVehicleValues {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: "BUYOUT" | "BAAS";
  brand: string;
  currentMileageKm?: number;
  model?: string | null;
  modelYear?: number | null;
  plateNo?: string | null;
  purchaseDate?: Dayjs | null;
  purchasePriceAmountYuan: number;
  remark?: string | null;
  series?: string | null;
  vehicleModel: "ET5" | "ET7" | "ES6";
  vin: string;
}

type EditVehicleValues = CreateVehicleValues;

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
  "RETURNED",
  "MAINTENANCE",
  "RETIRED"
].map((value) => ({ label: labelOf(STATUS_LABELS, value), value }));

const vehicleModelOptions = ["ET5", "ET7", "ES6"].map((value) => ({ label: value, value }));

const batteryUsageTypeOptions = [
  { label: "电池买断", value: "BUYOUT" },
  { label: "BaaS / 电池租用", value: "BAAS" }
];

const returnReinitSourceStatuses = new Set(["RETURNED", "MAINTENANCE"]);

function formatYuan(value?: number | null) {
  return value === undefined || value === null ? "-" : `¥${(value / 100).toFixed(2)}`;
}

function formatKwh(value?: number | null) {
  return value === undefined || value === null ? "-" : `${value.toLocaleString("zh-CN")} kWh`;
}

function batteryUsageTypeLabel(vehicle: Pick<Vehicle, "batteryUsageType" | "batteryUsageTypeLabel">) {
  return vehicle.batteryUsageTypeLabel ?? (vehicle.batteryUsageType ? labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, vehicle.batteryUsageType) : "-");
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

function isReturnReinitVehicle(vehicle: Pick<Vehicle, "status"> | null | undefined) {
  return Boolean(vehicle && returnReinitSourceStatuses.has(vehicle.status));
}

function hasReturnReinitForCurrentPool(vehicle: Vehicle) {
  const latestReturnReinit = vehicle.salePriceHistories?.find((history) => history.reviewType === "RETURN_REINIT");
  if (!latestReturnReinit) {
    return false;
  }
  if (!vehicle.salePriceReinitRequiredAt) {
    return true;
  }
  return dayjs(latestReturnReinit.createdAt).valueOf() >= dayjs(vehicle.salePriceReinitRequiredAt).valueOf();
}

function canRelistAfterReturn(vehicle: Vehicle) {
  return Boolean(
    isReturnReinitVehicle(vehicle) &&
      vehicle.currentSalePriceAmount &&
      vehicle.currentSalePriceAmount > 0 &&
      vehicle.salePriceStatus === "EFFECTIVE" &&
      hasReturnReinitForCurrentPool(vehicle)
  );
}

function getReturnReinitNotice(vehicle: Vehicle) {
  if (!isReturnReinitVehicle(vehicle)) {
    return null;
  }

  if (canRelistAfterReturn(vehicle)) {
    return "退车再入池重新定价已完成，可确认整备完成后设置为可租用。";
  }

  return vehicle.status === "MAINTENANCE"
    ? "该车辆维修中，完成整备并通过 RETURN_REINIT 重新初始化当前销售价后才能再次入池。"
    : "该车辆已退回，需重新初始化当前销售价后才能再次入池。";
}

function statusOptionsForVehicle(vehicle: Vehicle | null) {
  if (!vehicle || !isReturnReinitVehicle(vehicle) || canRelistAfterReturn(vehicle)) {
    return vehicleStatusOptions;
  }

  return vehicleStatusOptions.map((option) =>
    option.value === "AVAILABLE"
      ? { ...option, disabled: true, label: `${option.label}（需先 RETURN_REINIT）` }
      : option
  );
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
  const [createForm] = Form.useForm<CreateVehicleValues>();
  const [editForm] = Form.useForm<EditVehicleValues>();
  const [initializeForm] = Form.useForm<InitializeSalePriceValues>();
  const [reviewForm] = Form.useForm<ReviewSalePriceValues>();
  const [statusForm] = Form.useForm<StatusValues>();
  const [activeTab, setActiveTab] = useState("vehicles");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [dueReviews, setDueReviews] = useState<Vehicle[]>([]);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRows, setHistoryRows] = useState<SalePriceHistory[]>([]);
  const [historyVehicle, setHistoryVehicle] = useState<Vehicle | null>(null);
  const [initializingVehicle, setInitializingVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(false);
  const [reviewingVehicle, setReviewingVehicle] = useState<Vehicle | null>(null);
  const [statusVehicle, setStatusVehicle] = useState<Vehicle | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [vehicleRows, dueRows, nextMe] = await Promise.all([
        apiFetch<Vehicle[]>("/vehicles"),
        apiFetch<Vehicle[]>("/vehicles/sale-price-reviews/due"),
        apiFetch<AuthMeResponse>("/auth/me")
      ]);
      setVehicles(vehicleRows);
      setDueReviews(dueRows);
      setMe(nextMe);
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
    () => buildVehicleColumns(openDetail, openEditVehicle, openInitialize, openReview, openHistory, openStatus, relistVehicle, permissions),
    [permissions]
  );

  function openCreateVehicle() {
    setCreateOpen(true);
    createForm.setFieldsValue({
      brand: "NIO",
      batteryUsageType: "BUYOUT",
      currentMileageKm: 0,
      vehicleModel: "ET5"
    });
  }

  async function saveCreateVehicle(values: CreateVehicleValues) {
    try {
      await apiFetch<Vehicle>("/vehicles", {
        body: JSON.stringify({
          assetLocation: values.assetLocation,
          batteryCapacityKwh: values.batteryCapacityKwh,
          batteryUsageType: values.batteryUsageType,
          brand: values.brand,
          currentMileageKm: values.currentMileageKm ?? 0,
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
          remark: values.remark,
          series: values.series,
          vehicleModel: values.vehicleModel,
          vin: values.vin
        }),
        method: "POST"
      });
      void message.success("车辆已创建");
      setCreateOpen(false);
      createForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openDetail(vehicle: Vehicle) {
    setDetailVehicle(vehicle);
  }

  function openEditVehicle(vehicle: Vehicle) {
    setEditingVehicle(vehicle);
    editForm.setFieldsValue({
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: vehicle.batteryCapacityKwh,
      batteryUsageType: (vehicle.batteryUsageType ?? "BUYOUT") as "BUYOUT" | "BAAS",
      brand: vehicle.brand,
      currentMileageKm: vehicle.currentMileageKm,
      model: vehicle.model,
      modelYear: vehicle.modelYear,
      plateNo: vehicle.plateNo,
      purchaseDate: vehicle.purchaseDate ? dayjs(vehicle.purchaseDate) : null,
      purchasePriceAmountYuan: vehicle.purchasePriceAmount / 100,
      remark: vehicle.remark,
      series: vehicle.series,
      vehicleModel: (vehicle.vehicleModel ?? "ET5") as "ET5" | "ET7" | "ES6",
      vin: vehicle.vin ?? ""
    });
  }

  async function saveEditVehicle(values: EditVehicleValues) {
    if (!editingVehicle) {
      return;
    }
    try {
      await apiFetch<Vehicle>(`/vehicles/${editingVehicle.id}`, {
        body: JSON.stringify({
          assetLocation: values.assetLocation,
          batteryCapacityKwh: values.batteryCapacityKwh,
          batteryUsageType: values.batteryUsageType,
          brand: values.brand,
          currentMileageKm: values.currentMileageKm ?? 0,
          model: values.model,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCents(values.purchasePriceAmountYuan),
          remark: values.remark,
          series: values.series,
          vehicleModel: values.vehicleModel,
          vin: values.vin
        }),
        method: "PATCH"
      });
      void message.success("车辆已更新");
      setEditingVehicle(null);
      editForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openInitialize(vehicle: Vehicle) {
    const reviewType = isReturnReinitVehicle(vehicle) ? "RETURN_REINIT" : "INITIAL_POOL";
    setInitializingVehicle(vehicle);
    initializeForm.setFieldsValue({
      currentSalePriceAmountYuan: vehicle.currentSalePriceAmount
        ? vehicle.currentSalePriceAmount / 100
        : undefined,
      effectiveFrom: dayjs(),
      reason: reviewType === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化",
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
      void message.success(values.reviewType === "RETURN_REINIT" ? "退车再入池重新定价已完成" : "销售价已初始化");
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

  async function relistVehicle(vehicle: Vehicle) {
    try {
      await apiFetch<Vehicle>(`/vehicles/${vehicle.id}/update-status`, {
        body: JSON.stringify({
          remark: "退车整备完成后重新入池",
          status: "AVAILABLE"
        }),
        method: "POST"
      });
      void message.success("车辆已设置为可租用");
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
          <Space>
            <ActionButton
              icon={<PlusOutlined />}
              onClick={openCreateVehicle}
              permission="vehicle:create"
              permissions={permissions}
              type="primary"
            >
              新增车辆
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
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
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="新增车辆"
        width={720}
      >
        <Form<CreateVehicleValues> form={createForm} layout="vertical" onFinish={saveCreateVehicle}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车牌号" name="plateNo">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车系" name="series">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型" name="model">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型代码" name="vehicleModel" rules={[{ required: true, message: "请选择车型代码" }]}>
            <Select options={vehicleModelOptions} />
          </Form.Item>
          <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh" rules={[{ required: true, message: "请输入电池容量" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="电池使用方式" name="batteryUsageType" rules={[{ required: true, message: "请选择电池使用方式" }]}>
            <Select options={batteryUsageTypeOptions} />
          </Form.Item>
          <Form.Item label="年款" name="modelYear">
            <InputNumber min={1900} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购价（元）" name="purchasePriceAmountYuan" rules={[{ required: true, message: "请输入采购价" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购日期" name="purchaseDate">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="当前里程" name="currentMileageKm">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="资产位置" name="assetLocation">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        footer={null}
        onCancel={() => setDetailVehicle(null)}
        open={Boolean(detailVehicle)}
        title={detailVehicle ? `${detailVehicle.vehicleNo} 车辆详情` : "车辆详情"}
        width={760}
      >
        {detailVehicle ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            {getReturnReinitNotice(detailVehicle) ? (
              <Alert
                message={getReturnReinitNotice(detailVehicle)}
                showIcon
                type={canRelistAfterReturn(detailVehicle) ? "success" : "warning"}
              />
            ) : null}
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "车辆编号", children: detailVehicle.vehicleNo },
                { label: "VIN", children: detailVehicle.vin ?? "-" },
                { label: "车牌号", children: detailVehicle.plateNo ?? "-" },
                { label: "品牌", children: detailVehicle.brand },
                { label: "车系", children: detailVehicle.series ?? "-" },
                { label: "车型", children: vehicleModelText(detailVehicle) },
                { label: "电池容量", children: formatKwh(detailVehicle.batteryCapacityKwh) },
                { label: "电池使用方式", children: batteryUsageTypeLabel(detailVehicle) },
                { label: "采购价", children: formatYuan(detailVehicle.purchasePriceAmount) },
                { label: "当前销售价", children: formatYuan(detailVehicle.currentSalePriceAmount) },
                { label: "当前里程", children: `${detailVehicle.currentMileageKm.toLocaleString("zh-CN")} km` },
                { label: "车辆状态", children: labelOf(STATUS_LABELS, detailVehicle.status) },
                { label: "销售价状态", children: labelOf(STATUS_LABELS, detailVehicle.salePriceStatus) },
                { label: "资产位置", children: detailVehicle.assetLocation ?? "-" },
                { label: "备注", children: detailVehicle.remark ?? "-" }
              ]}
            />
          </Space>
        ) : null}
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => {
          setEditingVehicle(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        open={Boolean(editingVehicle)}
        title={editingVehicle ? `${editingVehicle.vehicleNo} 编辑车辆` : "编辑车辆"}
        width={720}
      >
        <Form<EditVehicleValues> form={editForm} layout="vertical" onFinish={saveEditVehicle}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车牌号" name="plateNo">
            <Input maxLength={32} />
          </Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车系" name="series">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型" name="model">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车型代码" name="vehicleModel" rules={[{ required: true, message: "请选择车型代码" }]}>
            <Select options={vehicleModelOptions} />
          </Form.Item>
          <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh" rules={[{ required: true, message: "请输入电池容量" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="电池使用方式" name="batteryUsageType" rules={[{ required: true, message: "请选择电池使用方式" }]}>
            <Select options={batteryUsageTypeOptions} />
          </Form.Item>
          <Form.Item label="年款" name="modelYear">
            <InputNumber min={1900} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购价（元）" name="purchasePriceAmountYuan" rules={[{ required: true, message: "请输入采购价" }]}>
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="采购日期" name="purchaseDate">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="当前里程" name="currentMileageKm">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="资产位置" name="assetLocation">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        okText="保存"
        onCancel={() => setInitializingVehicle(null)}
        onOk={() => initializeForm.submit()}
        open={Boolean(initializingVehicle)}
        title={
          initializingVehicle
            ? `${initializingVehicle.vehicleNo} ${isReturnReinitVehicle(initializingVehicle) ? "RETURN_REINIT 重新定价" : "初始化销售价"}`
            : "初始化销售价"
        }
        width={620}
      >
        <Form<InitializeSalePriceValues> form={initializeForm} layout="vertical" onFinish={saveInitialize}>
          <Form.Item label="初始化类型" name="reviewType" rules={[{ required: true, message: "请选择初始化类型" }]}>
            <Select
              options={[
                { label: "新入池初始化", value: "INITIAL_POOL" },
                { label: "退车再入池重新定价", value: "RETURN_REINIT" }
              ]}
              onChange={(value) =>
                initializeForm.setFieldValue(
                  "reason",
                  value === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化"
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
          {statusVehicle && getReturnReinitNotice(statusVehicle) ? (
            <Alert
              message={getReturnReinitNotice(statusVehicle)}
              showIcon
              style={{ marginBottom: 16 }}
              type={canRelistAfterReturn(statusVehicle) ? "success" : "warning"}
            />
          ) : null}
          <Form.Item label="车辆状态" name="status" rules={[{ required: true, message: "请选择车辆状态" }]}>
            <Select options={statusOptionsForVehicle(statusVehicle)} />
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
      scroll={{ x: 1640 }}
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
  openDetail: (vehicle: Vehicle) => void,
  openEdit: (vehicle: Vehicle) => void,
  openInitialize: (vehicle: Vehicle) => void,
  openReview: (vehicle: Vehicle) => void,
  openHistory: (vehicle: Vehicle) => void,
  openStatus: (vehicle: Vehicle) => void,
  relistVehicle: (vehicle: Vehicle) => void,
  permissions: ReadonlySet<string>
): ColumnsType<Vehicle> {
  return [
    { dataIndex: "vin", render: (value: string | null) => value ?? "-", title: "VIN", width: 180 },
    { dataIndex: "plateNo", render: (value: string | null) => value ?? "-", title: "车牌号", width: 120 },
    { render: (_, record) => vehicleModelText(record), title: "车型", width: 220 },
    { dataIndex: "batteryCapacityKwh", render: formatKwh, title: "电池容量", width: 120 },
    { render: (_, record) => batteryUsageTypeLabel(record), title: "电池使用方式", width: 140 },
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
          <Button icon={<EyeOutlined />} onClick={() => openDetail(record)} size="small">
            详情
          </Button>
          <ActionButton
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            permission="vehicle:update"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            availability={canInitializeVehicleSalePrice(record, permissions)}
            icon={<DollarOutlined />}
            onClick={() => openInitialize(record)}
            size="small"
          >
            {isReturnReinitVehicle(record) ? "RETURN_REINIT 重新定价" : "初始化销售价"}
          </ActionButton>
          {isReturnReinitVehicle(record) ? (
            <ActionButton
              availability={actionAvailability({
                allowed: canRelistAfterReturn(record),
                disabledReason: "退回车辆需重新初始化当前销售价后才能入池",
                noPermissionReason: "无更新车辆状态权限",
                permission: "vehicle:update_status",
                permissions
              })}
              icon={<CarOutlined />}
              onClick={() => relistVehicle(record)}
              size="small"
            >
              设置为可租用
            </ActionButton>
          ) : null}
          <ActionButton
            availability={canReviewVehicleSalePrice(record, permissions)}
            icon={<SyncOutlined />}
            onClick={() => openReview(record)}
            size="small"
          >
            季度复核
          </ActionButton>
          <ActionButton
            icon={<HistoryOutlined />}
            onClick={() => openHistory(record)}
            permission="vehicle:history_view"
            permissions={permissions}
            size="small"
          >
            查看历史
          </ActionButton>
          <ActionButton
            availability={canUpdateVehicleStatus(record, permissions)}
            icon={<CarOutlined />}
            onClick={() => openStatus(record)}
            size="small"
          >
            更新状态
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 560
    }
  ];
}
