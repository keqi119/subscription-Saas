"use client";

import { CarOutlined, DollarOutlined, EditOutlined, SyncOutlined } from "@ant-design/icons";
import { Alert, App, DatePicker, Form, Input, InputNumber, Modal, Select, Space } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";

import { ActionButton } from "../action-button";
import { STATUS_LABELS, labelOf } from "../../constants/labels";
import {
  canInitializeVehicleSalePrice,
  canReviewVehicleSalePrice,
  canUpdateVehicleStatus
} from "../../lib/action-guards";
import { apiFetch } from "../../lib/api";
import { getErrorMessage, toCentAmount, yuanFromCents } from "../../lib/capital-format";
import type { VehicleWorkspaceVehicle } from "./vehicle-workspace-types";

interface VehicleModelDefinitionSummary {
  displayName: string;
  id: string;
  modelCode: string;
}

interface VehicleModelDefinitionListResponse {
  items: VehicleModelDefinitionSummary[];
}

interface SalePriceHistorySummary {
  createdAt: string;
  reviewType: string;
}

export interface VehicleDetailRecord extends VehicleWorkspaceVehicle {
  currentSalePriceInitializedAt?: string | null;
  currentSalePriceReviewedAt?: string | null;
  modelDefinitionId?: string | null;
  purchasePriceAmount: number;
  remark?: string | null;
  salePriceHistories?: SalePriceHistorySummary[];
  salePriceReinitRequiredAt?: string | null;
}

interface EditVehicleValues {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: "BUYOUT" | "BAAS";
  brand: string;
  latestRegistrationDate?: Dayjs | null;
  model?: string | null;
  modelDefinitionId?: string | null;
  modelYear?: number | null;
  plateNo?: string | null;
  purchaseDate?: Dayjs | null;
  purchasePriceAmountYuan: number;
  registrationDate?: Dayjs | null;
  remark?: string | null;
  series?: string | null;
  vin: string;
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

const batteryUsageTypeOptions = [
  { label: "电池买断", value: "BUYOUT" },
  { label: "BaaS / 电池租用", value: "BAAS" }
];

export function VehicleDetailActions({
  onVehicleChanged,
  permissions,
  vehicle
}: Readonly<{
  onVehicleChanged: () => Promise<void>;
  permissions: ReadonlySet<string>;
  vehicle: VehicleDetailRecord;
}>) {
  const { message } = App.useApp();
  const [editForm] = Form.useForm<EditVehicleValues>();
  const [initializeForm] = Form.useForm<InitializeSalePriceValues>();
  const [reviewForm] = Form.useForm<ReviewSalePriceValues>();
  const [statusForm] = Form.useForm<StatusValues>();
  const [editOpen, setEditOpen] = useState(false);
  const [initializeOpen, setInitializeOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modelDefinitions, setModelDefinitions] = useState<VehicleModelDefinitionSummary[]>([]);

  function openEdit() {
    editForm.setFieldsValue({
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: vehicle.batteryCapacityKwh,
      batteryUsageType: (vehicle.batteryUsageType ?? "BUYOUT") as "BUYOUT" | "BAAS",
      brand: vehicle.brand,
      latestRegistrationDate: vehicle.latestRegistrationDate
        ? dayjs(vehicle.latestRegistrationDate)
        : null,
      model: vehicle.model,
      modelDefinitionId: vehicle.modelDefinitionId,
      modelYear: vehicle.modelYear,
      plateNo: vehicle.plateNo,
      purchaseDate: vehicle.purchaseDate ? dayjs(vehicle.purchaseDate) : null,
      purchasePriceAmountYuan: yuanFromCents(vehicle.purchasePriceAmount),
      registrationDate: vehicle.registrationDate ? dayjs(vehicle.registrationDate) : null,
      remark: vehicle.remark,
      series: vehicle.series,
      vin: vehicle.vin ?? ""
    });
    setEditOpen(true);
    void apiFetch<VehicleModelDefinitionListResponse>("/vehicles/model-definitions/options")
      .then((result) => setModelDefinitions(result.items))
      .catch(() => setModelDefinitions([]));
  }

  function openInitialize() {
    const reviewType = isReturnReinitVehicle(vehicle) ? "RETURN_REINIT" : "INITIAL_POOL";
    initializeForm.setFieldsValue({
      currentSalePriceAmountYuan: yuanFromCents(vehicle.currentSalePriceAmount),
      effectiveFrom: dayjs(),
      reason: reviewType === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化",
      reviewType
    });
    setInitializeOpen(true);
  }

  function openReview() {
    const effectiveFrom = vehicle.nextSalePriceReviewAt
      ? dayjs(vehicle.nextSalePriceReviewAt)
      : dayjs();
    reviewForm.setFieldsValue({
      effectiveFrom,
      newSalePriceAmountYuan: yuanFromCents(vehicle.currentSalePriceAmount),
      reason: "季度市场价格复核",
      reviewQuarter: toReviewQuarter(effectiveFrom)
    });
    setReviewOpen(true);
  }

  function openStatus() {
    statusForm.setFieldsValue({
      remark: vehicle.salePriceReinitRequiredAt ? "退回车辆重新入池" : undefined,
      status: vehicle.status
    });
    setStatusOpen(true);
  }

  async function saveEdit(values: EditVehicleValues) {
    const payload: Record<string, unknown> = {
      assetLocation: values.assetLocation,
      batteryCapacityKwh: values.batteryCapacityKwh,
      batteryUsageType: values.batteryUsageType,
      brand: values.brand,
      latestRegistrationDate: values.latestRegistrationDate?.format("YYYY-MM-DD"),
      model: values.model,
      modelYear: values.modelYear,
      plateNo: values.plateNo,
      purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
      purchasePriceAmount: toCentAmount(values.purchasePriceAmountYuan),
      registrationDate: values.registrationDate?.format("YYYY-MM-DD"),
      remark: values.remark,
      series: values.series,
      vin: values.vin
    };
    if (values.modelDefinitionId) {
      payload.modelDefinitionId = values.modelDefinitionId;
    }
    await mutate(
      `/vehicles/${encodeURIComponent(vehicle.id)}`,
      payload,
      "PATCH",
      "车辆已更新",
      () => {
        setEditOpen(false);
        editForm.resetFields();
      }
    );
  }

  async function saveInitialize(values: InitializeSalePriceValues) {
    await mutate(
      `/vehicles/${encodeURIComponent(vehicle.id)}/initialize-sale-price`,
      {
        currentSalePriceAmount: toCentAmount(values.currentSalePriceAmountYuan),
        effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
        reason: values.reason,
        remark: values.remark,
        reviewType: values.reviewType
      },
      "POST",
      values.reviewType === "RETURN_REINIT"
        ? "退车再入池重新定价已完成"
        : "销售价已初始化",
      () => {
        setInitializeOpen(false);
        initializeForm.resetFields();
      }
    );
  }

  async function saveReview(values: ReviewSalePriceValues) {
    await mutate(
      `/vehicles/${encodeURIComponent(vehicle.id)}/review-sale-price`,
      {
        effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
        newSalePriceAmount: toCentAmount(values.newSalePriceAmountYuan),
        reason: values.reason,
        remark: values.remark,
        reviewQuarter: values.reviewQuarter
      },
      "POST",
      "季度销售价复核已保存",
      () => {
        setReviewOpen(false);
        reviewForm.resetFields();
      }
    );
  }

  async function saveStatus(values: StatusValues) {
    await mutate(
      `/vehicles/${encodeURIComponent(vehicle.id)}/update-status`,
      { remark: values.remark, status: values.status },
      "POST",
      "车辆状态已更新",
      () => {
        setStatusOpen(false);
        statusForm.resetFields();
      }
    );
  }

  async function mutate(
    path: string,
    body: Record<string, unknown>,
    method: "PATCH" | "POST",
    successMessage: string,
    close: () => void
  ) {
    setSubmitting(true);
    try {
      await apiFetch<VehicleDetailRecord>(path, { body: JSON.stringify(body), method });
      close();
      await onVehicleChanged();
      void message.success(successMessage);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const initializeAvailability = canInitializeVehicleSalePrice(vehicle, permissions);
  const reviewAvailability = canReviewVehicleSalePrice(vehicle, permissions);
  const statusAvailability = canUpdateVehicleStatus(vehicle, permissions);

  return (
    <>
      <Space wrap>
        <ActionButton
          icon={<EditOutlined />}
          onClick={openEdit}
          permission="vehicle:update"
          permissions={permissions}
        >
          编辑车辆
        </ActionButton>
        <ActionButton availability={initializeAvailability} icon={<DollarOutlined />} onClick={openInitialize}>
          {isReturnReinitVehicle(vehicle) ? "RETURN_REINIT 重新定价" : "初始化销售价"}
        </ActionButton>
        <ActionButton availability={reviewAvailability} icon={<SyncOutlined />} onClick={openReview}>
          季度复核
        </ActionButton>
        <ActionButton availability={statusAvailability} icon={<CarOutlined />} onClick={openStatus}>
          更新状态
        </ActionButton>
      </Space>

      <Modal
        confirmLoading={submitting}
        destroyOnHidden
        okText="保存"
        onCancel={() => setEditOpen(false)}
        onOk={() => editForm.submit()}
        open={editOpen}
        title={`${vehicle.vehicleNo} 编辑车辆`}
        width={720}
      >
        <Form form={editForm} layout="vertical" onFinish={(values) => void saveEdit(values)}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="车牌号" name="plateNo"><Input maxLength={32} /></Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}><Input maxLength={64} /></Form.Item>
          <Form.Item label="车系" name="series"><Input maxLength={64} /></Form.Item>
          <Form.Item label="车型" name="model"><Input maxLength={64} /></Form.Item>
          {!vehicle.modelDefinitionId ? <Alert message="该车辆尚未关联车型主数据，可在本次编辑时补充。" showIcon style={{ marginBottom: 16 }} type="warning" /> : null}
          <Form.Item label="车型代码（主数据）" name="modelDefinitionId">
            <Select
              allowClear
              options={modelDefinitions.map((definition) => ({
                label: `${definition.modelCode} - ${definition.displayName}`,
                value: definition.id
              }))}
              showSearch
            />
          </Form.Item>
          <Form.Item label="电池容量（kWh）" name="batteryCapacityKwh" rules={[{ required: true, message: "请输入电池容量" }]}><InputNumber min={0.01} precision={2} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="电池使用方式" name="batteryUsageType" rules={[{ required: true, message: "请选择电池使用方式" }]}><Select options={batteryUsageTypeOptions} /></Form.Item>
          <Form.Item label="年款" name="modelYear"><InputNumber min={1900} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="采购价（元）" name="purchasePriceAmountYuan" rules={[{ required: true, message: "请输入采购价" }]}><InputNumber min={0.01} precision={2} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="采购日期" name="purchaseDate"><DatePicker style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="初次上牌日期" name="registrationDate"><DatePicker style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="最近一次上牌日期" name="latestRegistrationDate"><DatePicker style={{ width: "100%" }} /></Form.Item>
          <Alert message="当前里程只能通过里程流程单据更新；保险起止期请在保单管理中维护。" showIcon style={{ marginBottom: 16 }} type="info" />
          <Form.Item label="资产位置" name="assetLocation"><Input maxLength={128} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Modal confirmLoading={submitting} destroyOnHidden okText="保存" onCancel={() => setInitializeOpen(false)} onOk={() => initializeForm.submit()} open={initializeOpen} title="初始化销售价" width={620}>
        <Form form={initializeForm} layout="vertical" onFinish={(values) => void saveInitialize(values)}>
          <Form.Item label="初始化类型" name="reviewType" rules={[{ required: true, message: "请选择初始化类型" }]}>
            <Select
              onChange={(value) => initializeForm.setFieldValue("reason", value === "RETURN_REINIT" ? "退车整备后重新入池" : "新入池初始化")}
              options={[{ label: "新入池初始化", value: "INITIAL_POOL" }, { label: "退车再入池重新定价", value: "RETURN_REINIT" }]}
            />
          </Form.Item>
          <Form.Item label="当前销售价（元）" name="currentSalePriceAmountYuan" rules={[{ required: true, message: "请输入当前销售价" }]}><InputNumber min={0.01} precision={2} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}><DatePicker style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      <Modal confirmLoading={submitting} destroyOnHidden okText="保存" onCancel={() => setReviewOpen(false)} onOk={() => reviewForm.submit()} open={reviewOpen} title="季度复核" width={620}>
        <Form form={reviewForm} layout="vertical" onFinish={(values) => void saveReview(values)}>
          <Form.Item label="新销售价（元）" name="newSalePriceAmountYuan" rules={[{ required: true, message: "请输入新销售价" }]}><InputNumber min={0.01} precision={2} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="复核季度" name="reviewQuarter" rules={[{ required: true, message: "请输入复核季度" }]}><Input placeholder="2026Q3" /></Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker onChange={(value) => value && reviewForm.setFieldValue("reviewQuarter", toReviewQuarter(value))} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: "请输入原因" }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>

      <Modal confirmLoading={submitting} destroyOnHidden okText="保存" onCancel={() => setStatusOpen(false)} onOk={() => statusForm.submit()} open={statusOpen} title="更新状态" width={520}>
        <Form form={statusForm} layout="vertical" onFinish={(values) => void saveStatus(values)}>
          {returnReinitNotice(vehicle) ? <Alert message={returnReinitNotice(vehicle)} showIcon style={{ marginBottom: 16 }} type={canRelistAfterReturn(vehicle) ? "success" : "warning"} /> : null}
          <Form.Item label="车辆状态" name="status" rules={[{ required: true, message: "请选择车辆状态" }]}><Select options={statusOptionsForVehicle(vehicle)} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function isReturnReinitVehicle(vehicle: Pick<VehicleDetailRecord, "status">) {
  return vehicle.status === "RETURNED" || vehicle.status === "MAINTENANCE";
}

function canRelistAfterReturn(vehicle: VehicleDetailRecord) {
  const latest = vehicle.salePriceHistories?.find((history) => history.reviewType === "RETURN_REINIT");
  const reinitialized = latest && (!vehicle.salePriceReinitRequiredAt || dayjs(latest.createdAt).valueOf() >= dayjs(vehicle.salePriceReinitRequiredAt).valueOf());
  return Boolean(isReturnReinitVehicle(vehicle) && vehicle.currentSalePriceAmount && vehicle.currentSalePriceAmount > 0 && vehicle.salePriceStatus === "EFFECTIVE" && reinitialized);
}

function returnReinitNotice(vehicle: VehicleDetailRecord) {
  if (!isReturnReinitVehicle(vehicle)) return null;
  if (canRelistAfterReturn(vehicle)) return "退车再入池重新定价已完成，可设置为可租用。";
  return "退回车辆需先通过 RETURN_REINIT 重新初始化当前销售价，才能再次入池。";
}

function statusOptionsForVehicle(vehicle: VehicleDetailRecord) {
  if (!isReturnReinitVehicle(vehicle) || canRelistAfterReturn(vehicle)) return vehicleStatusOptions;
  return vehicleStatusOptions.map((option) => option.value === "AVAILABLE" ? { ...option, disabled: true, label: `${option.label}（需先 RETURN_REINIT）` } : option);
}

function toReviewQuarter(date: Dayjs) {
  return `${date.year()}Q${Math.floor(date.month() / 3) + 1}`;
}
