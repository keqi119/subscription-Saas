"use client";

import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined
} from "@ant-design/icons";
import { Alert, App, Button, Flex, Input, InputNumber, Radio, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { type CSSProperties, type ChangeEvent, type ReactNode, useCallback, useEffect, useState } from "react";

import {
  attachFieldHandoverEvidenceFile,
  declareFieldHandoverNoVisibleDamage,
  getFieldHandoverActionErrorMessage,
  getFieldHandoverReadiness,
  getFieldHandoverSession,
  getFieldHandoverWorkOrder,
  isFieldHandoverSessionExpired,
  startFieldHandoverWorkOrder,
  submitFieldHandoverEvidence,
  updateFieldHandoverFacts,
  uploadFieldHandoverEvidenceFile,
  type FieldHandoverEvidenceItem,
  type FieldHandoverEvidenceMediaType,
  type FieldHandoverWorkOrderDetail
} from "../../../../../lib/field-handover-api";
import {
  buildFieldEvidenceCaptureView,
  buildFieldHandoverDetailView,
  buildFieldHandoverFactsPayload,
  fieldFactsToDraft,
  getFieldHandoverSubmitBlockers,
  validateFieldHandoverFactsInput,
  type FieldHandoverFactsDraft
} from "../../../../../lib/field-handover-view-model";

const SUBMITTED_TEXT = "现场交接资料已提交，等待客户确认";
const RESUBMITTED_PENDING_ADMIN_TEXT = "现场交接资料已重新提交，等待后台送回客户复核";
const LOCKED_TEXT = "当前交接任务已提交或不可继续编辑";

export default function FieldHandoverTaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [detail, setDetail] = useState<FieldHandoverWorkOrderDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facts, setFacts] = useState<FieldHandoverFactsDraft>({});
  const [loading, setLoading] = useState(true);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      await getFieldHandoverSession();
      const [nextDetail, readiness] = await Promise.all([
        getFieldHandoverWorkOrder(params.id),
        getFieldHandoverReadiness(params.id)
      ]);
      const mergedDetail = {
        ...nextDetail,
        evidenceChecklist: {
          ...(nextDetail.evidenceChecklist ?? {}),
          blockingReasons: readiness.blockingReasons ?? nextDetail.evidenceChecklist?.blockingReasons ?? [],
          ready: readiness.ready ?? nextDetail.evidenceChecklist?.ready ?? false
        }
      };
      setDetail(mergedDetail);
      setFacts(fieldFactsToDraft(mergedDetail.fieldFacts));
    } catch (error) {
      if (isFieldHandoverSessionExpired(error)) {
        router.replace("/field/handover");
        return;
      }
      setErrorMessage("无法访问该交接任务，请确认任务仍分配给当前手机号");
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const detailView = detail ? buildFieldHandoverDetailView(detail) : null;
  const captureView = detail ? buildFieldEvidenceCaptureView(detail) : null;

  async function startWork() {
    await runAction("start", async () => {
      await startFieldHandoverWorkOrder(params.id);
      void message.success("已开始现场采集");
      await loadDetail();
    });
  }

  async function saveFacts() {
    const errors = validateFieldHandoverFactsInput(facts);
    if (errors.length) {
      setBlockers(errors);
      return;
    }

    await runAction("save", async () => {
      await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(facts));
      setBlockers([]);
      void message.success("现场信息已保存");
      await loadDetail();
    });
  }

  async function updateDamageState(value: "DAMAGE" | "NO_DAMAGE") {
    if (value === "NO_DAMAGE") {
      const nextFacts = { ...facts, damageDeclared: false, noVisibleDamageDeclared: true };
      setFacts(nextFacts);
      await runAction("damage", async () => {
        await declareFieldHandoverNoVisibleDamage(params.id, "现场确认");
        setBlockers([]);
        void message.success("无可见损伤声明已保存");
        await loadDetail();
      });
      return;
    }

    const nextFacts = { ...facts, damageDeclared: true, noVisibleDamageDeclared: false };
    setFacts(nextFacts);
    await runAction("damage", async () => {
      await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(nextFacts));
      setBlockers([]);
      void message.success("损伤状态已保存，请上传损伤/瑕疵近拍");
      await loadDetail();
    });
  }

  async function uploadEvidence(itemViewId: string, file: File | undefined) {
    if (!detail || !file) {
      return;
    }
    const item = findEvidenceItem(detail, itemViewId);
    if (!item?.id) {
      setBlockers(["资料项不存在，请刷新后重试"]);
      return;
    }
    const mediaType = resolveMediaType(file);
    if (!mediaType || !isAllowedMediaType(item, mediaType)) {
      setBlockers(["请选择符合要求的图片/视频"]);
      return;
    }

    try {
      setUploadingItemId(item.id);
      setBlockers([]);
      const uploaded = await uploadFieldHandoverEvidenceFile(params.id, file);
      await attachFieldHandoverEvidenceFile(params.id, item.id, {
        fileId: uploaded.fileId,
        mediaType
      });
      void message.success("资料已上传");
      await loadDetail();
    } catch (error) {
      handleActionError(error, "上传失败，请重试");
    } finally {
      setUploadingItemId(null);
    }
  }

  async function submitEvidence() {
    if (!detail) {
      return;
    }
    const currentBlockers = getFieldHandoverSubmitBlockers(detail, facts);
    if (currentBlockers.length) {
      setBlockers(currentBlockers);
      return;
    }

    await runAction("submit", async () => {
      await updateFieldHandoverFacts(params.id, buildFieldHandoverFactsPayload(facts));
      const submitted = await submitFieldHandoverEvidence(params.id);
      const successText =
        submitted.status === "CUSTOMER_OBJECTED" && submitted.adminReviewStatus === "RESUBMITTED_PENDING_ADMIN"
          ? RESUBMITTED_PENDING_ADMIN_TEXT
          : SUBMITTED_TEXT;
      setBlockers([]);
      setSuccessMessage(successText);
      void message.success(successText);
      await loadDetail();
    });
  }

  async function runAction(action: string, callback: () => Promise<void>) {
    try {
      setActionLoading(action);
      await callback();
    } catch (error) {
      handleActionError(error);
    } finally {
      setActionLoading(null);
    }
  }

  function handleActionError(error: unknown, fallback?: string) {
    if (isFieldHandoverSessionExpired(error)) {
      router.replace("/field/handover");
      return;
    }
    const normalized = fallback ?? getFieldHandoverActionErrorMessage(error);
    setBlockers(splitBlockingMessages(normalized));
    void message.error(normalized);
  }

  return (
    <main
      style={{
        background: "#f5f8fc",
        minHeight: "100vh",
        padding: "max(22px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))"
      }}
    >
      <section style={{ margin: "0 auto", maxWidth: 520 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/field/handover/tasks")} style={{ marginBottom: 14 }}>
          返回任务列表
        </Button>

        {loading ? (
          <Flex align="center" gap={10} justify="center" style={{ minHeight: 240 }}>
            <Spin />
            <Typography.Text>正在加载交接任务...</Typography.Text>
          </Flex>
        ) : null}

        {!loading && errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}

        {!loading && detailView && captureView ? (
          <Flex gap={12} vertical>
            <SummaryCard view={detailView} />

            <article style={cardStyle}>
              <Flex align="flex-start" justify="space-between" style={{ gap: 12, marginBottom: 12 }}>
                <div>
                  <Typography.Title level={3} style={{ fontSize: 18, margin: 0 }}>
                    现场资料采集
                  </Typography.Title>
                  <Typography.Text style={{ color: "#607086" }}>{captureView.nextStepText}</Typography.Text>
                </div>
                <Button icon={<ReloadOutlined />} onClick={() => void loadDetail()}>
                  刷新
                </Button>
              </Flex>
              <Flex gap={8} vertical>
                <InfoRow label="资料" value={captureView.progressText} />
                <InfoRow label="现场信息" value={captureView.fieldFactsStatus} />
                <InfoRow label="损伤" value={captureView.damageStateLabel} />
                <InfoRow label="状态" value={detailView.card.statusLabel} />
              </Flex>
            </article>

            {captureView.lockedMessage ? <Alert message={captureView.lockedMessage || LOCKED_TEXT} showIcon type="info" /> : null}
            {successMessage ? <Alert icon={<CheckCircleOutlined />} message={successMessage} showIcon type="success" /> : null}
            {blockers.length ? <BlockerAlert blockers={blockers} /> : null}

            <article style={cardStyle}>
              <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
                现场信息
              </Typography.Title>
              <Flex gap={12} vertical>
                <LabeledControl label="交接里程">
                  <InputNumber
                    disabled={!captureView.canEdit}
                    min={1}
                    onChange={(value) => setFacts((current) => ({ ...current, handoverMileageKm: value ?? null }))}
                    placeholder="请输入公里数"
                    style={{ width: "100%" }}
                    value={facts.handoverMileageKm ?? null}
                  />
                </LabeledControl>
                <LabeledControl label="能源/油量">
                  <Input
                    disabled={!captureView.canEdit}
                    onChange={(event) => setFacts((current) => ({ ...current, energyLevelText: event.target.value }))}
                    placeholder="例如 80% / 满油"
                    value={facts.energyLevelText ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="交接地点">
                  <Input
                    disabled={!captureView.canEdit}
                    onChange={(event) => setFacts((current) => ({ ...current, deliveryLocation: event.target.value }))}
                    placeholder="请输入现场交接地点"
                    value={facts.deliveryLocation ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="随车物品">
                  <Input.TextArea
                    autoSize={{ maxRows: 5, minRows: 3 }}
                    disabled={!captureView.canEdit}
                    onChange={(event) => setFacts((current) => ({ ...current, accessoryChecklistText: event.target.value }))}
                    placeholder="逐行填写钥匙、充电线、随车工具等"
                    value={facts.accessoryChecklistText ?? ""}
                  />
                </LabeledControl>
                <LabeledControl label="损伤状态">
                  <Radio.Group
                    disabled={!captureView.canEdit || actionLoading === "damage"}
                    onChange={(event) => void updateDamageState(event.target.value)}
                    optionType="button"
                    value={facts.damageDeclared ? "DAMAGE" : facts.noVisibleDamageDeclared ? "NO_DAMAGE" : undefined}
                  >
                    <Radio.Button value="DAMAGE">发现损伤/瑕疵</Radio.Button>
                    <Radio.Button value="NO_DAMAGE">无可见损伤</Radio.Button>
                  </Radio.Group>
                </LabeledControl>
                <LabeledControl label="现场备注">
                  <Input.TextArea
                    autoSize={{ maxRows: 5, minRows: 3 }}
                    disabled={!captureView.canEdit}
                    onChange={(event) => setFacts((current) => ({ ...current, fieldNotes: event.target.value }))}
                    placeholder="补充现场情况"
                    value={facts.fieldNotes ?? ""}
                  />
                </LabeledControl>
                {captureView.showStartAction ? (
                  <Button block icon={<PlayCircleOutlined />} loading={actionLoading === "start"} onClick={() => void startWork()} size="large">
                    开始现场采集
                  </Button>
                ) : null}
                {captureView.showSaveAction ? (
                  <Button block icon={<SaveOutlined />} loading={actionLoading === "save"} onClick={() => void saveFacts()} size="large">
                    保存现场信息
                  </Button>
                ) : null}
              </Flex>
            </article>

            <article style={cardStyle}>
              <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
                资料清单
              </Typography.Title>
              <Flex gap={10} vertical>
                {captureView.evidenceItems.map((item) => (
                  <article key={item.id || item.title} style={itemCardStyle}>
                    <Flex align="flex-start" justify="space-between" style={{ gap: 10 }}>
                      <div>
                        <Typography.Text strong>{item.title}</Typography.Text>
                        {item.description ? (
                          <Typography.Paragraph style={{ color: "#607086", margin: "4px 0 0" }}>
                            {item.description}
                          </Typography.Paragraph>
                        ) : null}
                      </div>
                      <Flex gap={6} wrap="wrap" justify="flex-end">
                        <Tag color={item.requiredText === "必传" ? "red" : "blue"} style={{ marginInlineEnd: 0 }}>
                          {item.requiredText}
                        </Tag>
                        <Tag color={item.statusLabel === "待上传" ? "default" : "green"} style={{ marginInlineEnd: 0 }}>
                          {item.statusLabel}
                        </Tag>
                      </Flex>
                    </Flex>

                    <Typography.Text style={{ color: "#607086", display: "block", marginTop: 8 }}>
                      {item.fileCountText}
                    </Typography.Text>

                    {item.rejectionReason ? (
                      <Alert message={item.rejectionReason} showIcon style={{ marginTop: 8 }} type="warning" />
                    ) : null}

                    {item.showDeclarationComplete ? (
                      <Typography.Text style={{ color: "#2f7d32", display: "block", marginTop: 8 }}>
                        无可见损伤声明已完成
                      </Typography.Text>
                    ) : null}

                    {item.showUpload ? (
                      <EvidenceUploadControl
                        accept={item.uploadAccept}
                        disabled={uploadingItemId === item.id}
                        id={item.id}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          void uploadEvidence(item.id, file);
                        }}
                      />
                    ) : null}
                  </article>
                ))}
              </Flex>
            </article>

            {captureView.showSubmitAction ? (
              <div style={submitBarStyle}>
                <Button
                  block
                  icon={<CheckCircleOutlined />}
                  loading={actionLoading === "submit"}
                  onClick={() => void submitEvidence()}
                  size="large"
                  type="primary"
                >
                  提交现场资料
                </Button>
              </div>
            ) : null}
          </Flex>
        ) : null}
      </section>
    </main>
  );
}

function SummaryCard({ view }: { view: ReturnType<typeof buildFieldHandoverDetailView> }) {
  return (
    <article style={cardStyle}>
      <Flex align="flex-start" justify="space-between" style={{ gap: 12, marginBottom: 12 }}>
        <div>
          <Typography.Title level={2} style={{ fontSize: 22, margin: 0 }}>
            {view.card.title}
          </Typography.Title>
          <Typography.Text style={{ color: "#607086" }}>{view.card.handoverTypeLabel}</Typography.Text>
        </div>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          {view.card.statusLabel}
        </Tag>
      </Flex>

      <Flex gap={8} vertical>
        <InfoRow label="预约时间" value={view.card.scheduledAtText} />
        <InfoRow label="交接地点" value={view.card.deliveryLocationText} />
        <InfoRow label="车辆" value={view.card.vehicleText} />
        <InfoRow label="车牌" value={view.card.plateText} />
        <InfoRow label="VIN" value={view.card.vinText} />
        <InfoRow label="客户" value={view.card.customerText} />
        <InfoRow label="资料清单" value={view.checklistSummary} />
      </Flex>
    </article>
  );
}

function BlockerAlert({ blockers }: { blockers: string[] }) {
  return (
    <Alert
      description={
        <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
          {blockers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      }
      icon={<ExclamationCircleOutlined />}
      message="请先补齐以下内容"
      showIcon
      type="warning"
    />
  );
}

function LabeledControl({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label style={{ display: "block" }}>
      <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
        {label}
      </Typography.Text>
      {children}
    </label>
  );
}

function EvidenceUploadControl({
  accept,
  disabled,
  id,
  onChange
}: {
  accept: string;
  disabled: boolean;
  id: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputId = `field-evidence-file-${id}`;
  return (
    <div style={{ marginTop: 10 }}>
      <input
        accept={accept}
        disabled={disabled}
        id={inputId}
        onChange={onChange}
        style={{ display: "none" }}
        type="file"
      />
      <label
        htmlFor={inputId}
        style={{
          alignItems: "center",
          background: disabled ? "#eef2f7" : "#1677ff",
          borderRadius: 8,
          color: disabled ? "#8a95a6" : "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          fontWeight: 600,
          gap: 8,
          justifyContent: "center",
          minHeight: 44,
          pointerEvents: disabled ? "none" : "auto",
          width: "100%"
        }}
      >
        <UploadOutlined />
        {disabled ? "上传中..." : "上传资料"}
      </label>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" style={{ gap: 12 }}>
      <Typography.Text style={{ color: "#718096", flex: "0 0 82px" }}>{label}</Typography.Text>
      <Typography.Text style={{ flex: 1, textAlign: "right", wordBreak: "break-word" }}>{value}</Typography.Text>
    </Flex>
  );
}

function findEvidenceItem(detail: FieldHandoverWorkOrderDetail, itemId: string) {
  return (detail.evidenceChecklist?.items ?? []).find((item) => item.id === itemId) ?? null;
}

function resolveMediaType(file: File): FieldHandoverEvidenceMediaType | null {
  if (file.type.startsWith("image/")) {
    return "PHOTO";
  }
  if (file.type.startsWith("video/")) {
    return "VIDEO";
  }
  return null;
}

function isAllowedMediaType(item: FieldHandoverEvidenceItem, mediaType: FieldHandoverEvidenceMediaType) {
  return (item.allowedMediaTypes ?? []).includes(mediaType);
}

function splitBlockingMessages(message: string) {
  return message
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #dde5f0",
  borderRadius: 8,
  boxShadow: "0 8px 22px rgba(31, 71, 112, 0.06)",
  padding: 16
};

const itemCardStyle: CSSProperties = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 12
};

const submitBarStyle: CSSProperties = {
  background: "rgba(245, 248, 252, 0.94)",
  bottom: 0,
  padding: "8px 0 max(8px, env(safe-area-inset-bottom))",
  position: "sticky"
};
