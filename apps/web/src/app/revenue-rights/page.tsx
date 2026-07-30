"use client";

import { EyeOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
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
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  FINANCING_INSTRUMENT_STATUS_LABELS,
  FINANCING_INSTRUMENT_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS,
  REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS,
  REVENUE_RIGHT_TARGET_TYPE_LABELS,
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
  percentToBps,
  safeText
} from "../../lib/capital-format";

interface AssignmentVehicle {
  acquisitionMode?: string | null;
  id: string;
  plateNo?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface AssignmentOrder {
  id: string;
  orderNo?: string | null;
  vehicleId?: string | null;
}

interface OrderOptionRow extends AssignmentOrder {
  customer?: { mobile?: string | null; name?: string | null } | null;
  modelCodeSnapshot?: string | null;
  modelDisplayName?: string | null;
  orderStatus?: string | null;
}

interface AssignmentBill {
  billNo?: string | null;
  billType?: string | null;
  id: string;
  paidAmount?: number | null;
  remainingAmount?: number | null;
}

interface BillOptionRow extends AssignmentBill {
  amount?: number | null;
  billStatus?: string | null;
  dueDate?: string | null;
  orderId?: string | null;
}

interface AssignmentInstrument {
  contractNo?: string | null;
  id: string;
  instrumentNo?: string | null;
  instrumentStatus?: string | null;
  instrumentType?: string | null;
  lenderName?: string | null;
}

interface FinancingInstrumentListResponse {
  items: AssignmentInstrument[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleOptionRow extends AssignmentVehicle {
  model?: string | null;
  modelCode?: string | null;
  modelDefinitionId?: string | null;
  modelDisplayName?: string | null;
}

interface RevenueRightAssignmentRow {
  assigneeName?: string | null;
  assigneeType: string;
  assignmentNo: string;
  assignmentStatus: string;
  assignmentType: string;
  bill?: AssignmentBill | null;
  billId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  financingInstrument?: AssignmentInstrument | null;
  financingInstrumentId?: string | null;
  id: string;
  order?: AssignmentOrder | null;
  orderId?: string | null;
  priority?: number | null;
  releaseReason?: string | null;
  releasedAt?: string | null;
  remark?: string | null;
  shareRatioBps?: number | null;
  targetType: string;
  vehicle?: AssignmentVehicle | null;
  vehicleId?: string | null;
}

interface AssignmentListResponse {
  items: RevenueRightAssignmentRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface AssignmentFilterValues {
  assigneeType?: string;
  assignmentStatus?: string;
  assignmentType?: string;
  billId?: string;
  financingInstrumentId?: string;
  orderId?: string;
  targetType?: string;
  vehicleId?: string;
}

interface AssignmentFormValues {
  assigneeName?: string | null;
  assigneeType: string;
  assignmentType: string;
  billId?: string | null;
  effectiveFrom: Dayjs;
  financingInstrumentId?: string | null;
  orderId?: string | null;
  priority?: number | null;
  remark?: string | null;
  shareRatioPercent?: number | null;
  targetType: string;
  vehicleId?: string | null;
}

interface ReleaseAssignmentFormValues {
  releaseReason?: string | null;
  releasedAt: Dayjs;
  remark?: string | null;
}

const statusColors: Record<string, string> = {
  ACTIVE: "green",
  CANCELLED: "default",
  RELEASED: "blue"
};

const financingRequiredTypes = new Set(["PLEDGE", "TRANSFER", "SPV_POOL"]);

function formatTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={statusColors[value] ?? "default"}>{labelOf(labels, value)}</Tag>;
}

function vehicleText(vehicle?: AssignmentVehicle | null, vehicleId?: string | null) {
  if (!vehicle) {
    return vehicleId ?? "-";
  }
  return [vehicle.vehicleNo, vehicle.plateNo, vehicle.vin].filter(Boolean).join(" / ") || vehicle.id;
}

function orderText(order?: AssignmentOrder | null, orderId?: string | null) {
  return order?.orderNo ?? orderId ?? "-";
}

function billText(bill?: AssignmentBill | null, billId?: string | null) {
  return bill?.billNo ?? billId ?? "-";
}

function instrumentText(instrument?: AssignmentInstrument | null, instrumentId?: string | null) {
  if (!instrument) {
    return instrumentId ?? "-";
  }
  return [instrument.instrumentNo, instrument.lenderName].filter(Boolean).join(" / ") || instrument.id;
}

function instrumentOptionLabel(instrument: AssignmentInstrument) {
  const typeLabel = instrument.instrumentType
    ? labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, instrument.instrumentType)
    : null;
  const statusLabel = instrument.instrumentStatus
    ? labelOf(FINANCING_INSTRUMENT_STATUS_LABELS, instrument.instrumentStatus)
    : null;

  return [instrument.instrumentNo, typeLabel, instrument.lenderName, instrument.contractNo, statusLabel]
    .filter(Boolean)
    .join(" / ");
}

function vehicleOptionLabel(vehicle: VehicleOptionRow) {
  return [
    vehicle.vehicleNo,
    vehicle.plateNo,
    vehicle.vin,
    vehicle.modelDisplayName ?? vehicle.modelCode ?? vehicle.model
  ]
    .filter(Boolean)
    .join(" / ");
}

function orderOptionLabel(order: OrderOptionRow) {
  const statusLabel = order.orderStatus ? labelOf(ORDER_STATUS_LABELS, order.orderStatus) : null;
  const label = [
    order.orderNo,
    order.customer?.name,
    order.customer?.mobile,
    order.modelDisplayName ?? order.modelCodeSnapshot,
    statusLabel
  ]
    .filter(Boolean)
    .join(" / ");
  return label || order.id;
}

function billOptionLabel(bill: BillOptionRow) {
  const typeLabel = bill.billType ? labelOf(BILL_TYPE_LABELS, bill.billType) : null;
  const statusLabel = bill.billStatus ? labelOf(BILL_STATUS_LABELS, bill.billStatus) : null;
  const label = [bill.billNo, typeLabel, statusLabel, formatYuan(bill.amount), formatDate(bill.dueDate)]
    .filter((value) => value && value !== "-")
    .join(" / ");
  return label || bill.id;
}

function targetObjectText(record: RevenueRightAssignmentRow) {
  if (record.targetType === "ORDER") {
    return `订单：${orderText(record.order, record.orderId)}`;
  }

  if (record.targetType === "RECEIVABLE_BILL") {
    return `账单：${billText(record.bill, record.billId)}`;
  }

  if (record.targetType === "VEHICLE") {
    return `车辆：${vehicleText(record.vehicle, record.vehicleId)}`;
  }

  if (record.targetType === "VEHICLE_POOL") {
    return "车辆池：暂未绑定明细";
  }

  return "-";
}

export default function RevenueRightsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<AssignmentFilterValues>();
  const [assignmentForm] = Form.useForm<AssignmentFormValues>();
  const [releaseForm] = Form.useForm<ReleaseAssignmentFormValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [rows, setRows] = useState<RevenueRightAssignmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<RevenueRightAssignmentRow | null>(null);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [financingInstruments, setFinancingInstruments] = useState<AssignmentInstrument[]>([]);
  const [financingInstrumentsLoading, setFinancingInstrumentsLoading] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<RevenueRightAssignmentRow | null>(null);
  const [vehicleRows, setVehicleRows] = useState<VehicleOptionRow[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [orderRows, setOrderRows] = useState<OrderOptionRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [filterBillRows, setFilterBillRows] = useState<BillOptionRow[]>([]);
  const [filterBillsLoading, setFilterBillsLoading] = useState(false);
  const [assignmentBillRows, setAssignmentBillRows] = useState<BillOptionRow[]>([]);
  const [assignmentBillsLoading, setAssignmentBillsLoading] = useState(false);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("revenue_right:view");
  const canViewFinancing = permissions.has("financing:view");
  const canViewVehicles = permissions.has("vehicle:view");
  const canViewOrders = permissions.has("order:view");
  const canViewBills = permissions.has("billing:view");
  const selectedTargetType = Form.useWatch("targetType", assignmentForm);
  const selectedAssignmentType = Form.useWatch("assignmentType", assignmentForm);
  const selectedAssignmentOrderId = Form.useWatch("orderId", assignmentForm);
  const selectedFilterOrderId = Form.useWatch("orderId", filterForm);
  const assignmentNeedsFinancing = financingRequiredTypes.has(selectedAssignmentType ?? "");
  const assignmentShowsShareRatio = assignmentNeedsFinancing || selectedAssignmentType === "REVENUE_SHARE";
  const assignmentShowsPriority = assignmentNeedsFinancing;
  const financingInstrumentOptions = useMemo(
    () =>
      financingInstruments.map((instrument) => ({
        label: instrumentOptionLabel(instrument),
        value: instrument.id
      })),
    [financingInstruments]
  );
  const vehicleOptions = useMemo(
    () =>
      vehicleRows.map((vehicle) => ({
        label: vehicleOptionLabel(vehicle),
        value: vehicle.id
      })),
    [vehicleRows]
  );
  const orderOptions = useMemo(
    () =>
      orderRows.map((order) => ({
        label: orderOptionLabel(order),
        value: order.id
      })),
    [orderRows]
  );
  const filterBillOptions = useMemo(
    () =>
      filterBillRows.map((bill) => ({
        label: billOptionLabel(bill),
        value: bill.id
      })),
    [filterBillRows]
  );
  const assignmentBillOptions = useMemo(
    () =>
      assignmentBillRows.map((bill) => ({
        label: billOptionLabel(bill),
        value: bill.id
      })),
    [assignmentBillRows]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const query = buildQuery(filterForm.getFieldsValue());
      const result = await apiFetch<AssignmentListResponse>(`/revenue-right-assignments${query}`);
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
        const nextDetail = await apiFetch<RevenueRightAssignmentRow>(`/revenue-right-assignments/${id}`);
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

  const loadFinancingInstruments = useCallback(async () => {
    setFinancingInstrumentsLoading(true);
    try {
      const result = await apiFetch<FinancingInstrumentListResponse>("/financing-instruments?pageSize=100");
      setFinancingInstruments(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
      setFinancingInstruments([]);
    } finally {
      setFinancingInstrumentsLoading(false);
    }
  }, [message]);

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

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const result = await apiFetch<OrderOptionRow[]>("/orders");
      setOrderRows(result);
    } catch (error) {
      void message.error(getErrorMessage(error));
      setOrderRows([]);
    } finally {
      setOrdersLoading(false);
    }
  }, [message]);

  const loadFilterBills = useCallback(
    async (orderId: string) => {
      setFilterBillsLoading(true);
      try {
        const result = await apiFetch<BillOptionRow[]>(`/orders/${orderId}/bills`);
        setFilterBillRows(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
        setFilterBillRows([]);
      } finally {
        setFilterBillsLoading(false);
      }
    },
    [message]
  );

  const loadAssignmentBills = useCallback(
    async (orderId: string) => {
      setAssignmentBillsLoading(true);
      try {
        const result = await apiFetch<BillOptionRow[]>(`/orders/${orderId}/bills`);
        setAssignmentBillRows(result);
      } catch (error) {
        void message.error(getErrorMessage(error));
        setAssignmentBillRows([]);
      } finally {
        setAssignmentBillsLoading(false);
      }
    },
    [message]
  );

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
    if (canViewFinancing) {
      void loadFinancingInstruments();
    }
  }, [canViewFinancing, loadFinancingInstruments]);

  useEffect(() => {
    if (canViewVehicles) {
      void loadVehicles();
    }
  }, [canViewVehicles, loadVehicles]);

  useEffect(() => {
    if (canViewOrders) {
      void loadOrders();
    }
  }, [canViewOrders, loadOrders]);

  useEffect(() => {
    filterForm.setFieldValue("billId", undefined);
    setFilterBillRows([]);

    if (selectedFilterOrderId && canViewBills) {
      void loadFilterBills(selectedFilterOrderId);
    }
  }, [canViewBills, filterForm, loadFilterBills, selectedFilterOrderId]);

  useEffect(() => {
    if (!assignmentModalOpen || selectedTargetType !== "RECEIVABLE_BILL") {
      setAssignmentBillRows([]);
      return;
    }

    assignmentForm.setFieldValue("billId", undefined);
    setAssignmentBillRows([]);

    if (selectedAssignmentOrderId && canViewBills) {
      void loadAssignmentBills(selectedAssignmentOrderId);
    }
  }, [
    assignmentForm,
    assignmentModalOpen,
    canViewBills,
    loadAssignmentBills,
    selectedAssignmentOrderId,
    selectedTargetType
  ]);

  useEffect(() => {
    if (!assignmentModalOpen) {
      return;
    }

    assignmentForm.setFieldsValue({
      billId: selectedTargetType === "RECEIVABLE_BILL" ? assignmentForm.getFieldValue("billId") : undefined,
      orderId:
        selectedTargetType === "ORDER" || selectedTargetType === "RECEIVABLE_BILL"
          ? assignmentForm.getFieldValue("orderId")
          : undefined,
      vehicleId: selectedTargetType === "VEHICLE" ? assignmentForm.getFieldValue("vehicleId") : undefined
    });
  }, [assignmentForm, assignmentModalOpen, selectedTargetType]);

  useEffect(() => {
    if (!assignmentModalOpen) {
      return;
    }

    if (!assignmentNeedsFinancing) {
      assignmentForm.setFieldsValue({
        financingInstrumentId: undefined,
        priority: undefined
      });
    }

    if (!assignmentShowsShareRatio) {
      assignmentForm.setFieldsValue({ shareRatioPercent: undefined });
    }
  }, [assignmentForm, assignmentModalOpen, assignmentNeedsFinancing, assignmentShowsShareRatio]);

  function openCreate() {
    assignmentForm.resetFields();
    assignmentForm.setFieldsValue({
      assigneeType: "FINANCIER",
      assignmentType: "PLEDGE",
      effectiveFrom: dayjs(),
      shareRatioPercent: 100,
      targetType: "RECEIVABLE_BILL"
    });
    setAssignmentModalOpen(true);
  }

  async function submitAssignment(values: AssignmentFormValues) {
    const needsFinancing = financingRequiredTypes.has(values.assignmentType);
    const showsShareRatio = needsFinancing || values.assignmentType === "REVENUE_SHARE";
    const showsPriority = needsFinancing;

    try {
      await apiFetch("/revenue-right-assignments", {
        body: JSON.stringify({
          assigneeName: values.assigneeName,
          assigneeType: values.assigneeType,
          assignmentType: values.assignmentType,
          billId: values.targetType === "RECEIVABLE_BILL" ? values.billId : undefined,
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          financingInstrumentId: needsFinancing ? values.financingInstrumentId : undefined,
          orderId: values.targetType === "ORDER" ? values.orderId : undefined,
          priority: showsPriority ? values.priority : undefined,
          remark: values.remark,
          shareRatioBps: showsShareRatio ? percentToBps(values.shareRatioPercent) : undefined,
          targetType: values.targetType,
          vehicleId: values.targetType === "VEHICLE" ? values.vehicleId : undefined
        }),
        method: "POST"
      });
      void message.success("收益权安排已创建");
      setAssignmentModalOpen(false);
      assignmentForm.resetFields();
      await loadData();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function openDetail(record: RevenueRightAssignmentRow) {
    setDetailOpen(true);
    await loadDetail(record.id);
  }

  function openReleaseModal(record: RevenueRightAssignmentRow) {
    setReleaseTarget(record);
    releaseForm.resetFields();
    releaseForm.setFieldsValue({ releasedAt: dayjs() });
  }

  async function submitRelease() {
    if (!releaseTarget) {
      return;
    }

    const values = await releaseForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "确认释放该收益权安排？",
      okText: "确认释放",
      onOk: async () => {
        try {
          await apiFetch(`/revenue-right-assignments/${releaseTarget.id}/release`, {
            body: JSON.stringify({
              releaseReason: values.releaseReason,
              releasedAt: values.releasedAt.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("收益权安排已释放");
          setReleaseTarget(null);
          releaseForm.resetFields();
          await loadData();
          if (detail?.id === releaseTarget.id) {
            await loadDetail(releaseTarget.id);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "释放收益权安排"
    });
  }

  const columns: ColumnsType<RevenueRightAssignmentRow> = [
    { dataIndex: "assignmentNo", title: "收益权编号", width: 190 },
    {
      dataIndex: "assignmentType",
      render: (value: string) => labelOf(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS, value),
      title: "类型",
      width: 130
    },
    {
      dataIndex: "assignmentStatus",
      render: (value: string) => formatTag(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS, value),
      title: "状态",
      width: 100
    },
    {
      dataIndex: "targetType",
      render: (value: string) => labelOf(REVENUE_RIGHT_TARGET_TYPE_LABELS, value),
      title: "目标类型",
      width: 120
    },
    { render: (_, record) => targetObjectText(record), title: "目标对象", width: 230 },
    { render: (_, record) => instrumentText(record.financingInstrument, record.financingInstrumentId), title: "融资工具", width: 210 },
    {
      dataIndex: "assigneeType",
      render: (value: string) => labelOf(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS, value),
      title: "受让 / 质押方类型",
      width: 150
    },
    { dataIndex: "assigneeName", render: safeText, title: "受让 / 质押方名称", width: 170 },
    { dataIndex: "priority", render: safeText, title: "优先级", width: 90 },
    { dataIndex: "shareRatioBps", render: formatPercentFromBps, title: "分配比例", width: 110 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "releasedAt", render: formatDate, title: "解除日期", width: 120 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <ActionButton icon={<EyeOutlined />} onClick={() => openDetail(record)} permission="revenue_right:view" permissions={permissions} size="small">
            查看详情
          </ActionButton>
          <ActionButton
            allowed={record.assignmentStatus === "ACTIVE"}
            disabledReason="仅生效中的收益权安排可以释放"
            icon={<StopOutlined />}
            onClick={() => openReleaseModal(record)}
            permission="revenue_right:manage"
            permissions={permissions}
            size="small"
          >
            释放
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 180
    }
  ];

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            收益权管理
          </Typography.Title>
          <Space>
            <ActionButton icon={<PlusOutlined />} onClick={openCreate} permission="revenue_right:manage" permissions={permissions} type="primary">
              新增收益权安排
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </Space>

        <Form form={filterForm} layout="inline" onFinish={loadData}>
          <Form.Item label="收益权类型" name="assignmentType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS)} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label="状态" name="assignmentStatus">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS)} style={{ width: 130 }} />
          </Form.Item>
          <Form.Item label="目标类型" name="targetType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_TARGET_TYPE_LABELS)} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item label="车辆" name="vehicleId">
            <Select
              allowClear
              disabled={!canViewVehicles}
              loading={vehiclesLoading}
              optionFilterProp="label"
              options={vehicleOptions}
              placeholder={canViewVehicles ? "搜索车辆编号 / 车牌 / VIN / 车型" : "当前账号缺少车辆查看权限"}
              showSearch
              style={{ width: 240 }}
            />
          </Form.Item>
          <Form.Item label="订单" name="orderId">
            <Select
              allowClear
              disabled={!canViewOrders}
              loading={ordersLoading}
              optionFilterProp="label"
              options={orderOptions}
              placeholder={canViewOrders ? "搜索订单号 / 客户 / 车型" : "当前账号缺少订单查看权限"}
              showSearch
              style={{ width: 260 }}
            />
          </Form.Item>
          <Form.Item label="账单" name="billId">
            <Select
              allowClear
              disabled={!canViewBills || !selectedFilterOrderId}
              loading={filterBillsLoading}
              optionFilterProp="label"
              options={filterBillOptions}
              placeholder={
                canViewBills
                  ? selectedFilterOrderId
                    ? "搜索账单编号 / 类型 / 状态"
                    : "请先选择订单"
                  : "当前账号缺少账单查看权限"
              }
              showSearch
              style={{ width: 260 }}
            />
          </Form.Item>
          <Form.Item label="融资工具" name="financingInstrumentId">
            <Select
              allowClear
              disabled={!canViewFinancing}
              loading={financingInstrumentsLoading}
              optionFilterProp="label"
              options={financingInstrumentOptions}
              placeholder={canViewFinancing ? "搜索融资工具编号 / 资金方 / 合同编号" : "当前账号缺少融资工具查看权限"}
              showSearch
              style={{ width: 260 }}
            />
          </Form.Item>
          <Form.Item label="受让方类型" name="assigneeType">
            <Select allowClear options={optionsFromLabels(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS)} style={{ width: 150 }} />
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
          scroll={{ x: 2260 }}
          size="small"
        />

        <Drawer
          destroyOnHidden
          loading={detailLoading}
          onClose={() => {
            setDetailOpen(false);
            setDetail(null);
          }}
          open={detailOpen}
          size="large"
          title={detail ? `${detail.assignmentNo} 收益权详情` : "收益权详情"}
        >
          {detail ? (
            <Descriptions
              bordered
              column={2}
              items={[
                { label: "收益权编号", children: detail.assignmentNo },
                { label: "类型", children: labelOf(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS, detail.assignmentType) },
                { label: "状态", children: formatTag(REVENUE_RIGHT_ASSIGNMENT_STATUS_LABELS, detail.assignmentStatus) },
                { label: "目标类型", children: labelOf(REVENUE_RIGHT_TARGET_TYPE_LABELS, detail.targetType) },
                { label: "车辆", children: vehicleText(detail.vehicle, detail.vehicleId) },
                { label: "订单", children: orderText(detail.order, detail.orderId) },
                { label: "账单", children: billText(detail.bill, detail.billId) },
                { label: "账单已收金额", children: formatYuan(detail.bill?.paidAmount) },
                { label: "融资工具", children: instrumentText(detail.financingInstrument, detail.financingInstrumentId) },
                {
                  label: "融资类型",
                  children: labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, detail.financingInstrument?.instrumentType)
                },
                { label: "受让 / 质押方类型", children: labelOf(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS, detail.assigneeType) },
                { label: "受让 / 质押方名称", children: safeText(detail.assigneeName) },
                { label: "优先级", children: safeText(detail.priority) },
                { label: "分配比例", children: formatPercentFromBps(detail.shareRatioBps) },
                { label: "生效日期", children: formatDate(detail.effectiveFrom) },
                { label: "结束日期", children: formatDate(detail.effectiveTo) },
                { label: "解除日期", children: formatDate(detail.releasedAt) },
                { label: "释放原因", children: safeText(detail.releaseReason) },
                { label: "备注", children: safeText(detail.remark) }
              ]}
            />
          ) : null}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setAssignmentModalOpen(false)}
          onOk={() => assignmentForm.submit()}
          open={assignmentModalOpen}
          title="新增收益权安排"
          width={720}
        >
          <Form<AssignmentFormValues> form={assignmentForm} layout="vertical" onFinish={submitAssignment}>
            <Form.Item label="收益权类型" name="assignmentType" rules={[{ required: true, message: "请选择收益权类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_ASSIGNMENT_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="目标类型" name="targetType" rules={[{ required: true, message: "请选择目标类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_TARGET_TYPE_LABELS)} />
            </Form.Item>
            {selectedTargetType === "VEHICLE" ? (
              <>
                {!canViewVehicles ? (
                  <Alert
                    message="当前账号缺少车辆查看权限，无法选择车辆。请使用具备 vehicle:view 权限的账号。"
                    showIcon
                    style={{ marginBottom: 16 }}
                    type="warning"
                  />
                ) : null}
                <Form.Item label="车辆" name="vehicleId" rules={[{ required: true, message: "请选择车辆" }]}>
                  <Select
                    disabled={!canViewVehicles}
                    loading={vehiclesLoading}
                    optionFilterProp="label"
                    options={vehicleOptions}
                    placeholder="搜索车辆编号 / 车牌 / VIN / 车型"
                    showSearch
                  />
                </Form.Item>
              </>
            ) : null}
            {selectedTargetType === "ORDER" ? (
              <>
                {!canViewOrders ? (
                  <Alert
                    message="当前账号缺少订单查看权限，无法选择订单。请使用具备 order:view 权限的账号。"
                    showIcon
                    style={{ marginBottom: 16 }}
                    type="warning"
                  />
                ) : null}
                <Form.Item label="订单" name="orderId" rules={[{ required: true, message: "请选择订单" }]}>
                  <Select
                    disabled={!canViewOrders}
                    loading={ordersLoading}
                    optionFilterProp="label"
                    options={orderOptions}
                    placeholder="搜索订单号 / 客户 / 车型 / 状态"
                    showSearch
                  />
                </Form.Item>
              </>
            ) : null}
            {selectedTargetType === "RECEIVABLE_BILL" ? (
              <>
                {!canViewOrders ? (
                  <Alert
                    message="当前账号缺少订单查看权限，无法先选择账单所属订单。请使用具备 order:view 权限的账号。"
                    showIcon
                    style={{ marginBottom: 16 }}
                    type="warning"
                  />
                ) : null}
                {!canViewBills ? (
                  <Alert
                    message="当前账号缺少账单查看权限，无法选择应收账单。请使用具备 billing:view 权限的账号。"
                    showIcon
                    style={{ marginBottom: 16 }}
                    type="warning"
                  />
                ) : null}
                <Form.Item label="账单所属订单" name="orderId" rules={[{ required: true, message: "请选择账单所属订单" }]}>
                  <Select
                    disabled={!canViewOrders}
                    loading={ordersLoading}
                    optionFilterProp="label"
                    options={orderOptions}
                    placeholder="搜索订单号 / 客户 / 车型 / 状态"
                    showSearch
                  />
                </Form.Item>
                <Form.Item label="账单" name="billId" rules={[{ required: true, message: "请选择账单" }]}>
                  <Select
                    disabled={!canViewBills || !selectedAssignmentOrderId}
                    loading={assignmentBillsLoading}
                    optionFilterProp="label"
                    options={assignmentBillOptions}
                    placeholder={selectedAssignmentOrderId ? "搜索账单编号 / 类型 / 状态" : "请先选择账单所属订单"}
                    showSearch
                  />
                </Form.Item>
              </>
            ) : null}
            {selectedTargetType === "VEHICLE_POOL" ? (
              <Alert
                message="车辆池目标第一版暂未开放明细选择，请在备注中记录车辆池范围。"
                showIcon
                style={{ marginBottom: 16 }}
                type="info"
              />
            ) : null}
            {assignmentNeedsFinancing ? (
              <Form.Item
                label="融资工具"
                name="financingInstrumentId"
                rules={[{ required: true, message: "请选择融资工具" }]}
              >
                {financingInstrumentOptions.length > 0 ? (
                  <Select
                    disabled={!canViewFinancing}
                    loading={financingInstrumentsLoading}
                    optionFilterProp="label"
                    options={financingInstrumentOptions}
                    placeholder="搜索融资工具编号 / 类型 / 资金方 / 合同编号 / 状态"
                    showSearch
                  />
                ) : (
                  <Select
                    disabled={!canViewFinancing}
                    loading={financingInstrumentsLoading}
                    options={[]}
                    placeholder={canViewFinancing ? "暂无可选融资工具" : "当前账号缺少融资工具查看权限"}
                  />
                )}
              </Form.Item>
            ) : null}
            <Form.Item label="受让 / 质押方类型" name="assigneeType" rules={[{ required: true, message: "请选择受让 / 质押方类型" }]}>
              <Select options={optionsFromLabels(REVENUE_RIGHT_ASSIGNEE_TYPE_LABELS)} />
            </Form.Item>
            <Form.Item label="受让 / 质押方名称" name="assigneeName">
              <Input maxLength={128} />
            </Form.Item>
            {assignmentShowsPriority ? (
              <Form.Item label="优先级" name="priority">
                <InputNumber min={0} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
            {assignmentShowsShareRatio ? (
              <Form.Item label="分配比例（%）" name="shareRatioPercent">
                <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
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
          okText="释放"
          onCancel={() => setReleaseTarget(null)}
          onOk={submitRelease}
          open={Boolean(releaseTarget)}
          title="释放收益权安排"
        >
          <Form<ReleaseAssignmentFormValues> form={releaseForm} layout="vertical">
            <Form.Item label="释放日期" name="releasedAt" rules={[{ required: true, message: "请选择释放日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="释放原因" name="releaseReason">
              <Input.TextArea rows={3} />
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
