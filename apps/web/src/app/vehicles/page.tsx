"use client";

import { EyeOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  DatePicker,
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
import type { Dayjs } from "dayjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  STATUS_LABELS,
  VEHICLE_ACQUISITION_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  buildVehicleDueReviewHref,
  buildVehicleLedgerHref,
  buildVehicleWorkspaceHref,
  parseVehicleLedgerState,
  type VehicleLedgerState
} from "../../lib/admin-vehicle-workspace";
import {
  formatDate,
  formatDateTime,
  formatYuan,
  getErrorMessage,
  toCentAmount
} from "../../lib/capital-format";

interface VehicleInsurancePolicyCoverageSummary {
  covered: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

interface VehicleInsuranceCoverageSummary {
  commercial: VehicleInsurancePolicyCoverageSummary;
  compulsoryTraffic: VehicleInsurancePolicyCoverageSummary;
  covered: boolean;
  evaluatedAt: string;
}

interface VehicleModelDefinitionSummary {
  displayName: string;
  id: string;
  modelCode: string;
}

interface VehicleModelDefinitionListResponse {
  items: VehicleModelDefinitionSummary[];
}

interface Vehicle {
  acquisitionMode?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: string | null;
  batteryUsageTypeLabel?: string | null;
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount?: number | null;
  currentSalePriceReviewedAt?: string | null;
  id: string;
  insuranceCoverage: VehicleInsuranceCoverageSummary;
  model?: string | null;
  modelDisplayName?: string | null;
  nextSalePriceReviewAt?: string | null;
  plateNo?: string | null;
  salePriceStatus: string;
  series?: string | null;
  status: string;
  vehicleNo: string;
  vin?: string | null;
}

interface CreateVehicleValues {
  assetLocation?: string | null;
  batteryCapacityKwh?: number | null;
  batteryUsageType?: "BUYOUT" | "BAAS";
  brand: string;
  currentMileageKm?: number;
  latestRegistrationDate?: Dayjs | null;
  model?: string | null;
  modelDefinitionId: string;
  modelYear?: number | null;
  plateNo?: string | null;
  purchaseDate?: Dayjs | null;
  purchasePriceAmountYuan: number;
  registrationDate?: Dayjs | null;
  remark?: string | null;
  series?: string | null;
  vin: string;
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

export default function VehiclesPage() {
  return (
    <Suspense fallback={null}>
      <VehiclesPageContent />
    </Suspense>
  );
}

function VehiclesPageContent() {
  const { message } = App.useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [createForm] = Form.useForm<CreateVehicleValues>();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [dueReviews, setDueReviews] = useState<Vehicle[]>([]);
  const [modelDefinitions, setModelDefinitions] = useState<VehicleModelDefinitionSummary[]>([]);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ledgerState = useMemo(
    () => parseVehicleLedgerState(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );
  const permissions = useMemo(
    () => new Set(me?.user.permissions ?? []),
    [me?.user.permissions]
  );

  const loadData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [vehicleRows, dueRows, profile, definitionResult] = await Promise.all([
        apiFetch<Vehicle[]>("/vehicles", { signal }),
        apiFetch<Vehicle[]>("/vehicles/sale-price-reviews/due", { signal }),
        apiFetch<AuthMeResponse>("/auth/me", { signal }),
        apiFetch<VehicleModelDefinitionListResponse>("/vehicles/model-definitions/options", {
          signal
        })
      ]);
      setVehicles(vehicleRows);
      setDueReviews(dueRows);
      setMe(profile);
      setModelDefinitions(definitionResult.items);
    } catch (error) {
      if (!signal?.aborted) {
        void message.error(getErrorMessage(error));
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [message]);

  useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  useEffect(() => {
    const canonicalHref = buildVehicleLedgerHref(ledgerState);
    const query = searchParams.toString();
    const currentHref = `/vehicles${query ? `?${query}` : ""}`;
    if (currentHref !== canonicalHref) {
      router.replace(canonicalHref, { scroll: false });
    }
  }, [ledgerState, router, searchParams]);

  function replaceLedgerState(patch: Partial<VehicleLedgerState>) {
    router.replace(buildVehicleLedgerHref({ ...ledgerState, ...patch }), { scroll: false });
  }

  function openCreateVehicle() {
    createForm.resetFields();
    createForm.setFieldsValue({
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      currentMileageKm: 0
    });
    setCreateOpen(true);
  }

  async function saveCreateVehicle(values: CreateVehicleValues) {
    setCreating(true);
    try {
      const created = await apiFetch<Vehicle>("/vehicles", {
        body: JSON.stringify({
          assetLocation: values.assetLocation,
          batteryCapacityKwh: values.batteryCapacityKwh,
          batteryUsageType: values.batteryUsageType,
          brand: values.brand,
          currentMileageKm: values.currentMileageKm ?? 0,
          latestRegistrationDate: values.latestRegistrationDate?.format("YYYY-MM-DD"),
          model: values.model,
          modelDefinitionId: values.modelDefinitionId,
          modelYear: values.modelYear,
          plateNo: values.plateNo,
          purchaseDate: values.purchaseDate?.format("YYYY-MM-DD"),
          purchasePriceAmount: toCentAmount(values.purchasePriceAmountYuan),
          registrationDate: values.registrationDate?.format("YYYY-MM-DD"),
          remark: values.remark,
          series: values.series,
          vin: values.vin
        }),
        method: "POST"
      });
      setCreateOpen(false);
      createForm.resetFields();
      await loadData();
      void message.success("车辆已创建");
      router.push(buildVehicleWorkspaceHref({ tab: "overview", vehicleId: created.id }));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  const sourceRows = ledgerState.tab === "due" ? dueReviews : vehicles;
  const filteredRows = filterVehicles(sourceRows, ledgerState);
  const start = (ledgerState.page - 1) * ledgerState.pageSize;
  const pageRows = filteredRows.slice(start, start + ledgerState.pageSize);
  const columns = buildVehicleColumns(ledgerState.tab);

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ display: "flex" }}>
        <Space align="center" style={{ justifyContent: "space-between" }} wrap>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>车辆资产台账</Typography.Title>
            <Typography.Text type="secondary">车辆列表与待销售价格复核入口</Typography.Text>
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
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadData()}>
              刷新
            </Button>
          </Space>
        </Space>

        {!loading && me && !permissions.has("vehicle:view") ? (
          <Alert message="无权查看车辆资产台账" showIcon type="warning" />
        ) : null}

        <Tabs
          activeKey={ledgerState.tab}
          items={[
            { key: "vehicles", label: `车辆列表 (${vehicles.length})` },
            { key: "due", label: `待销售价格复核 (${dueReviews.length})` }
          ]}
          onChange={(tab) => replaceLedgerState({ page: 1, tab: tab as VehicleLedgerState["tab"] })}
        />

        <Space wrap>
          <Input.Search
            allowClear
            onChange={(event) => replaceLedgerState({ page: 1, query: event.target.value })}
            placeholder="车辆编号 / VIN / 车牌号 / 车型"
            style={{ width: 320 }}
            value={ledgerState.query}
          />
          <Select
            allowClear
            onChange={(status) => replaceLedgerState({ page: 1, status: status ?? "" })}
            options={vehicleStatusOptions}
            placeholder="车辆状态"
            style={{ width: 180 }}
            value={ledgerState.status || undefined}
          />
        </Space>

        <Table
          columns={columns}
          dataSource={pageRows}
          loading={loading}
          onRow={(record) => ({
            onClick: () => router.push(detailHref(record.id, ledgerState.tab)),
            style: { cursor: "pointer" }
          })}
          pagination={{
            current: ledgerState.page,
            onChange: (page, pageSize) => replaceLedgerState({ page, pageSize }),
            pageSize: ledgerState.pageSize,
            showSizeChanger: true,
            total: filteredRows.length
          }}
          rowKey="id"
          scroll={{ x: 1650 }}
        />
      </Space>

      <Modal
        confirmLoading={creating}
        destroyOnHidden
        okText="保存"
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="新增车辆"
        width={720}
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => void saveCreateVehicle(values)}>
          <Form.Item label="VIN" name="vin" rules={[{ required: true, message: "请输入 VIN" }]}><Input maxLength={64} /></Form.Item>
          <Form.Item label="车牌号" name="plateNo"><Input maxLength={32} /></Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}><Input maxLength={64} /></Form.Item>
          <Form.Item label="车系" name="series"><Input maxLength={64} /></Form.Item>
          <Form.Item label="车型" name="model"><Input maxLength={64} /></Form.Item>
          <Form.Item extra="新增车辆必须关联已启用的车型主数据。" label="车型代码（主数据）" name="modelDefinitionId" rules={[{ required: true, message: "请选择车型代码" }]}>
            <Select
              filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
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
          <Alert message="保险起止期请在保单管理中维护；车辆新增不再手工填写。" showIcon style={{ marginBottom: 16 }} type="info" />
          <Form.Item label="当前里程" name="currentMileageKm"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
          <Form.Item label="资产位置" name="assetLocation"><Input maxLength={128} /></Form.Item>
          <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>
    </ProtectedShell>
  );
}

function buildVehicleColumns(tab: VehicleLedgerState["tab"]): ColumnsType<Vehicle> {
  return [
    { dataIndex: "vehicleNo", title: "车辆编号", width: 190 },
    { dataIndex: "vin", render: nullableText, title: "VIN", width: 180 },
    { dataIndex: "plateNo", render: nullableText, title: "车牌号", width: 120 },
    { render: (_, record) => vehicleModelText(record), title: "车型", width: 220 },
    { dataIndex: "batteryCapacityKwh", render: (value: number | null) => value === null || value === undefined ? "-" : `${value} kWh`, title: "电池容量", width: 120 },
    { dataIndex: "batteryUsageType", render: (value: string | null, record) => record.batteryUsageTypeLabel ?? labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, value), title: "电池方式", width: 140 },
    { dataIndex: "acquisitionMode", render: (value: string | null) => labelOf(VEHICLE_ACQUISITION_MODE_LABELS, value), title: "取得方式", width: 160 },
    { dataIndex: "currentSalePriceAmount", render: formatYuan, title: "当前销售价", width: 140 },
    { render: (_, record) => formatInsuranceCoverage(record.insuranceCoverage), title: "保险覆盖（今日）", width: 260 },
    { dataIndex: "currentSalePriceReviewedAt", render: formatDateTime, title: "最近复核时间", width: 170 },
    { dataIndex: "nextSalePriceReviewAt", render: formatDate, title: "下次复核时间", width: 140 },
    { dataIndex: "salePriceStatus", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "销售价状态", width: 130 },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "车辆状态", width: 120 },
    {
      fixed: "right",
      render: (_, record) => (
        <Link
          href={detailHref(record.id, tab)}
          onClick={(event) => event.stopPropagation()}
        >
          <EyeOutlined /> 详情
        </Link>
      ),
      title: "操作",
      width: 100
    }
  ];
}

function filterVehicles(rows: readonly Vehicle[], state: VehicleLedgerState) {
  const query = state.query.toLocaleLowerCase("zh-CN");
  return rows.filter((vehicle) => {
    if (state.status && vehicle.status !== state.status) return false;
    if (!query) return true;
    return [
      vehicle.vehicleNo,
      vehicle.vin,
      vehicle.plateNo,
      vehicle.brand,
      vehicle.series,
      vehicle.model,
      vehicle.modelDisplayName
    ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(query));
  });
}

function detailHref(vehicleId: string, tab: VehicleLedgerState["tab"]) {
  return tab === "due"
    ? buildVehicleDueReviewHref(vehicleId)
    : buildVehicleWorkspaceHref({ tab: "overview", vehicleId });
}

function vehicleModelText(vehicle: Vehicle) {
  return [vehicle.brand, vehicle.series, vehicle.model, vehicle.modelDisplayName]
    .filter(Boolean)
    .join(" / ") || "-";
}

function formatInsuranceCoverage(coverage: VehicleInsuranceCoverageSummary) {
  return `交强险：${formatCoveragePeriod(coverage.compulsoryTraffic)}；商业险：${formatCoveragePeriod(coverage.commercial)}`;
}

function formatCoveragePeriod(coverage: VehicleInsurancePolicyCoverageSummary) {
  if (!coverage.covered) return "未覆盖";
  return `${formatDate(coverage.effectiveFrom)} 至 ${formatDate(coverage.effectiveTo)}`;
}

function nullableText(value?: string | null) {
  return value || "-";
}
