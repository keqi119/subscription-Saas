"use client";

import {
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ToolOutlined
} from "@ant-design/icons";
import {
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Alert,
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
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  FINANCING_ALLOCATION_STATUS_LABELS,
  FINANCING_COLLATERAL_TYPE_LABELS,
  FINANCING_INSTRUMENT_STATUS_LABELS,
  FINANCING_INSTRUMENT_TYPE_LABELS,
  FINANCING_REPAYMENT_METHOD_LABELS,
  VEHICLE_CAPITAL_EVENT_STATUS_LABELS,
  VEHICLE_CAPITAL_EVENT_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  buildQuery,
  formatDate,
  formatPercentFromBps,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  percentFromBps,
  percentToBps,
  safeText,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";

interface FinancingInstrumentRow {
  annualRateBps?: number | null;
  collateralType?: string | null;
  contractNo?: string | null;
  id: string;
  instrumentNo: string;
  instrumentStatus: string;
  instrumentType: string;
  lenderName?: string | null;
  maturityDate?: string | null;
  principalAmount: number;
  remark?: string | null;
  repaymentMethod?: string | null;
  startDate: string;
  termMonths?: number | null;
}

interface FinancingInstrumentListResponse {
  items: FinancingInstrumentRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleBrief {
  brand?: string | null;
  id: string;
  model?: string | null;
  plateNo?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface VehicleOptionRow extends VehicleBrief {
  purchasePriceAmount?: number | null;
  vehicleModel?: string | null;
}

interface FinancingAllocationRow {
  allocatedPrincipalAmount: number;
  allocationNo?: string | null;
  allocationRatioBps?: number | null;
  allocationStatus: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  id: string;
  remark?: string | null;
  vehicle?: VehicleBrief | null;
  vehicleId: string;
}

interface CapitalEventRow {
  debtPrincipalAmount?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  equityCapitalAmount?: number | null;
  eventNo: string;
  eventStatus: string;
  eventType: string;
  id: string;
  remark?: string | null;
  vehicleId: string;
}

interface FinancingInstrumentDetail extends FinancingInstrumentRow {
  capitalEvents: CapitalEventRow[];
  vehicles: FinancingAllocationRow[];
}

interface InstrumentFilterValues {
  instrumentStatus?: string;
  instrumentType?: string;
  lenderName?: string;
}

interface InstrumentFormValues {
  annualRatePercent?: number | null;
  collateralType?: string | null;
  contractNo?: string | null;
  instrumentType: string;
  lenderName?: string | null;
  maturityDate?: Dayjs | null;
  principalAmountYuan: number;
  remark?: string | null;
  repaymentMethod?: string | null;
  startDate: Dayjs;
  termMonths?: number | null;
}

interface AllocationFormValues {
  allocatedPrincipalAmountYuan: number;
  effectiveFrom: Dayjs;
  remark?: string | null;
  vehicleId: string;
}

interface ReleaseAllocationFormValues {
  releasedAt: Dayjs;
  remark?: string | null;
}

interface SettleInstrumentFormValues {
  remark?: string | null;
  settledAt: Dayjs;
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  CANCELLED: "default",
  RELEASED: "default",
  SETTLED: "blue"
};

function vehicleOptionLabel(vehicle: VehicleOptionRow) {
  return [vehicle.vehicleNo, vehicle.plateNo, vehicle.vin, vehicle.vehicleModel ?? vehicle.model]
    .filter(Boolean)
    .join(" / ");
}

function formatTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={statusColors[value] ?? "default"}>{labelOf(labels, value)}</Tag>;
}

function vehicleModelText(vehicle?: VehicleBrief | null) {
  if (!vehicle) {
    return "-";
  }
  return [vehicle.brand, vehicle.model].filter(Boolean).join(" / ") || "-";
}

function formatPercentFromRatio(numerator?: number | null, denominator?: number | null) {
  if (!numerator || !denominator || denominator <= 0) {
    return "-";
  }
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function ratioToBps(numerator: number, denominator: number) {
  return Math.round((numerator / denominator) * 10000);
}

export default function FinancingInstrumentsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<InstrumentFilterValues>();
  const [instrumentForm] = Form.useForm<InstrumentFormValues>();
  const [allocationForm] = Form.useForm<AllocationFormValues>();
  const [releaseForm] = Form.useForm<ReleaseAllocationFormValues>();
  const [settleForm] = Form.useForm<SettleInstrumentFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [rows, setRows] = useState<FinancingInstrumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<FinancingInstrumentDetail | null>(null);
  const [instrumentModalOpen, setInstrumentModalOpen] = useState(false);
  const [editingInstrument, setEditingInstrument] = useState<FinancingInstrumentRow | null>(null);
  const [allocationModalOpen, setAllocationModalOpen] = useState(false);
  const [vehicleRows, setVehicleRows] = useState<VehicleOptionRow[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<FinancingAllocationRow | null>(null);
  const [settleTarget, setSettleTarget] = useState<FinancingInstrumentRow | null>(null);
  const allocationVehicleId = Form.useWatch("vehicleId", allocationForm);
  const allocationPrincipalYuan = Form.useWatch("allocatedPrincipalAmountYuan", allocationForm);
  const permissions = useMemo(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("financing:view");
  const canViewVehicles = permissions.has("vehicle:view");
  const selectedAllocationVehicle = useMemo(
    () => vehicleRows.find((vehicle) => vehicle.id === allocationVehicleId) ?? null,
    [allocationVehicleId, vehicleRows]
  );
  const allocationPrincipalAmount = toCentAmount(allocationPrincipalYuan);
  const allocationInstrumentRatioText = formatPercentFromRatio(allocationPrincipalAmount, detail?.principalAmount);
  const allocationVehicleCoverageText = formatPercentFromRatio(
    allocationPrincipalAmount,
    selectedAllocationVehicle?.purchasePriceAmount
  );
  const vehicleOptions = useMemo(
    () =>
      vehicleRows.map((vehicle) => ({
        label: vehicleOptionLabel(vehicle),
        value: vehicle.id
      })),
    [vehicleRows]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const query = buildQuery(filterForm.getFieldsValue());
      const result = await apiFetch<FinancingInstrumentListResponse>(`/financing-instruments${query}`);
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const nextDetail = await apiFetch<FinancingInstrumentDetail>(`/financing-instruments/${id}`);
        setDetail(nextDetail);
        return nextDetail;
      } catch (error) {
        void message.error(getErrorMessage(error));
        return null;
      } finally {
        setDetailLoading(false);
      }
    },
    [message]
  );

  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    try {
      const result = await apiFetch<VehicleOptionRow[]>("/vehicles");
      setVehicleRows(result);
    } catch (error) {
      void message.error(getErrorMessage(error));
      setVehicleRows([]);
    } finally {
      setVehiclesLoading(false);
    }
  }, [message]);

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => message.error(getErrorMessage(error)));
  }, [message]);

  useEffect(() => {
    if (canView) {
      void loadData();
    }
  }, [canView, loadData]);

  useEffect(() => {
    if (canViewVehicles) {
      void loadVehicles();
    }
  }, [canViewVehicles, loadVehicles]);

  function openCreate() {
    setEditingInstrument(null);
    instrumentForm.resetFields();
    instrumentForm.setFieldsValue({
      collateralType: "VEHICLE",
      instrumentType: "FINANCE_LEASE",
      repaymentMethod: "INTEREST_ONLY",
      startDate: dayjs()
    });
    setInstrumentModalOpen(true);
  }

  function openEdit(record: FinancingInstrumentRow) {
    setEditingInstrument(record);
    instrumentForm.setFieldsValue({
      annualRatePercent: percentFromBps(record.annualRateBps),
      collateralType: record.collateralType,
      contractNo: record.contractNo,
      instrumentType: record.instrumentType,
      lenderName: record.lenderName,
      maturityDate: record.maturityDate ? dayjs(record.maturityDate) : null,
      principalAmountYuan: yuanFromCents(record.principalAmount),
      remark: record.remark,
      repaymentMethod: record.repaymentMethod,
      startDate: dayjs(record.startDate),
      termMonths: record.termMonths
    });
    setInstrumentModalOpen(true);
  }

  async function submitInstrument(values: InstrumentFormValues) {
    const payload = {
      annualRateBps: percentToBps(values.annualRatePercent),
      collateralType: values.collateralType,
      contractNo: values.contractNo,
      instrumentType: values.instrumentType,
      lenderName: values.lenderName,
      maturityDate: values.maturityDate?.format("YYYY-MM-DD"),
      principalAmount: toCentAmount(values.principalAmountYuan),
      remark: values.remark,
      repaymentMethod: values.repaymentMethod,
      startDate: values.startDate.format("YYYY-MM-DD"),
      termMonths: values.termMonths
    };

    try {
      if (editingInstrument) {
        await apiFetch(`/financing-instruments/${editingInstrument.id}`, {
          body: JSON.stringify(payload),
          method: "PUT"
        });
        void message.success("融资工具已更新");
      } else {
        await apiFetch("/financing-instruments", {
          body: JSON.stringify(payload),
          method: "POST"
        });
        void message.success("融资工具已创建");
      }
      setInstrumentModalOpen(false);
      instrumentForm.resetFields();
      await loadData();
      const detailId = detail?.id;
      if (detailId && detailId === editingInstrument?.id) {
        await loadDetail(detailId);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function openDetail(record: FinancingInstrumentRow) {
    setDetailOpen(true);
    await loadDetail(record.id);
  }

  function openAllocationModal() {
    allocationForm.resetFields();
    allocationForm.setFieldsValue({
      effectiveFrom: dayjs()
    });
    setAllocationModalOpen(true);
  }

  async function submitAllocation(values: AllocationFormValues) {
    if (!detail) {
      return;
    }

    const allocatedPrincipalAmount = toCentAmount(values.allocatedPrincipalAmountYuan);
    if (!allocatedPrincipalAmount) {
      void message.error("请输入分摊本金");
      return;
    }
    if (!detail.principalAmount || detail.principalAmount <= 0) {
      void message.error("融资工具本金缺失，无法计算分摊比例。");
      return;
    }

    try {
      await apiFetch(`/financing-instruments/${detail.id}/vehicles`, {
        body: JSON.stringify({
          allocatedPrincipalAmount,
          allocationRatioBps: ratioToBps(allocatedPrincipalAmount, detail.principalAmount),
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          remark: values.remark,
          vehicleId: values.vehicleId
        }),
        method: "POST"
      });
      void message.success("车辆分摊已添加");
      setAllocationModalOpen(false);
      allocationForm.resetFields();
      await Promise.all([loadData(), loadDetail(detail.id)]);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openReleaseModal(record: FinancingAllocationRow) {
    setReleaseTarget(record);
    releaseForm.resetFields();
    releaseForm.setFieldsValue({ releasedAt: dayjs() });
  }

  async function submitReleaseAllocation() {
    if (!detail || !releaseTarget) {
      return;
    }

    const values = await releaseForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "确认解除该车辆分摊？",
      okText: "确认解除",
      onOk: async () => {
        try {
          await apiFetch(`/financing-instruments/${detail.id}/vehicles/${releaseTarget.id}/release`, {
            body: JSON.stringify({
              releasedAt: values.releasedAt.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("车辆分摊已解除");
          setReleaseTarget(null);
          releaseForm.resetFields();
          await Promise.all([loadData(), loadDetail(detail.id)]);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "解除车辆分摊"
    });
  }

  function openSettleModal(record: FinancingInstrumentRow) {
    setSettleTarget(record);
    settleForm.resetFields();
    settleForm.setFieldsValue({ settledAt: dayjs() });
  }

  async function submitSettleInstrument() {
    if (!settleTarget) {
      return;
    }

    const values = await settleForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "结清后该融资工具状态将变为已结清，并可能释放关联车辆分摊。",
      okText: "确认结清",
      onOk: async () => {
        try {
          await apiFetch(`/financing-instruments/${settleTarget.id}/settle`, {
            body: JSON.stringify({
              remark: values.remark,
              settledAt: values.settledAt.format("YYYY-MM-DD")
            }),
            method: "POST"
          });
          void message.success("融资工具已结清");
          setSettleTarget(null);
          settleForm.resetFields();
          await loadData();
          if (detail?.id === settleTarget.id) {
            await loadDetail(settleTarget.id);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "确认结清该融资工具？"
    });
  }

  const columns: ColumnsType<FinancingInstrumentRow> = [
    { dataIndex: "instrumentNo", title: "融资工具编号", width: 190 },
    {
      dataIndex: "instrumentType",
      render: (value: string) => labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, value),
      title: "融资类型",
      width: 170
    },
    {
      dataIndex: "instrumentStatus",
      render: (value: string) => formatTag(FINANCING_INSTRUMENT_STATUS_LABELS, value),
      title: "状态",
      width: 110
    },
    { dataIndex: "lenderName", render: safeText, title: "资金方", width: 180 },
    { dataIndex: "contractNo", render: safeText, title: "合同编号", width: 170 },
    { dataIndex: "principalAmount", render: formatYuan, title: "本金金额", width: 140 },
    { dataIndex: "annualRateBps", render: formatPercentFromBps, title: "年化利率", width: 120 },
    { dataIndex: "startDate", render: formatDate, title: "开始日期", width: 120 },
    { dataIndex: "maturityDate", render: formatDate, title: "到期日期", width: 120 },
    { dataIndex: "termMonths", render: safeText, title: "期限（月）", width: 110 },
    {
      dataIndex: "repaymentMethod",
      render: (value: string | null | undefined) => labelOf(FINANCING_REPAYMENT_METHOD_LABELS, value),
      title: "还款方式",
      width: 140
    },
    {
      dataIndex: "collateralType",
      render: (value: string | null | undefined) => labelOf(FINANCING_COLLATERAL_TYPE_LABELS, value),
      title: "担保类型",
      width: 150
    },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <ActionButton icon={<EyeOutlined />} onClick={() => openDetail(record)} permission="financing:view" permissions={permissions} size="small">
            查看详情
          </ActionButton>
          <ActionButton onClick={() => openEdit(record)} permission="financing:manage" permissions={permissions} size="small">
            编辑
          </ActionButton>
          <ActionButton
            allowed={record.instrumentStatus === "ACTIVE"}
            disabledReason="仅生效中的融资工具可以结清"
            icon={<StopOutlined />}
            onClick={() => openSettleModal(record)}
            permission="financing:manage"
            permissions={permissions}
            size="small"
          >
            结清
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 240
    }
  ];

  const allocationColumns: ColumnsType<FinancingAllocationRow> = [
    { dataIndex: ["vehicle", "vehicleNo"], render: safeText, title: "车辆编号", width: 180 },
    { dataIndex: ["vehicle", "vin"], render: safeText, title: "车辆 VIN", width: 180 },
    { dataIndex: ["vehicle", "plateNo"], render: safeText, title: "车牌号", width: 120 },
    { render: (_, record) => vehicleModelText(record.vehicle), title: "车型", width: 180 },
    { dataIndex: "allocatedPrincipalAmount", render: formatYuan, title: "分摊本金", width: 130 },
    { dataIndex: "allocationRatioBps", render: formatPercentFromBps, title: "分摊比例", width: 110 },
    {
      dataIndex: "allocationStatus",
      render: (value: string) => formatTag(FINANCING_ALLOCATION_STATUS_LABELS, value),
      title: "分摊状态",
      width: 110
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "解除日期", width: 120 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 160 },
    {
      fixed: "right",
      render: (_, record) => (
        <ActionButton
          allowed={record.allocationStatus === "ACTIVE"}
          disabledReason="仅生效中的分摊可以解除"
          onClick={() => openReleaseModal(record)}
          permission="financing:manage"
          permissions={permissions}
          size="small"
        >
          解除分摊
        </ActionButton>
      ),
      title: "操作",
      width: 120
    }
  ];

  const eventColumns: ColumnsType<CapitalEventRow> = [
    { dataIndex: "eventNo", title: "事件编号", width: 190 },
    { dataIndex: "vehicleId", render: safeText, title: "车辆", width: 180 },
    {
      dataIndex: "eventType",
      render: (value: string) => labelOf(VEHICLE_CAPITAL_EVENT_TYPE_LABELS, value),
      title: "事件类型",
      width: 150
    },
    {
      dataIndex: "eventStatus",
      render: (value: string) => formatTag(VEHICLE_CAPITAL_EVENT_STATUS_LABELS, value),
      title: "状态",
      width: 100
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "事件时间", width: 120 },
    { dataIndex: "equityCapitalAmount", render: formatYuan, title: "自有资金金额", width: 140 },
    { dataIndex: "debtPrincipalAmount", render: formatYuan, title: "债务本金金额", width: 140 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            融资工具管理
          </Typography.Title>
          <Space>
            <ActionButton icon={<PlusOutlined />} onClick={openCreate} permission="financing:manage" permissions={permissions} type="primary">
              新增融资工具
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </Space>

        <Form form={filterForm} layout="inline" onFinish={loadData}>
          <Form.Item label="融资工具类型" name="instrumentType">
            <Select allowClear options={optionsFromLabels(FINANCING_INSTRUMENT_TYPE_LABELS)} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="融资工具状态" name="instrumentStatus">
            <Select allowClear options={optionsFromLabels(FINANCING_INSTRUMENT_STATUS_LABELS)} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="资金方名称" name="lenderName">
            <Input allowClear placeholder="资金方名称" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button htmlType="submit" loading={loading}>
                查询
              </Button>
              <Button
                onClick={() => {
                  filterForm.resetFields();
                  void loadData();
                }}
              >
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          rowKey="id"
          scroll={{ x: 1900 }}
          size="small"
        />

        <Drawer
          destroyOnHidden
          extra={
            detail ? (
              <ActionButton
                allowed={detail.instrumentStatus === "ACTIVE"}
                disabledReason="仅生效中的融资工具可以新增车辆分摊"
                icon={<ToolOutlined />}
                onClick={openAllocationModal}
                permission="financing:manage"
                permissions={permissions}
              >
                添加车辆分摊
              </ActionButton>
            ) : null
          }
          loading={detailLoading}
          onClose={() => {
            setDetailOpen(false);
            setDetail(null);
          }}
          open={detailOpen}
          size="large"
          title={detail ? `${detail.instrumentNo} 融资工具详情` : "融资工具详情"}
        >
          {detail ? (
            <Space orientation="vertical" size={20} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "融资工具编号", children: detail.instrumentNo },
                  { label: "融资类型", children: labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, detail.instrumentType) },
                  { label: "状态", children: formatTag(FINANCING_INSTRUMENT_STATUS_LABELS, detail.instrumentStatus) },
                  { label: "资金方", children: safeText(detail.lenderName) },
                  { label: "合同编号", children: safeText(detail.contractNo) },
                  { label: "本金金额", children: formatYuan(detail.principalAmount) },
                  { label: "年化利率", children: formatPercentFromBps(detail.annualRateBps) },
                  { label: "开始日期", children: formatDate(detail.startDate) },
                  { label: "到期日期", children: formatDate(detail.maturityDate) },
                  { label: "期限（月）", children: safeText(detail.termMonths) },
                  { label: "还款方式", children: labelOf(FINANCING_REPAYMENT_METHOD_LABELS, detail.repaymentMethod) },
                  { label: "担保类型", children: labelOf(FINANCING_COLLATERAL_TYPE_LABELS, detail.collateralType) },
                  { label: "备注", children: safeText(detail.remark) }
                ]}
                title="基础信息"
              />
              <Table
                columns={allocationColumns}
                dataSource={detail.vehicles}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1280 }}
                size="small"
                title={() => "车辆分摊列表"}
              />
              <Table
                columns={eventColumns}
                dataSource={detail.capitalEvents}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1320 }}
                size="small"
                title={() => "资本事件列表"}
              />
            </Space>
          ) : null}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setInstrumentModalOpen(false)}
          onOk={() => instrumentForm.submit()}
          open={instrumentModalOpen}
          title={editingInstrument ? "编辑融资工具" : "新增融资工具"}
          width={720}
        >
          <Form<InstrumentFormValues> form={instrumentForm} layout="vertical" onFinish={submitInstrument}>
            <Form.Item label="融资工具类型" name="instrumentType" rules={[{ required: true, message: "请选择融资工具类型" }]}>
              <Select options={optionsFromLabels(FINANCING_INSTRUMENT_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="资金方名称" name="lenderName">
              <Input maxLength={128} />
            </Form.Item>
            <Form.Item label="合同编号" name="contractNo">
              <Input maxLength={128} />
            </Form.Item>
            <Form.Item label="本金金额（元）" name="principalAmountYuan" rules={[{ required: true, message: "请输入本金金额" }]}>
              <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="年化利率（%）" name="annualRatePercent">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="开始日期" name="startDate" rules={[{ required: true, message: "请选择开始日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="到期日期" name="maturityDate">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="期限（月）" name="termMonths">
              <InputNumber min={1} precision={0} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="还款方式" name="repaymentMethod">
              <Select allowClear options={optionsFromLabels(FINANCING_REPAYMENT_METHOD_LABELS)} />
            </Form.Item>
            <Form.Item label="担保类型" name="collateralType">
              <Select allowClear options={optionsFromLabels(FINANCING_COLLATERAL_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="添加"
          onCancel={() => setAllocationModalOpen(false)}
          onOk={() => allocationForm.submit()}
          open={allocationModalOpen}
          title="添加车辆分摊"
          width={620}
        >
          <Form<AllocationFormValues> form={allocationForm} layout="vertical" onFinish={submitAllocation}>
            <Form.Item
              extra={vehicleOptions.length > 0 ? "请选择系统车辆，提交时会自动使用数据库车辆 ID。" : "当前无法加载车辆列表，请填写系统车辆 ID（UUID），不要填写 VEH 开头的车辆编号。"}
              label="车辆"
              name="vehicleId"
              rules={[{ required: true, message: "请选择车辆" }]}
            >
              {vehicleOptions.length > 0 ? (
                <Select
                  loading={vehiclesLoading}
                  optionFilterProp="label"
                  options={vehicleOptions}
                  placeholder="搜索车辆编号 / 车牌 / VIN / 车型"
                  showSearch
                />
              ) : (
                <Input placeholder="系统车辆 ID（UUID）" />
              )}
            </Form.Item>
            <Form.Item label="分摊本金（元）" name="allocatedPrincipalAmountYuan" rules={[{ required: true, message: "请输入分摊本金" }]}>
              <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Alert
              description={
                <Space orientation="vertical" size={4}>
                  <Typography.Text>融资工具占用比例：{allocationInstrumentRatioText}</Typography.Text>
                  <Typography.Text>单车融资覆盖率：{allocationVehicleCoverageText}</Typography.Text>
                </Space>
              }
              showIcon
              style={{ marginBottom: 16 }}
              type="info"
            />
            <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="解除"
          onCancel={() => setReleaseTarget(null)}
          onOk={submitReleaseAllocation}
          open={Boolean(releaseTarget)}
          title="解除车辆分摊"
        >
          <Form<ReleaseAllocationFormValues> form={releaseForm} layout="vertical">
            <Form.Item label="解除日期" name="releasedAt" rules={[{ required: true, message: "请选择解除日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="结清"
          onCancel={() => setSettleTarget(null)}
          onOk={submitSettleInstrument}
          open={Boolean(settleTarget)}
          title="结清融资工具"
        >
          <Form<SettleInstrumentFormValues> form={settleForm} layout="vertical">
            <Form.Item label="结清日期" name="settledAt" rules={[{ required: true, message: "请选择结清日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
