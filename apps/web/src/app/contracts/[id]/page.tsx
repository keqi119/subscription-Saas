"use client";

import { ArrowLeftOutlined, CloudDownloadOutlined, EyeOutlined, FileDoneOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Descriptions, Empty, List, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../../components/action-button";
import { ProtectedShell } from "../../../components/protected-shell";
import {
  ESIGN_PROVIDER_LABELS,
  ESIGN_SIGNER_STATUS_LABELS,
  ESIGN_TASK_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  STATUS_LABELS,
  VEHICLE_BASE_FEE_MODE_LABELS,
  VEHICLE_BATTERY_USAGE_TYPE_LABELS,
  labelOf
} from "../../../constants/labels";
import {
  canArchiveContract,
  canCancelContract,
  canSignContract
} from "../../../lib/action-guards";
import {
  buildAdminESignSignerGroups,
  getAdminESignArchiveStatus
} from "../../../lib/admin-esign-display";
import {
  API_BASE_URL,
  apiFetch,
  ApiError,
  loadAdminJourneyByOrder
} from "../../../lib/api";
import type { AuthMeResponse } from "../../../lib/auth";
import type { AdminSubscriptionJourney } from "../../../lib/subscription-journey-view-model";
import {
  getFadadaBlockingMessage,
  getFadadaReadinessAvailability,
  getFadadaReadinessTone,
  type FadadaOnboardingReadiness
} from "../../../lib/fadada-onboarding-ui";

interface ContractDetail {
  archivedAt?: string | null;
  contractNo: string;
  contractSnapshot?: unknown;
  contractTitle: string;
  createdAt: string;
  customer: { id: string; name: string; mobile: string };
  hasGeneratedPdfArtifact?: boolean;
  id: string;
  order: { orderNo: string; id: string };
  signedAt?: string | null;
  status: string;
  version?: { versionNo: string } | null;
}

interface ContractESignTask {
  archiveError?: string | null;
  archiveStatus?: string | null;
  completedAt?: string | null;
  createdAt: string;
  documentType?: string | null;
  documentName?: string | null;
  hasEvidenceDocument?: boolean;
  hasSignedDocument?: boolean;
  id: string;
  provider: string;
  signers: Array<{
    id: string;
    providerActionType?: string | null;
    providerSignerId?: string | null;
    signedAt?: string | null;
    signerName?: string | null;
    signerPhone?: string | null;
    signerStatus: string;
    signerType: string;
    slotId?: string | null;
  }>;
  signedArtifactAvailable?: boolean;
  signingStage?: string | null;
  startedAt?: string | null;
  taskNo: string;
  taskStatus: string;
  workOrderId?: string | null;
}

type SnapshotRecord = Record<string, unknown>;

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function toNumber(value?: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function formatYuan(value?: unknown) {
  const amount = toNumber(value);
  if (amount === null) {
    return "-";
  }
  return `${(amount / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`;
}

function formatPercent(value?: unknown) {
  const rate = toNumber(value);
  if (rate === null) {
    return "-";
  }
  return `${(rate * 100).toFixed(2)}%`;
}

function formatMonths(value?: unknown) {
  const months = toNumber(value);
  return months === null ? "-" : `${months.toLocaleString("zh-CN")} 个月`;
}

function formatKilometers(value?: unknown) {
  const kilometers = toNumber(value);
  return kilometers === null ? "-" : `${kilometers.toLocaleString("zh-CN")} km`;
}

function formatKwh(value?: unknown) {
  const kwh = toNumber(value);
  return kwh === null ? "-" : `${kwh.toLocaleString("zh-CN")} kWh`;
}

function formatBatteryUsageType(type?: unknown, label?: unknown) {
  const labelText = safeText(label);
  if (labelText !== "-") {
    return labelText;
  }
  const typeText = safeText(type);
  return typeText === "-" ? "-" : labelOf(VEHICLE_BATTERY_USAGE_TYPE_LABELS, typeText);
}

function toSnapshotRecord(value: unknown): SnapshotRecord | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return toSnapshotRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as SnapshotRecord;
  }
  return null;
}

function readSnapshotPath(source: unknown, path: string) {
  let current = source;
  for (const segment of path.split(".")) {
    const record = toSnapshotRecord(current);
    if (!record || !(segment in record)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function getSnapshotValue(snapshot: unknown, ...paths: string[]) {
  for (const path of paths) {
    const value = readSnapshotPath(snapshot, path);
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
}

function joinSnapshotText(...values: unknown[]) {
  const parts = values.map((value) => safeText(value)).filter((value) => value !== "-");
  return parts.length ? parts.join(" / ") : "-";
}

function formatVehicleBaseFeeModeLabel(mode?: unknown, label?: unknown) {
  const explicitLabel = safeText(label);
  if (explicitLabel !== "-") {
    return explicitLabel;
  }
  const modeKey = safeText(mode);
  if (modeKey === "-") {
    return "-";
  }
  return VEHICLE_BASE_FEE_MODE_LABELS[modeKey] ?? modeKey;
}

function formatStatus(value?: unknown) {
  const status = safeText(value);
  return status === "-" ? "-" : labelOf(STATUS_LABELS, status);
}

function formatOrderStatus(value?: unknown) {
  const status = safeText(value);
  return status === "-" ? "-" : labelOf(ORDER_STATUS_LABELS, status);
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

function ContractSnapshotSection({ contract }: { contract: ContractDetail | null }) {
  const snapshot = toSnapshotRecord(contract?.contractSnapshot);
  const orderSnapshot = getSnapshotValue(snapshot, "order");
  const quoteSnapshot = getSnapshotValue(snapshot, "quoteSnapshot", "order.quoteSnapshot");
  const customerSnapshot = getSnapshotValue(snapshot, "customer", "order.customer");
  const vehicleSnapshot =
    getSnapshotValue(orderSnapshot, "vehicle") ??
    getSnapshotValue(quoteSnapshot, "vehicleSnapshot", "vehicle") ??
    getSnapshotValue(snapshot, "vehicle");
  const packageSnapshot = getSnapshotValue(quoteSnapshot, "packageSnapshot", "order.packageSnapshot");
  const depositRuleSnapshot = getSnapshotValue(quoteSnapshot, "depositRuleSnapshot", "order.depositRuleSnapshot");
  const riskSnapshot = getSnapshotValue(quoteSnapshot, "riskResult", "order.riskResult");
  const vehicleBaseFeeMode = getSnapshotValue(
    quoteSnapshot,
    "vehicleBaseFeeMode",
    "packageSnapshot.pricing.vehicleBaseFeeMode",
    "packageSnapshot.vehicleBaseFeeMode",
    "packageSnapshot.subscriptionPlan.monthlyFeeMode"
  );
  const vehicleBaseFeeModeLabel = formatVehicleBaseFeeModeLabel(
    vehicleBaseFeeMode,
    getSnapshotValue(
      quoteSnapshot,
      "vehicleBaseFeeModeLabel",
      "packageSnapshot.pricing.vehicleBaseFeeModeLabel",
      "packageSnapshot.vehicleBaseFeeModeLabel",
      "packageSnapshot.subscriptionPlan.monthlyFeeModeLabel"
    )
  );
  const fixedRate =
    getSnapshotValue(quoteSnapshot, "fixedRate", "packageSnapshot.pricing.fixedRate") ??
    (vehicleBaseFeeMode === "RATE_FORMULA"
      ? getSnapshotValue(quoteSnapshot, "packageSnapshot.subscriptionPlan.monthlyFeeRate", "monthlyFeeRate")
      : undefined);

  return (
    <Space orientation="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        合同快照
      </Typography.Title>
      <Descriptions
        bordered
        column={3}
        size="small"
        title="合同条款 / 模板信息"
        items={[
          { label: "合同编号", children: contract?.contractNo ?? "-" },
          { label: "合同标题", children: contract?.contractTitle ?? "-" },
          { label: "合同状态", children: contract ? labelOf(STATUS_LABELS, contract.status) : "-" },
          { label: "订单编号", children: safeText(getSnapshotValue(orderSnapshot, "orderNo") ?? contract?.order.orderNo) },
          { label: "订单状态", children: formatOrderStatus(getSnapshotValue(orderSnapshot, "orderStatus", "status")) },
          { label: "报价编号", children: safeText(getSnapshotValue(orderSnapshot, "quote.quoteNo") ?? getSnapshotValue(quoteSnapshot, "quoteNo")) },
          { label: "合同版本", children: contract?.version?.versionNo ?? "-" },
          { label: "创建时间", children: formatTime(contract?.createdAt) },
          { label: "签署时间", children: formatTime(contract?.signedAt) }
        ]}
      />
      <Descriptions
        bordered
        column={3}
        size="small"
        title="客户信息快照 / 车辆信息快照"
        items={[
          { label: "客户姓名", children: safeText(getSnapshotValue(customerSnapshot, "name") ?? contract?.customer.name) },
          { label: "客户手机号", children: safeText(getSnapshotValue(customerSnapshot, "mobile") ?? contract?.customer.mobile) },
          { label: "客户编号", children: safeText(getSnapshotValue(customerSnapshot, "customerNo")) },
          { label: "车辆编号", children: safeText(getSnapshotValue(vehicleSnapshot, "vehicleNo")) },
          { label: "VIN", children: safeText(getSnapshotValue(vehicleSnapshot, "vin")) },
          { label: "车牌号", children: safeText(getSnapshotValue(vehicleSnapshot, "plateNo")) },
          {
            label: "品牌 / 车系",
            children: joinSnapshotText(getSnapshotValue(vehicleSnapshot, "brand"), getSnapshotValue(vehicleSnapshot, "series"))
          },
          {
            label: "车型",
            children: safeText(
              getSnapshotValue(
                vehicleSnapshot,
                "modelDisplayNameSnapshot",
                "model"
              ) ?? getSnapshotValue(orderSnapshot, "modelDisplayNameSnapshot")
            )
          },
          { label: "电池容量", children: formatKwh(getSnapshotValue(vehicleSnapshot, "batteryCapacityKwh")) },
          {
            label: "电池使用方式",
            children: formatBatteryUsageType(
              getSnapshotValue(vehicleSnapshot, "batteryUsageType"),
              getSnapshotValue(vehicleSnapshot, "batteryUsageTypeLabel")
            )
          },
          { label: "车辆状态", children: formatStatus(getSnapshotValue(vehicleSnapshot, "status")) },
          { label: "当前销售价", children: formatYuan(getSnapshotValue(vehicleSnapshot, "currentSalePriceAmount") ?? getSnapshotValue(quoteSnapshot, "vehicleSalePriceAmount")) },
          { label: "当前里程", children: formatKilometers(getSnapshotValue(vehicleSnapshot, "currentMileageKm")) },
          { label: "资产地点", children: safeText(getSnapshotValue(vehicleSnapshot, "assetLocation")) }
        ]}
      />
      <Descriptions
        bordered
        column={3}
        size="small"
        title="套餐与报价快照"
        items={[
          {
            label: "订阅套餐",
            children: joinSnapshotText(
              getSnapshotValue(packageSnapshot, "subscriptionPlan.planNo") ?? getSnapshotValue(quoteSnapshot, "subscriptionPlan.planNo"),
              getSnapshotValue(packageSnapshot, "subscriptionPlan.planName") ?? getSnapshotValue(quoteSnapshot, "subscriptionPlan.planName")
            )
          },
          { label: "产品名称", children: safeText(getSnapshotValue(quoteSnapshot, "product.name", "productVersion.product.name")) },
          { label: "产品版本", children: safeText(getSnapshotValue(quoteSnapshot, "productVersion.versionNo", "productVersion.versionName")) },
          { label: "订阅周期", children: formatMonths(getSnapshotValue(quoteSnapshot, "periodMonths") ?? getSnapshotValue(orderSnapshot, "periodMonths")) },
          { label: "车辆基础月费模式", children: vehicleBaseFeeModeLabel },
          { label: "固定费率", children: formatPercent(fixedRate) },
          {
            label: "车辆基础费上限",
            children: formatYuan(getSnapshotValue(quoteSnapshot, "vehicleBaseFeeCapAmount", "monthlyFeeCapAmount", "packageSnapshot.pricing.vehicleBaseFeeCapAmount"))
          },
          { label: "车辆基础费", children: formatYuan(getSnapshotValue(quoteSnapshot, "vehicleBaseFeeAmount", "packageSnapshot.pricing.vehicleBaseFeeAmount")) },
          { label: "里程包价格", children: formatYuan(getSnapshotValue(quoteSnapshot, "mileagePackagePriceAmount", "packageSnapshot.pricing.mileagePackagePriceAmount")) },
          { label: "补能包价格", children: formatYuan(getSnapshotValue(quoteSnapshot, "energyPackagePriceAmount", "packageSnapshot.pricing.energyPackagePriceAmount")) },
          { label: "权益包价格", children: formatYuan(getSnapshotValue(quoteSnapshot, "benefitPackagePriceAmount", "packageSnapshot.pricing.benefitPackagePriceAmount")) },
          { label: "月费合计", children: formatYuan(getSnapshotValue(quoteSnapshot, "monthlyFeeAmount") ?? getSnapshotValue(orderSnapshot, "monthlyFeeAmount")) },
          { label: "押金", children: formatYuan(getSnapshotValue(quoteSnapshot, "depositAmount", "depositRuleSnapshot.depositAmount") ?? getSnapshotValue(orderSnapshot, "depositAmount")) },
          { label: "违约率", children: formatPercent(getSnapshotValue(depositRuleSnapshot, "defaultRate") ?? getSnapshotValue(quoteSnapshot, "defaultRate")) }
        ]}
      />
      <Descriptions
        bordered
        column={3}
        size="small"
        title="押金 / 风控信息"
        items={[
          { label: "客户等级", children: safeText(getSnapshotValue(customerSnapshot, "grade") ?? getSnapshotValue(depositRuleSnapshot, "grade", "customerGrade")) },
          { label: "风控评分", children: safeText(getSnapshotValue(riskSnapshot, "score", "riskScore") ?? getSnapshotValue(quoteSnapshot, "riskScore")) },
          { label: "归档时间", children: formatTime(contract?.archivedAt) }
        ]}
      />
    </Space>
  );
}

export default function ContractDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [esignTasks, setESignTasks] = useState<ContractESignTask[]>([]);
  const [eSignTasksError, setESignTasksError] = useState<string | null>(null);
  const [eSignTasksLoading, setESignTasksLoading] = useState(false);
  const [archiveErrorsByTaskId, setArchiveErrorsByTaskId] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [archivingTaskId, setArchivingTaskId] = useState<string | null>(null);
  const [creatingESignTask, setCreatingESignTask] = useState(false);
  const [onboardingStatus, setOnboardingStatus] = useState<FadadaOnboardingReadiness | null>(null);
  const [refreshingOnboarding, setRefreshingOnboarding] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [journey, setJourney] = useState<AdminSubscriptionJourney | null>(null);
  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const signContractAvailability = useMemo(() => canSignContract(contract, permissions), [contract, permissions]);
  const createESignTaskAvailability = useMemo(() => {
    if (!signContractAvailability.allowed) {
      return signContractAvailability;
    }
    return getFadadaReadinessAvailability(onboardingStatus);
  }, [onboardingStatus, signContractAvailability]);
  const signedDocumentTask = useMemo(
    () => esignTasks.find((task) => task.hasSignedDocument) ?? null,
    [esignTasks]
  );
  const loadESignTasks = useCallback(async () => {
    setESignTasksLoading(true);
    try {
      const tasks = await apiFetch<ContractESignTask[]>(`/contracts/${params.id}/esign-tasks`);
      setESignTasks(tasks);
      setESignTasksError(null);
    } catch (error) {
      setESignTasks([]);
      setESignTasksError(getErrorMessage(error));
    } finally {
      setESignTasksLoading(false);
    }
  }, [params.id]);
  const loadContract = useCallback(async () => {
    setLoading(true);
    try {
      const [nextContract, nextMe] = await Promise.all([
        apiFetch<ContractDetail>(`/contracts/${params.id}`),
        apiFetch<AuthMeResponse>("/auth/me"),
        loadESignTasks()
      ]);
      const nextOnboardingStatus = await apiFetch<FadadaOnboardingReadiness>(
        `/customers/${nextContract.customer.id}/esign-onboarding/status`
      ).catch(() => null);
      setContract(nextContract);
      setMe(nextMe);
      setOnboardingStatus(nextOnboardingStatus);
      setLoading(false);
      if (nextMe.user.permissions.includes("subscription_journey:view")) {
        try {
          setJourney(await loadAdminJourneyByOrder(nextContract.order.id));
        } catch {
          setJourney(null);
          void message.warning("订阅流程加载失败，合同信息仍可继续查看");
        }
      } else {
        setJourney(null);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [loadESignTasks, message, params.id]);

  useEffect(() => {
    void loadContract();
  }, [loadContract]);

  async function transition(action: "sign" | "archive" | "cancel") {
    if (!contract) {
      return;
    }
    try {
      await apiFetch(`/contracts/${contract.id}/${action}`, {
        body: action === "archive" ? JSON.stringify({}) : undefined,
        method: "POST"
      });
      void message.success(action === "sign" ? "合同已签署" : action === "archive" ? "合同已归档" : "合同已取消");
      await loadContract();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function createESignTask() {
    if (!contract) {
      return;
    }
    if (!createESignTaskAvailability.allowed) {
      void message.warning(createESignTaskAvailability.reason ?? getFadadaBlockingMessage(onboardingStatus));
      return;
    }
    try {
      setCreatingESignTask(true);
      await apiFetch(`/contracts/${contract.id}/esign-tasks`, { method: "POST" });
      void message.success("电子签任务已发起");
      await loadContract();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setCreatingESignTask(false);
    }
  }

  async function refreshOnboardingStatus() {
    if (!contract) {
      return;
    }
    try {
      setRefreshingOnboarding(true);
      const status = await apiFetch<FadadaOnboardingReadiness>(
        `/customers/${contract.customer.id}/esign-onboarding/refresh`,
        { method: "POST" }
      );
      setOnboardingStatus(status);
      void message.success("法大大认证状态已刷新");
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setRefreshingOnboarding(false);
    }
  }

  async function archiveSignedArtifacts(taskId: string) {
    try {
      setArchivingTaskId(taskId);
      await apiFetch(`/esign-tasks/${taskId}/archive-signed-artifacts`, { method: "POST" });
      setArchiveErrorsByTaskId((current) => {
        if (!current[taskId]) {
          return current;
        }
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      void message.success("已签合同已归档");
      await loadContract();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      setArchiveErrorsByTaskId((current) => ({ ...current, [taskId]: errorMessage }));
      void message.error(errorMessage);
    } finally {
      setArchivingTaskId(null);
    }
  }

  function openSignedContract(taskId: string) {
    window.open(
      `${API_BASE_URL}/esign-tasks/${encodeURIComponent(taskId)}/signed-contract/preview`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  function openGeneratedContractPdf() {
    if (!contract) {
      return;
    }
    window.open(
      `${API_BASE_URL}/contracts/${encodeURIComponent(contract.id)}/generated-pdf/preview`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回合同列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/contracts")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {contract?.contractNo ?? "合同详情"}
            </Typography.Title>
            {contract ? <Tag>{labelOf(STATUS_LABELS, contract.status)}</Tag> : null}
          </Space>
          {contract ? (
            <Space>
              {signedDocumentTask ? (
                <Button icon={<EyeOutlined />} onClick={() => openSignedContract(signedDocumentTask.id)} type="primary">
                  查看已签署PDF
                </Button>
              ) : null}
              {contract.hasGeneratedPdfArtifact ? (
                <Button icon={<EyeOutlined />} onClick={openGeneratedContractPdf}>
                  查看待签署PDF
                </Button>
              ) : null}
              {journey ? (
                <Tag color="blue">订阅 Golden Path 托管</Tag>
              ) : (
                <>
                  <ActionButton
                    availability={signContractAvailability}
                    onClick={() => transition("sign")}
                    type="primary"
                  >
                    签署
                  </ActionButton>
                  <ActionButton
                    availability={canArchiveContract(contract, permissions)}
                    onClick={() => transition("archive")}
                  >
                    归档
                  </ActionButton>
                  <ActionButton
                    availability={canCancelContract(contract, permissions)}
                    danger
                    onClick={() => transition("cancel")}
                  >
                    取消
                  </ActionButton>
                </>
              )}
            </Space>
          ) : null}
        </Space>

        {loading ? <Spin /> : null}
        {!loading && contract ? (
          <Card title="合同基础信息">
            <Descriptions
          bordered
          column={3}
          items={
            contract && !loading
              ? [
                  { label: "合同编号", children: contract.contractNo },
                  { label: "合同标题", children: contract.contractTitle },
                  {
                    label: "订单编号",
                    children: <Link href={`/orders/${contract.order.id}`}>{contract.order.orderNo}</Link>
                  },
                  { label: "客户信息", children: `${contract.customer.name} / ${contract.customer.mobile}` },
                  { label: "合同状态", children: <Tag>{labelOf(STATUS_LABELS, contract.status)}</Tag> },
                  { label: "合同版本", children: contract.version?.versionNo ?? "-" },
                  { label: "签署时间", children: formatTime(contract.signedAt) },
                  { label: "归档时间", children: formatTime(contract.archivedAt) },
                  { label: "创建时间", children: formatTime(contract.createdAt) }
                ]
              : []
          }
            />
          </Card>
        ) : null}

        {!loading && contract ? (
          <Card
            extra={
              journey ? null : (
                <ActionButton
                  availability={createESignTaskAvailability}
                  loading={creatingESignTask}
                  onClick={createESignTask}
                  type="primary"
                >
                  发起电子签
                </ActionButton>
              )
            }
            title="电子签任务"
          >
            <Alert
              action={
                <Button icon={<ReloadOutlined />} loading={refreshingOnboarding} onClick={refreshOnboardingStatus} size="small">
                  刷新认证状态
                </Button>
              }
              message={getFadadaBlockingMessage(onboardingStatus)}
              description={onboardingStatus?.blockingCode ? `状态码：${onboardingStatus.blockingCode}` : undefined}
              showIcon
              style={{ marginBottom: 16 }}
              type={getFadadaReadinessTone(onboardingStatus)}
            />
            {eSignTasksError ? (
              <Alert
                action={
                  <Button
                    icon={<ReloadOutlined />}
                    loading={eSignTasksLoading}
                    onClick={() => void loadESignTasks()}
                    size="small"
                  >
                    重新加载
                  </Button>
                }
                description={eSignTasksError}
                message="电子签任务加载失败"
                showIcon
                type="error"
              />
            ) : (
              <List
                dataSource={esignTasks}
                locale={{ emptyText: <Empty description="暂无电子签任务" /> }}
                loading={eSignTasksLoading}
                renderItem={(task) => {
                const archiveStatus = getAdminESignArchiveStatus({
                  archiveError:
                    task.archiveError ?? archiveErrorsByTaskId[task.id],
                  archiveStatus: task.archiveStatus,
                  hasSignedDocument: task.hasSignedDocument,
                  provider: task.provider,
                  signedArtifactAvailable: task.signedArtifactAvailable,
                  signingStage: task.signingStage,
                  taskStatus: task.taskStatus
                });
                const signerGroups = buildAdminESignSignerGroups(task.signers);

                return (
                  <List.Item>
                    <List.Item.Meta
                      description={
                        <Space direction="vertical" size={8}>
                          <Space size={[6, 6]} wrap>
                            <Tag color="blue">{labelOf(ESIGN_TASK_STATUS_LABELS, task.taskStatus)}</Tag>
                            <Tag>{labelOf(ESIGN_PROVIDER_LABELS, task.provider)}</Tag>
                            {archiveStatus.tagLabel ? (
                              <Tag color={archiveStatus.tagColor ?? undefined}>{archiveStatus.tagLabel}</Tag>
                            ) : null}
                            <Tag>创建于 {formatTime(task.createdAt)}</Tag>
                          </Space>
                          {archiveStatus.errorSummary ? (
                            <Typography.Text type="danger">{archiveStatus.errorSummary}</Typography.Text>
                          ) : null}
                          <Space direction="vertical" size={4}>
                            {signerGroups.map((group) => (
                              <Space key={group.id} size={[6, 6]} wrap>
                                <Tag>
                                  {group.displayName}
                                  {group.mobile ? ` / ${group.mobile}` : null} / {labelOf(ESIGN_SIGNER_STATUS_LABELS, group.status)} / {group.slotSummaryLabel}
                                </Tag>
                                {group.slotDetails.map((slot) => (
                                  <Tag key={slot.id} color={group.hasMixedStatuses && slot.status === group.status ? "orange" : undefined}>
                                    {slot.label} / {labelOf(ESIGN_SIGNER_STATUS_LABELS, slot.status)}
                                  </Tag>
                                ))}
                              </Space>
                            ))}
                          </Space>
                        </Space>
                      }
                      title={`${task.taskNo} · ${task.documentName ?? "合同电子签"}`}
                    />
                    {archiveStatus.canArchive && !journey ? (
                      <Button
                        disabled={!permissions.has("contract:archive")}
                        icon={<FileDoneOutlined />}
                        loading={archivingTaskId === task.id}
                        onClick={() => archiveSignedArtifacts(task.id)}
                      >
                        {archiveStatus.actionLabel}
                      </Button>
                    ) : null}
                    {archiveStatus.canOpenSignedPdf ? (
                      <Button icon={<CloudDownloadOutlined />} onClick={() => openSignedContract(task.id)}>
                        查看已签署PDF
                      </Button>
                    ) : null}
                  </List.Item>
                );
                }}
              />
            )}
          </Card>
        ) : null}

        <ContractSnapshotSection contract={contract} />
      </Space>
    </ProtectedShell>
  );
}
