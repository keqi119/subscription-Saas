"use client";

import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";

import {
  FINANCING_ALLOCATION_STATUS_LABELS,
  FINANCING_INSTRUMENT_STATUS_LABELS,
  FINANCING_INSTRUMENT_TYPE_LABELS,
  FINANCING_REPAYMENT_METHOD_LABELS,
  REVENUE_SHARE_BASIS_LABELS,
  REVENUE_SHARE_RULE_STATUS_LABELS,
  REVENUE_SHARE_RULE_TYPE_LABELS,
  REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS,
  VEHICLE_ACQUISITION_MODE_LABELS,
  VEHICLE_CAPITAL_EVENT_STATUS_LABELS,
  VEHICLE_CAPITAL_EVENT_TYPE_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import {
  formatDate,
  formatPercentFromBps,
  formatRatio,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  percentToBps,
  toCentAmount,
  yuanFromCents
} from "../../lib/capital-format";
import {
  VEHICLE_CAPITAL_SECTIONS,
  capitalEventFieldVisibility,
  getCapitalWorkspaceActions,
  normalizeCapitalEventDraft,
  summarizeFinancingAllocations,
  type VehicleCapitalEventType,
  type VehicleCapitalSectionKey
} from "../../lib/vehicle-capital-workspace";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface FinancingInstrumentSummary {
  annualRateBps?: number | null;
  contractNo?: string | null;
  id: string;
  instrumentNo?: string | null;
  instrumentStatus?: string | null;
  instrumentType?: string | null;
  lenderName?: string | null;
  principalAmount?: number | null;
  repaymentMethod?: string | null;
}

interface CapitalEvent {
  acquisitionMode?: string | null;
  debtPrincipalAmount?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  equityCapitalAmount?: number | null;
  eventNo: string;
  eventStatus: string;
  eventType: VehicleCapitalEventType;
  externalOwnerName?: string | null;
  financingInstrument?: FinancingInstrumentSummary | null;
  financingInstrumentId?: string | null;
  id: string;
  lessorName?: string | null;
  managedOwnerName?: string | null;
  remark?: string | null;
}

interface FinancingAllocation {
  allocatedPrincipalAmount: number;
  allocationNo?: string | null;
  allocationRatioBps?: number | null;
  allocationStatus: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  financingInstrument?: FinancingInstrumentSummary | null;
  id: string;
  instrumentId?: string | null;
  remark?: string | null;
}

interface CapitalStructurePreview {
  acquisitionMode?: string | null;
  activeCapitalEvents?: CapitalEvent[];
  activeFinancingAllocations?: FinancingAllocation[];
  annualDebtInterestAmount?: number | null;
  capitalCoverageAmount?: number | null;
  capitalCoverageIncomplete?: boolean;
  capitalCoverageRatio?: number | null;
  debtPrincipalAmount?: number | null;
  equityCapitalAmount?: number | null;
  financingInstruments?: FinancingInstrumentSummary[];
  missingReasons?: string[];
  monthlyDebtInterestAmount?: number | null;
  purchasePriceAmount?: number | null;
  roeDataReady?: boolean;
}

interface RevenueShareRule {
  effectiveFrom: string;
  effectiveTo?: string | null;
  fixedMonthlyAmount?: number | null;
  id: string;
  minimumGuaranteeAmount?: number | null;
  ownerContact?: string | null;
  ownerName?: string | null;
  ownerShareBps?: number | null;
  platformShareBps?: number | null;
  remark?: string | null;
  ruleNo: string;
  ruleStatus: string;
  ruleType: string;
  settlementCycle: string;
  shareBasis: string;
}

interface RevenueSharePreview {
  preview: {
    fixedCostAmount?: number | null;
    ownerShareAmount?: number | null;
    platformShareAmount?: number | null;
    previewSupported: boolean;
    shareBaseAmount?: number | null;
    unsupportedReason?: string | null;
    warnings?: string[];
  } | null;
  rule?: RevenueShareRule | null;
}

interface CapitalEventFormValues {
  acquisitionMode?: string | null;
  debtPrincipalAmountYuan?: number | null;
  effectiveFrom: Dayjs;
  equityCapitalAmountYuan?: number | null;
  eventType: VehicleCapitalEventType;
  externalOwnerName?: string | null;
  financingInstrumentId?: string | null;
  lessorName?: string | null;
  managedOwnerName?: string | null;
  remark?: string | null;
}

interface RevenueShareRuleFormValues {
  effectiveFrom: Dayjs;
  fixedMonthlyAmountYuan?: number | null;
  minimumGuaranteeAmountYuan?: number | null;
  ownerContact?: string | null;
  ownerName?: string | null;
  ownerSharePercent?: number | null;
  platformSharePercent?: number | null;
  remark?: string | null;
  ruleType: string;
  settlementCycle?: string | null;
  shareBasis: string;
}

interface DeactivateRuleFormValues {
  effectiveTo: Dayjs;
  remark?: string | null;
}

interface PreviewFormValues {
  endDate: Dayjs;
  startDate: Dayjs;
}

interface PreviewRange {
  endDate: string;
  startDate: string;
}

const capitalEventTypeOptions = optionsFromLabels(VEHICLE_CAPITAL_EVENT_TYPE_LABELS);
const acquisitionModeOptions = optionsFromLabels(VEHICLE_ACQUISITION_MODE_LABELS);
const ruleTypeOptions = optionsFromLabels(REVENUE_SHARE_RULE_TYPE_LABELS);
const shareBasisOptions = optionsFromLabels(REVENUE_SHARE_BASIS_LABELS);
const settlementCycleOptions = optionsFromLabels(REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS);
const financingEventTypes = new Set<VehicleCapitalEventType>([
  "ADD_DEBT_FINANCING",
  "REFINANCE",
  "EARLY_SETTLEMENT",
  "FINANCING_RELEASE"
]);

export function VehicleCapitalTab({
  permissions,
  vehicle
}: Readonly<VehicleWorkspaceTabProps>) {
  const { message } = App.useApp();
  const [eventForm] = Form.useForm<CapitalEventFormValues>();
  const [ruleForm] = Form.useForm<RevenueShareRuleFormValues>();
  const [deactivateForm] = Form.useForm<DeactivateRuleFormValues>();
  const [previewForm] = Form.useForm<PreviewFormValues>();
  const [activeSection, setActiveSection] = useState<VehicleCapitalSectionKey>("overview");
  const [capitalStructure, setCapitalStructure] = useState<CapitalStructurePreview | null>(null);
  const [capitalEvents, setCapitalEvents] = useState<CapitalEvent[]>([]);
  const [revenueShareRules, setRevenueShareRules] = useState<RevenueShareRule[]>([]);
  const [revenueSharePreview, setRevenueSharePreview] = useState<RevenueSharePreview | null>(null);
  const [previewRange, setPreviewRange] = useState<PreviewRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CapitalEvent | null>(null);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [deactivatingRule, setDeactivatingRule] = useState<RevenueShareRule | null>(null);
  const actions = getCapitalWorkspaceActions(permissions);
  const vehicleId = vehicle.id;
  const eventType = Form.useWatch("eventType", eventForm) ?? "INITIAL_EQUITY_PURCHASE";
  const ruleType = Form.useWatch("ruleType", ruleForm) ?? "REVENUE_SHARE";
  const ownerSharePercent = Form.useWatch("ownerSharePercent", ruleForm);
  const platformSharePercent = Form.useWatch("platformSharePercent", ruleForm);
  const eventFields = capitalEventFieldVisibility(eventType);
  const showShareRatio = ruleType === "REVENUE_SHARE" || ruleType === "MIXED";
  const showFixedAmount = ruleType === "FIXED_RENT" || ruleType === "MIXED";
  const showMinimumGuarantee = ruleType === "MIXED";
  const ratioTotal =
    typeof ownerSharePercent === "number" && typeof platformSharePercent === "number"
      ? ownerSharePercent + platformSharePercent
      : null;

  const loadDomain = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      const initialRange = {
        endDate: dayjs().endOf("month").format("YYYY-MM-DD"),
        startDate: dayjs().startOf("month").format("YYYY-MM-DD")
      };
      previewForm.setFieldsValue({
        endDate: dayjs(initialRange.endDate),
        startDate: dayjs(initialRange.startDate)
      });

      try {
        const [structure, events, rules, preview] = await Promise.all([
          actions.canViewCapitalStructure
            ? apiFetch<CapitalStructurePreview>(
                `/vehicles/${encodeURIComponent(vehicleId)}/capital-structure`,
                { signal }
              )
            : Promise.resolve(null),
          actions.canViewCapitalStructure
            ? apiFetch<CapitalEvent[]>(
                `/vehicles/${encodeURIComponent(vehicleId)}/capital-events`,
                { signal }
              )
            : Promise.resolve([]),
          actions.canViewRevenueShareRules
            ? apiFetch<RevenueShareRule[]>(
                `/vehicles/${encodeURIComponent(vehicleId)}/revenue-share-rules`,
                { signal }
              )
            : Promise.resolve([]),
          actions.canPreviewRevenueShare
            ? apiFetch<RevenueSharePreview>(
                previewPath(vehicleId, initialRange),
                { signal }
              )
            : Promise.resolve(null)
        ]);
        setCapitalStructure(structure);
        setCapitalEvents(events);
        setRevenueShareRules(rules);
        setRevenueSharePreview(preview);
        setPreviewRange(actions.canPreviewRevenueShare ? initialRange : null);
      } catch (loadError) {
        if (!signal?.aborted) {
          setError(getErrorMessage(loadError));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [
      actions.canPreviewRevenueShare,
      actions.canViewCapitalStructure,
      actions.canViewRevenueShareRules,
      previewForm,
      vehicleId
    ]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDomain(controller.signal);
    return () => controller.abort();
  }, [loadDomain]);

  async function refreshCapital() {
    if (!actions.canViewCapitalStructure) {
      return;
    }
    const [structure, events] = await Promise.all([
      apiFetch<CapitalStructurePreview>(
        `/vehicles/${encodeURIComponent(vehicleId)}/capital-structure`
      ),
      apiFetch<CapitalEvent[]>(`/vehicles/${encodeURIComponent(vehicleId)}/capital-events`)
    ]);
    setCapitalStructure(structure);
    setCapitalEvents(events);
  }

  async function refreshRulesAndDisplayedPreview() {
    const [rules, preview] = await Promise.all([
      actions.canViewRevenueShareRules
        ? apiFetch<RevenueShareRule[]>(
            `/vehicles/${encodeURIComponent(vehicleId)}/revenue-share-rules`
          )
        : Promise.resolve([]),
      actions.canPreviewRevenueShare && previewRange
        ? apiFetch<RevenueSharePreview>(previewPath(vehicleId, previewRange))
        : Promise.resolve(null)
    ]);
    setRevenueShareRules(rules);
    if (preview) {
      setRevenueSharePreview(preview);
    }
  }

  function openCreateEvent(allocation?: FinancingAllocation) {
    setEditingEvent(null);
    eventForm.resetFields();
    eventForm.setFieldsValue({
      debtPrincipalAmountYuan: allocation
        ? yuanFromCents(allocation.allocatedPrincipalAmount)
        : undefined,
      effectiveFrom: allocation ? dayjs(allocation.effectiveFrom) : dayjs(),
      eventType: allocation ? "ADD_DEBT_FINANCING" : "INITIAL_EQUITY_PURCHASE",
      financingInstrumentId:
        allocation?.financingInstrument?.id ?? allocation?.instrumentId ?? undefined,
      remark: allocation
        ? `根据融资分摊${allocation.allocationNo ? ` ${allocation.allocationNo}` : ""}补录资本事件`
        : undefined
    });
    setEventOpen(true);
  }

  function openEditEvent(event: CapitalEvent) {
    setEditingEvent(event);
    eventForm.resetFields();
    eventForm.setFieldsValue({
      acquisitionMode: event.acquisitionMode,
      debtPrincipalAmountYuan: yuanFromCents(event.debtPrincipalAmount),
      effectiveFrom: dayjs(event.effectiveFrom),
      equityCapitalAmountYuan: yuanFromCents(event.equityCapitalAmount),
      eventType: event.eventType,
      externalOwnerName: event.externalOwnerName,
      financingInstrumentId: event.financingInstrument?.id ?? event.financingInstrumentId,
      lessorName: event.lessorName,
      managedOwnerName: event.managedOwnerName,
      remark: event.remark
    });
    setEventOpen(true);
  }

  async function saveEvent(values: CapitalEventFormValues) {
    setSaving(true);
    try {
      const payload = normalizeCapitalEventDraft({
        acquisitionMode: values.acquisitionMode,
        debtPrincipalAmount: toCentAmount(values.debtPrincipalAmountYuan),
        effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
        equityCapitalAmount: toCentAmount(values.equityCapitalAmountYuan),
        eventType: values.eventType,
        externalOwnerName: values.externalOwnerName,
        financingInstrumentId: values.financingInstrumentId,
        lessorName: values.lessorName,
        managedOwnerName: values.managedOwnerName,
        remark: values.remark
      });
      const path = editingEvent
        ? `/vehicles/${encodeURIComponent(vehicleId)}/capital-events/${encodeURIComponent(editingEvent.id)}`
        : `/vehicles/${encodeURIComponent(vehicleId)}/capital-events`;
      await apiFetch(path, {
        body: JSON.stringify(payload),
        method: editingEvent ? "PATCH" : "POST"
      });
      setEventOpen(false);
      setEditingEvent(null);
      eventForm.resetFields();
      await refreshCapital();
      void message.success(editingEvent ? "资本事件已更新" : "资本事件已新增");
    } catch (saveError) {
      void message.error(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  function cancelEvent(event: CapitalEvent) {
    Modal.confirm({
      cancelText: "取消",
      content: "作废后该事件不再参与资本结构试算，但会保留审计记录。",
      okText: "确认作废",
      onOk: async () => {
        try {
          await apiFetch(
            `/vehicles/${encodeURIComponent(vehicleId)}/capital-events/${encodeURIComponent(event.id)}/cancel`,
            { body: JSON.stringify({ remark: "人工作废资本事件" }), method: "POST" }
          );
          await refreshCapital();
          void message.success("资本事件已作废");
        } catch (cancelError) {
          void message.error(getErrorMessage(cancelError));
        }
      },
      title: "作废资本事件"
    });
  }

  function openCreateRule() {
    ruleForm.resetFields();
    ruleForm.setFieldsValue({
      effectiveFrom: dayjs(),
      ownerSharePercent: 30,
      platformSharePercent: 70,
      ruleType: "REVENUE_SHARE",
      settlementCycle: "MONTHLY",
      shareBasis: "RENTAL_PAID"
    });
    setRuleOpen(true);
  }

  async function saveRule(values: RevenueShareRuleFormValues) {
    const isFixedRent = values.ruleType === "FIXED_RENT";
    const isMixed = values.ruleType === "MIXED";
    const includeRatio = values.ruleType === "REVENUE_SHARE" || isMixed;
    const includeFixed = isFixedRent || isMixed;
    setSaving(true);
    try {
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/revenue-share-rules`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          fixedMonthlyAmount: includeFixed
            ? toCentAmount(values.fixedMonthlyAmountYuan)
            : undefined,
          minimumGuaranteeAmount: isMixed
            ? toCentAmount(values.minimumGuaranteeAmountYuan)
            : undefined,
          ownerContact: values.ownerContact,
          ownerName: values.ownerName,
          ownerShareBps: includeRatio ? percentToBps(values.ownerSharePercent) : undefined,
          platformShareBps: includeRatio
            ? percentToBps(values.platformSharePercent)
            : undefined,
          remark: values.remark,
          ruleType: values.ruleType,
          settlementCycle: values.settlementCycle,
          shareBasis: isFixedRent ? "MANUAL" : values.shareBasis
        }),
        method: "POST"
      });
      setRuleOpen(false);
      ruleForm.resetFields();
      await refreshRulesAndDisplayedPreview();
      void message.success("分润规则已新增");
    } catch (saveError) {
      void message.error(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function deactivateRule() {
    if (!deactivatingRule) {
      return;
    }
    let values: DeactivateRuleFormValues;
    try {
      values = await deactivateForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await apiFetch(
        `/vehicles/${encodeURIComponent(vehicleId)}/revenue-share-rules/${encodeURIComponent(deactivatingRule.id)}/deactivate`,
        {
          body: JSON.stringify({
            effectiveTo: values.effectiveTo.format("YYYY-MM-DD"),
            remark: values.remark
          }),
          method: "POST"
        }
      );
      setDeactivatingRule(null);
      deactivateForm.resetFields();
      await refreshRulesAndDisplayedPreview();
      void message.success("分润规则已停用");
    } catch (deactivateError) {
      void message.error(getErrorMessage(deactivateError));
    } finally {
      setSaving(false);
    }
  }

  async function refreshPreview() {
    let values: PreviewFormValues;
    try {
      values = await previewForm.validateFields();
    } catch {
      return;
    }
    const range = {
      endDate: values.endDate.format("YYYY-MM-DD"),
      startDate: values.startDate.format("YYYY-MM-DD")
    };
    setSaving(true);
    try {
      setRevenueSharePreview(
        await apiFetch<RevenueSharePreview>(previewPath(vehicleId, range))
      );
      setPreviewRange(range);
    } catch (previewError) {
      void message.error(getErrorMessage(previewError));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <Spin tip="正在加载资本与分润数据" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      {error ? (
        <Alert
          action={<Button onClick={() => void loadDomain()}>重试</Button>}
          description={error}
          message="资本与分润数据加载失败"
          showIcon
          type="error"
        />
      ) : null}
      <Tabs
        activeKey={activeSection}
        items={VEHICLE_CAPITAL_SECTIONS.map(({ key, label }) => ({ key, label }))}
        onChange={(key) => setActiveSection(key as VehicleCapitalSectionKey)}
      />
      {activeSection === "overview" ? (
        <CapitalOverview structure={capitalStructure} />
      ) : null}
      {activeSection === "events" ? (
        <CapitalEvents
          canManage={actions.canManageCapitalEvents}
          events={capitalEvents}
          onCancel={cancelEvent}
          onCreate={() => openCreateEvent()}
          onEdit={openEditEvent}
        />
      ) : null}
      {activeSection === "allocations" ? (
        <CapitalAllocations
          allocations={capitalStructure?.activeFinancingAllocations ?? []}
          canManage={actions.canManageCapitalEvents}
          events={capitalEvents}
          instruments={capitalStructure?.financingInstruments ?? []}
          onCreateEvent={openCreateEvent}
        />
      ) : null}
      {activeSection === "revenue-rules" ? (
        <RevenueRules
          canManage={actions.canManageRevenueShareRules}
          onCreate={openCreateRule}
          onDeactivate={(rule) => {
            setDeactivatingRule(rule);
            deactivateForm.setFieldsValue({ effectiveTo: dayjs() });
          }}
          rules={revenueShareRules}
        />
      ) : null}
      {activeSection === "revenue-preview" ? (
        <RevenuePreviewSection
          canPreview={actions.canPreviewRevenueShare}
          form={previewForm}
          loading={saving}
          onRefresh={() => void refreshPreview()}
          preview={revenueSharePreview}
        />
      ) : null}

      <Modal
        confirmLoading={saving}
        destroyOnHidden
        okText="保存"
        onCancel={() => setEventOpen(false)}
        onOk={() => eventForm.submit()}
        open={eventOpen}
        title={editingEvent ? "编辑资本事件" : "新增资本事件"}
        width={720}
      >
        <Form form={eventForm} layout="vertical" onFinish={(values) => void saveEvent(values)}>
          <Form.Item label="事件类型" name="eventType" rules={[{ required: true, message: "请选择事件类型" }]}>
            <Select options={capitalEventTypeOptions} />
          </Form.Item>
          <Form.Item label="事件时间" name="effectiveFrom" rules={[{ required: true, message: "请选择事件时间" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          {eventFields.showAcquisitionMode ? (
            <Form.Item label="取得方式" name="acquisitionMode">
              <Select allowClear options={acquisitionModeOptions} />
            </Form.Item>
          ) : null}
          {eventFields.showFinancingInstrument ? (
            <Form.Item
              extra="保存系统融资工具 ID，不使用 FI 开头的业务编号。"
              label="融资工具"
              name="financingInstrumentId"
              rules={[{ required: financingEventTypes.has(eventType), message: "请选择融资工具" }]}
            >
              {capitalStructure?.financingInstruments?.length ? (
                <Select
                  optionFilterProp="label"
                  options={capitalStructure.financingInstruments.map((instrument) => ({
                    label: financingInstrumentText(instrument),
                    value: instrument.id
                  }))}
                  showSearch
                />
              ) : (
                <Input placeholder="系统融资工具 ID（UUID）" />
              )}
            </Form.Item>
          ) : null}
          {eventFields.showEquityAmount ? (
            <Form.Item label="自有资金金额（元）" name="equityCapitalAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {eventFields.showDebtAmount ? (
            <Form.Item label="债务本金金额（元）" name="debtPrincipalAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {eventFields.showLessor ? (
            <Form.Item label="出租方名称" name="lessorName">
              <Input maxLength={128} />
            </Form.Item>
          ) : null}
          {eventFields.showManagedOwner ? (
            <>
              <Form.Item label="外部车主名称" name="externalOwnerName">
                <Input maxLength={128} />
              </Form.Item>
              <Form.Item label="托管方名称" name="managedOwnerName">
                <Input maxLength={128} />
              </Form.Item>
            </>
          ) : null}
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={saving}
        destroyOnHidden
        okText="保存"
        onCancel={() => setRuleOpen(false)}
        onOk={() => ruleForm.submit()}
        open={ruleOpen}
        title="新增分润规则"
        width={720}
      >
        <Form form={ruleForm} layout="vertical" onFinish={(values) => void saveRule(values)}>
          <Form.Item label="规则类型" name="ruleType" rules={[{ required: true, message: "请选择规则类型" }]}>
            <Select options={ruleTypeOptions} />
          </Form.Item>
          {ruleType !== "FIXED_RENT" ? (
            <Form.Item label="分润基础" name="shareBasis" rules={[{ required: true, message: "请选择分润基础" }]}>
              <Select options={shareBasisOptions} />
            </Form.Item>
          ) : null}
          <Form.Item label="外部车主名称" name="ownerName">
            <Input maxLength={128} />
          </Form.Item>
          <Form.Item label="外部车主联系方式" name="ownerContact">
            <Input maxLength={128} />
          </Form.Item>
          {showShareRatio ? (
            <>
              <Form.Item
                label="车主分成比例（%）"
                name="ownerSharePercent"
                rules={[{ required: ruleType === "REVENUE_SHARE", message: "请输入车主分成比例" }]}
              >
                <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="平台分成比例（%）" name="platformSharePercent">
                <InputNumber max={100} min={0} precision={2} style={{ width: "100%" }} />
              </Form.Item>
              {ratioTotal !== null && Math.abs(ratioTotal - 100) > 0.0001 ? (
                <Alert message="车主分成与平台分成合计不等于 100%，请确认。" showIcon style={{ marginBottom: 16 }} type="warning" />
              ) : null}
            </>
          ) : null}
          {showFixedAmount ? (
            <Form.Item
              label="固定月金额（元）"
              name="fixedMonthlyAmountYuan"
              rules={[{ required: ruleType === "FIXED_RENT", message: "请输入固定月金额" }]}
            >
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          {showMinimumGuarantee ? (
            <Form.Item label="最低保底金额（元）" name="minimumGuaranteeAmountYuan">
              <InputNumber min={0} precision={2} style={{ width: "100%" }} />
            </Form.Item>
          ) : null}
          <Form.Item label="结算周期" name="settlementCycle">
            <Select options={settlementCycleOptions} />
          </Form.Item>
          <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={saving}
        destroyOnHidden
        okText="停用"
        onCancel={() => setDeactivatingRule(null)}
        onOk={() => void deactivateRule()}
        open={Boolean(deactivatingRule)}
        title="停用分润规则"
      >
        <Form form={deactivateForm} layout="vertical">
          <Form.Item label="停用日期" name="effectiveTo" rules={[{ required: true, message: "请选择停用日期" }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function CapitalOverview({ structure }: Readonly<{ structure: CapitalStructurePreview | null }>) {
  if (!structure) {
    return <Empty description="暂无资本结构数据" />;
  }
  const allocations = summarizeFinancingAllocations(structure.activeFinancingAllocations ?? []);

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      {structure.missingReasons?.length ? (
        <Alert description={structure.missingReasons.join("；")} message="资本数据待补齐" showIcon type="warning" />
      ) : null}
      <Card title="资本总览">
        <Descriptions
          bordered
          column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
          items={[
            { children: formatYuan(structure.purchasePriceAmount), label: "采购价" },
            { children: labelOf(VEHICLE_ACQUISITION_MODE_LABELS, structure.acquisitionMode), label: "取得方式" },
            { children: formatYuan(structure.equityCapitalAmount), label: "自有资金" },
            { children: formatYuan(structure.debtPrincipalAmount), label: "债务本金" },
            { children: formatYuan(structure.capitalCoverageAmount), label: "资本覆盖金额" },
            { children: formatRatio(structure.capitalCoverageRatio), label: "资本覆盖率" },
            { children: formatYuan(structure.annualDebtInterestAmount), label: "年化债务利息试算" },
            { children: formatYuan(structure.monthlyDebtInterestAmount), label: "月度债务利息试算" },
            { children: formatYuan(allocations.allocatedPrincipalAmount), label: "融资分摊本金合计" },
            {
              children: structure.roeDataReady ? <Tag color="green">完整</Tag> : <Tag color="orange">待补录</Tag>,
              label: "ROE 数据"
            }
          ]}
        />
      </Card>
    </Space>
  );
}

function CapitalEvents({
  canManage,
  events,
  onCancel,
  onCreate,
  onEdit
}: Readonly<{
  canManage: boolean;
  events: CapitalEvent[];
  onCancel: (event: CapitalEvent) => void;
  onCreate: () => void;
  onEdit: (event: CapitalEvent) => void;
}>) {
  const columns: ColumnsType<CapitalEvent> = [
    { dataIndex: "eventNo", title: "事件编号", width: 190 },
    { dataIndex: "eventType", render: (value: string) => labelOf(VEHICLE_CAPITAL_EVENT_TYPE_LABELS, value), title: "事件类型", width: 150 },
    { dataIndex: "eventStatus", render: (value: string) => <Tag>{labelOf(VEHICLE_CAPITAL_EVENT_STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "事件时间", width: 120 },
    { render: (_, record) => financingInstrumentText(record.financingInstrument, record.financingInstrumentId), title: "融资工具", width: 220 },
    { dataIndex: "equityCapitalAmount", render: formatYuan, title: "自有资金", width: 140 },
    { dataIndex: "debtPrincipalAmount", render: formatYuan, title: "债务本金", width: 140 },
    { dataIndex: "remark", render: nullableText, title: "备注", width: 180 },
    {
      fixed: "right",
      render: (_, record) =>
        record.eventStatus === "CANCELLED" ? "-" : (
          <Space>
            <Button disabled={!canManage} icon={<EditOutlined />} onClick={() => onEdit(record)} size="small">编辑</Button>
            <Button danger disabled={!canManage} onClick={() => onCancel(record)} size="small">作废</Button>
          </Space>
        ),
      title: "操作",
      width: 150
    }
  ];

  return (
    <Card
      extra={<Button disabled={!canManage} icon={<PlusOutlined />} onClick={onCreate} type="primary">新增资本事件</Button>}
      title="资本事件"
    >
      <Table columns={columns} dataSource={events} pagination={false} rowKey="id" scroll={{ x: 1350 }} />
    </Card>
  );
}

function CapitalAllocations({
  allocations,
  canManage,
  events,
  instruments,
  onCreateEvent
}: Readonly<{
  allocations: FinancingAllocation[];
  canManage: boolean;
  events: CapitalEvent[];
  instruments: FinancingInstrumentSummary[];
  onCreateEvent: (allocation: FinancingAllocation) => void;
}>) {
  const summary = summarizeFinancingAllocations(allocations);
  const instrumentColumns: ColumnsType<FinancingInstrumentSummary> = [
    { dataIndex: "instrumentNo", render: nullableText, title: "融资工具编号" },
    { dataIndex: "instrumentType", render: (value: string | null) => labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, value), title: "类型" },
    { dataIndex: "lenderName", render: nullableText, title: "资金方" },
    { dataIndex: "principalAmount", render: formatYuan, title: "融资本金" },
    { dataIndex: "annualRateBps", render: formatPercentFromBps, title: "年利率" },
    { dataIndex: "repaymentMethod", render: (value: string | null) => labelOf(FINANCING_REPAYMENT_METHOD_LABELS, value), title: "还款方式" },
    { dataIndex: "instrumentStatus", render: (value: string | null) => <Tag>{labelOf(FINANCING_INSTRUMENT_STATUS_LABELS, value)}</Tag>, title: "状态" }
  ];
  const allocationColumns: ColumnsType<FinancingAllocation> = [
    { dataIndex: "allocationNo", render: nullableText, title: "分摊编号", width: 190 },
    { render: (_, record) => financingInstrumentText(record.financingInstrument, record.instrumentId), title: "融资工具", width: 220 },
    { dataIndex: "allocatedPrincipalAmount", render: formatYuan, title: "分摊本金", width: 140 },
    { dataIndex: "allocationRatioBps", render: formatPercentFromBps, title: "分摊比例", width: 120 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "解除日期", width: 120 },
    { dataIndex: "allocationStatus", render: (value: string) => <Tag>{labelOf(FINANCING_ALLOCATION_STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    {
      render: (_, record) => {
        const recorded = hasCapitalEventForAllocation(record, events);
        return recorded ? (
          <Tag color="green">已补录资本事件</Tag>
        ) : (
          <Space>
            <Tag color="orange">待补录资本事件</Tag>
            <Button disabled={!canManage} onClick={() => onCreateEvent(record)} size="small">补录</Button>
          </Space>
        );
      },
      title: "资本事件衔接",
      width: 220
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Alert message="融资分摊只读展示；补录按钮仅预填资本事件，确认保存前不会自动生成记录。" showIcon type="info" />
      <Descriptions
        bordered
        items={[
          { children: summary.allocationCount, label: "有效分摊数" },
          { children: formatYuan(summary.allocatedPrincipalAmount), label: "分摊本金合计" },
          { children: formatPercentFromBps(summary.allocationRatioBps), label: "分摊比例合计" }
        ]}
      />
      <Card title="融资工具">
        <Table columns={instrumentColumns} dataSource={instruments} pagination={false} rowKey="id" scroll={{ x: 1100 }} />
      </Card>
      <Card title="车辆融资分摊">
        <Table columns={allocationColumns} dataSource={allocations} pagination={false} rowKey="id" scroll={{ x: 1350 }} />
      </Card>
    </Space>
  );
}

function RevenueRules({
  canManage,
  onCreate,
  onDeactivate,
  rules
}: Readonly<{
  canManage: boolean;
  onCreate: () => void;
  onDeactivate: (rule: RevenueShareRule) => void;
  rules: RevenueShareRule[];
}>) {
  const columns: ColumnsType<RevenueShareRule> = [
    { dataIndex: "ruleNo", title: "规则编号", width: 190 },
    { dataIndex: "ruleType", render: (value: string) => labelOf(REVENUE_SHARE_RULE_TYPE_LABELS, value), title: "规则类型", width: 150 },
    { dataIndex: "ruleStatus", render: (value: string) => <Tag>{labelOf(REVENUE_SHARE_RULE_STATUS_LABELS, value)}</Tag>, title: "状态", width: 100 },
    { dataIndex: "shareBasis", render: (value: string) => labelOf(REVENUE_SHARE_BASIS_LABELS, value), title: "分润基础", width: 130 },
    { dataIndex: "ownerName", render: nullableText, title: "外部车主", width: 150 },
    { dataIndex: "ownerShareBps", render: formatPercentFromBps, title: "车主分成", width: 120 },
    { dataIndex: "platformShareBps", render: formatPercentFromBps, title: "平台分成", width: 120 },
    { dataIndex: "fixedMonthlyAmount", render: formatYuan, title: "固定月金额", width: 130 },
    { dataIndex: "minimumGuaranteeAmount", render: formatYuan, title: "最低保底", width: 130 },
    { dataIndex: "settlementCycle", render: (value: string) => labelOf(REVENUE_SHARE_SETTLEMENT_CYCLE_LABELS, value), title: "结算周期", width: 120 },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "结束日期", width: 120 },
    {
      fixed: "right",
      render: (_, record) => (
        <Button
          danger
          disabled={!canManage || record.ruleStatus !== "ACTIVE"}
          onClick={() => onDeactivate(record)}
          size="small"
        >
          停用
        </Button>
      ),
      title: "操作",
      width: 90
    }
  ];

  return (
    <Card
      extra={<Button disabled={!canManage} icon={<PlusOutlined />} onClick={onCreate} type="primary">新增分润规则</Button>}
      title="分润规则"
    >
      <Table columns={columns} dataSource={rules} pagination={false} rowKey="id" scroll={{ x: 1700 }} />
    </Card>
  );
}

function RevenuePreviewSection({
  canPreview,
  form,
  loading,
  onRefresh,
  preview
}: Readonly<{
  canPreview: boolean;
  form: ReturnType<typeof Form.useForm<PreviewFormValues>>[0];
  loading: boolean;
  onRefresh: () => void;
  preview: RevenueSharePreview | null;
}>) {
  const data = preview?.preview;

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Alert message="仅试算，不生成结算单或付款记录" showIcon type="info" />
      <Card title="分润试算">
        <Form form={form} layout="inline">
          <Form.Item label="开始日期" name="startDate" rules={[{ required: true, message: "请选择开始日期" }]}>
            <DatePicker />
          </Form.Item>
          <Form.Item label="结束日期" name="endDate" rules={[{ required: true, message: "请选择结束日期" }]}>
            <DatePicker />
          </Form.Item>
          <Form.Item>
            <Button disabled={!canPreview} loading={loading} onClick={onRefresh} type="primary">刷新试算</Button>
          </Form.Item>
        </Form>
      </Card>
      {data ? (
        <Card>
          {!data.previewSupported && data.unsupportedReason ? (
            <Alert message={data.unsupportedReason} showIcon style={{ marginBottom: 16 }} type="warning" />
          ) : null}
          {data.warnings?.length ? (
            <Alert message={data.warnings.join("；")} showIcon style={{ marginBottom: 16 }} type="warning" />
          ) : null}
          <Descriptions
            bordered
            items={[
              { children: data.previewSupported ? <Tag color="green">支持</Tag> : <Tag color="orange">暂不支持</Tag>, label: "试算状态" },
              { children: formatYuan(data.shareBaseAmount), label: "分润基础金额" },
              { children: formatYuan(data.fixedCostAmount), label: "固定成本" },
              { children: formatYuan(data.ownerShareAmount), label: "车主分润" },
              { children: formatYuan(data.platformShareAmount), label: "平台留存" }
            ]}
          />
        </Card>
      ) : (
        <Empty description="暂无可展示的分润试算" />
      )}
    </Space>
  );
}

function hasCapitalEventForAllocation(
  allocation: FinancingAllocation,
  events: readonly CapitalEvent[]
) {
  const instrumentId = allocation.financingInstrument?.id ?? allocation.instrumentId ?? null;
  if (!instrumentId) {
    return false;
  }
  return events.some(
    (event) =>
      event.eventStatus === "ACTIVE" &&
      event.eventType === "ADD_DEBT_FINANCING" &&
      event.financingInstrumentId === instrumentId &&
      event.debtPrincipalAmount === allocation.allocatedPrincipalAmount &&
      event.effectiveFrom.slice(0, 10) === allocation.effectiveFrom.slice(0, 10)
  );
}

function financingInstrumentText(
  instrument?: FinancingInstrumentSummary | null,
  fallbackId?: string | null
) {
  if (!instrument) {
    return fallbackId ?? "-";
  }
  return [
    instrument.instrumentNo,
    instrument.instrumentType
      ? labelOf(FINANCING_INSTRUMENT_TYPE_LABELS, instrument.instrumentType)
      : null,
    instrument.lenderName,
    instrument.contractNo
  ]
    .filter(Boolean)
    .join(" / ");
}

function nullableText(value?: string | null) {
  return value || "-";
}

function previewPath(vehicleId: string, range: PreviewRange) {
  return `/vehicles/${encodeURIComponent(vehicleId)}/revenue-share-preview?startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(range.endDate)}`;
}
