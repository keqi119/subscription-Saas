"use client";

import { Alert, App, Button, Card, Form, Input, InputNumber, Select, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";

import {
  cancelSubscriptionReturnManifestSigning,
  captureSubscriptionReturnChecklist,
  confirmSubscriptionClosurePhysicalReceipt,
  decideSubscriptionClosureApproval,
  requestSubscriptionClosureApproval,
  uploadSubscriptionReturnEvidence
} from "../../lib/subscription-closure-api";
import { API_BASE_URL } from "../../lib/api";
import type { AdminSubscriptionClosureView } from "../../lib/subscription-closure-view-model";
import {
  selectSubscriptionReturnFile,
  subscriptionReturnEvidenceType
} from "../../lib/subscription-return-upload";

const CHECKLIST_ITEMS = [
  ["VEHICLE_EXTERIOR", "车辆外观", true],
  ["VEHICLE_INTERIOR", "车辆内饰", true],
  ["KEY", "车辆钥匙", true],
  ["REGISTRATION_CERTIFICATE", "行驶证", true],
  ["CHARGING_EQUIPMENT", "充电设备", false],
  ["ACCESSORIES", "随车附件", false],
  ["BATTERY", "动力电池", false],
  ["CUSTOMER_ITEMS", "客户物品清空", false],
  ["MILEAGE", "退车里程", false]
] as const;

type ChecklistForm = {
  attestationMode: "CUSTOMER_SIGNED" | "CUSTOMER_REFUSED" | "CUSTOMER_ABSENT";
  attestationReason?: string;
  customerComments?: string;
  items: Array<{
    expectedQuantity?: number;
    itemCode: string;
    remark?: string;
    returnedQuantity?: number;
    state: string;
  }>;
  witnesses?: string;
};

export function ReturnEvidenceStage({
  canApproveApproval,
  canRequestApproval,
  closure,
  currentUserId,
  onChanged,
  orderId
}: {
  canApproveApproval: boolean;
  canRequestApproval: boolean;
  closure: AdminSubscriptionClosureView;
  currentUserId: string | null;
  onChanged: () => Promise<void> | void;
  orderId: string;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ChecklistForm>();
  const [saving, setSaving] = useState(false);
  const [attestationFile, setAttestationFile] = useState<File | null>(null);
  const [itemFiles, setItemFiles] = useState<Record<string, File | null>>({});
  const [uploadingItemId, setUploadingItemId] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [cancellingSigning, setCancellingSigning] = useState(false);
  const [registrationApprovalBusy, setRegistrationApprovalBusy] = useState(false);
  const [registrationApprovalComment, setRegistrationApprovalComment] = useState("");
  const currentByCode = useMemo(
    () => new Map((closure.checklist?.items ?? []).map((item) => [item.itemCode, item])),
    [closure.checklist]
  );
  const evidenceItemIds = useMemo(
    () =>
      new Set(
        closure.evidenceLinks
          .filter((link) => Boolean(link.evidenceId) && link.evidencePurpose === "CHECKLIST_PROOF")
          .map((link) => link.checklistItemId)
          .filter((id): id is string => Boolean(id))
      ),
    [closure.evidenceLinks]
  );
  const allowedActionKeys = new Set(closure.allowedActions.map(({ key }) => key));
  const canCaptureChecklist =
    closure.capabilities.receive && allowedActionKeys.has("CAPTURE_RETURN_CHECKLIST");
  const canUploadReturnEvidence =
    closure.capabilities.receive && allowedActionKeys.has("UPLOAD_RETURN_EVIDENCE");
  const canConfirmReceipt = closure.allowedActions.some(
    (action) => action.key === "CONFIRM_PHYSICAL_RECEIPT"
  );
  const returnManifestSigningCompleted =
    closure.returnManifestSigning?.taskStatus === "COMPLETED";
  const registrationItem = closure.checklist?.items.find(
    (item) => item.itemCode === "REGISTRATION_CERTIFICATE"
  );
  const registrationEvidenceIds = closure.evidenceLinks
    .filter(
      (link) =>
        link.checklistItemId === registrationItem?.id && typeof link.evidenceId === "string"
    )
    .map((link) => link.evidenceId!);
  const registrationApproval = registrationItem
    ? [...closure.approvals]
        .reverse()
        .find(
          (approval) =>
            approval.type === "VEHICLE_REGISTRATION_DOCUMENT_MISSING" &&
            approval.subjectField === `returnRegistrationDocument:${registrationItem.id}` &&
            approval.checklistItemId === registrationItem.id &&
            approval.checklistItemState === registrationItem.state &&
            approval.checklistRevisionId === closure.checklist?.id &&
            approval.checklistManifestHash === closure.checklist?.manifestHash
        ) ?? null
    : null;
  const initialItems = CHECKLIST_ITEMS.map(([itemCode]) => {
    const current = currentByCode.get(itemCode);
    const defaultQuantity = itemCode === "MILEAGE" ? 0 : itemCode === "KEY" ? 2 : 1;
    return {
      expectedQuantity: current?.expectedQuantity ?? defaultQuantity,
      itemCode,
      remark: current?.remark ?? undefined,
      returnedQuantity: current?.returnedQuantity ?? defaultQuantity,
      state: current?.state ?? "NORMAL"
    };
  });

  async function cancelSigningForCorrection() {
    setCancellingSigning(true);
    try {
      await cancelSubscriptionReturnManifestSigning(closure.closureCaseId, {
        idempotencyKey: crypto.randomUUID(),
        reason: "管理员确认需要更正退车现场清单"
      });
      void message.success("当前签署已取消。请更正清单并保存新修订版，系统将创建新的签署任务。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法取消当前退车确认单签署");
    } finally {
      setCancellingSigning(false);
    }
  }

  async function requestRegistrationApproval() {
    if (
      !registrationItem ||
      !closure.checklist ||
      registrationEvidenceIds.length === 0 ||
      !["MISSING", "DAMAGED", "PENDING_VERIFICATION"].includes(registrationItem.state)
    ) {
      void message.error("请先将行驶证状态记录为缺失、损坏或待核验，并上传现场证明。");
      return;
    }
    setRegistrationApprovalBusy(true);
    try {
      await requestSubscriptionClosureApproval(closure.closureCaseId, {
        approvalType: "REGISTRATION_DOCUMENT_MISSING",
        checklistItemId: registrationItem.id,
        evidenceIds: registrationEvidenceIds,
        idempotencyKey: crypto.randomUUID(),
        requestReason: registrationItem.remark ?? "行驶证无法现场交回，申请管理员批准继续签署退车确认单。"
      });
      void message.success("行驶证签署兜底审批已发起，需由另一名管理员决定。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法发起行驶证兜底审批。");
    } finally {
      setRegistrationApprovalBusy(false);
    }
  }

  async function decideRegistrationApproval(decision: "APPROVED" | "REJECTED") {
    if (!registrationApproval || !registrationApprovalComment.trim()) {
      void message.error("请填写审批意见。");
      return;
    }
    setRegistrationApprovalBusy(true);
    try {
      await decideSubscriptionClosureApproval(
        closure.closureCaseId,
        registrationApproval.id,
        {
          decision,
          decisionComment: registrationApprovalComment.trim(),
          expectedVersion: registrationApproval.version,
          idempotencyKey: crypto.randomUUID()
        }
      );
      void message.success(
        decision === "APPROVED"
          ? "已批准行驶证签署兜底，系统将继续电子签任务。"
          : "行驶证签署兜底申请已驳回。"
      );
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法处理行驶证兜底审批。");
    } finally {
      setRegistrationApprovalBusy(false);
    }
  }

  async function confirmPhysicalReceipt() {
    const checklist = closure.checklist;
    if (!checklist) return;
    const requiredCodes = new Set([
      "KEY",
      "REGISTRATION_CERTIFICATE",
      "VEHICLE_EXTERIOR",
      "VEHICLE_INTERIOR",
      ...checklist.items
        .filter((item) => item.state === "DAMAGED" || item.state === "MISSING")
        .map((item) => item.itemCode)
    ]);
    const missingCodes = checklist.items
      .filter((item) => requiredCodes.has(item.itemCode) && !evidenceItemIds.has(item.id))
      .map((item) => item.itemCode);
    if (missingCodes.length > 0) {
      void message.error(`请先补齐必需证据：${missingCodes.join("、")}`);
      return;
    }
    const evidenceByItemId = new Map<string, string[]>();
    for (const link of closure.evidenceLinks) {
      if (!link.checklistItemId || !link.evidenceId) continue;
      evidenceByItemId.set(link.checklistItemId, [
        ...(evidenceByItemId.get(link.checklistItemId) ?? []),
        link.evidenceId
      ]);
    }
    const mileage = checklist.items.find((item) => item.itemCode === "MILEAGE")?.returnedQuantity;
    if (mileage === null || mileage === undefined) {
      void message.error("请在现场清单中填写退车里程。");
      return;
    }
    setReceiving(true);
    try {
      await confirmSubscriptionClosurePhysicalReceipt(orderId, {
        checklistManifestHash: checklist.manifestHash,
        checklistRevisionId: checklist.id,
        damages: checklist.items
          .filter((item) => item.state === "DAMAGED")
          .map((item) => ({
            checklistItemId: item.id,
            damageLevel: "MINOR",
            damageType: damageTypeFor(item.itemCode),
            description: item.remark ?? `${item.itemCode} 现场记录为损伤`,
            evidenceIds: evidenceByItemId.get(item.id) ?? [],
            responsibleParty: "UNKNOWN"
          })),
        physicalControlMode: "VOLUNTARY_RETURN",
        remark: "依据受管退车清单及受管证据确认车辆已取回。",
        returnMileageKm: mileage,
        returnedAt: new Date().toISOString(),
        returnType: closure.closureType === "EARLY_TERMINATION" ? "EARLY_TERMINATION" : "NORMAL_RETURN"
      });
      void message.success("车辆已确认取回，流程进入车况差异与合同计费阶段。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法确认车辆取回。");
    } finally {
      setReceiving(false);
    }
  }

  async function saveChecklist(values: ChecklistForm) {
    if (!canCaptureChecklist || closure.returnManifestSigning) {
      void message.error("当前退车阶段不允许修订现场清单。");
      return;
    }
    setSaving(true);
    try {
      let attestationEvidenceIds: string[] = [];
      if (values.attestationMode !== "CUSTOMER_SIGNED") {
        if (!attestationFile) throw new Error("客户拒签或缺席时必须上传现场见证证据。");
        const selected = selectSubscriptionReturnFile(attestationFile);
        const evidenceType = subscriptionReturnEvidenceType(attestationFile);
        if (selected.status === "FAILED" || !evidenceType) throw new Error(selected.error ?? "证据文件无效。");
        const uploaded = await uploadSubscriptionReturnEvidence(closure.closureCaseId, {
          capturedAt: new Date().toISOString(),
          evidenceType,
          file: attestationFile,
          idempotencyKey: crypto.randomUUID(),
          targetId: closure.closureCaseId,
          targetType: "CASE_ATTESTATION",
          visibility: "CUSTOMER_VISIBLE"
        });
        if (typeof uploaded.evidenceId !== "string") throw new Error("见证证据上传结果无效。");
        attestationEvidenceIds = [uploaded.evidenceId];
      }
      await captureSubscriptionReturnChecklist(closure.closureCaseId, {
        attestationEvidenceIds,
        attestationMode: values.attestationMode,
        attestationReason: values.attestationReason || undefined,
        capturedAt: new Date().toISOString(),
        customerComments: values.customerComments || undefined,
        idempotencyKey: crypto.randomUUID(),
        items: values.items,
        witnesses:
          values.attestationMode === "CUSTOMER_SIGNED"
            ? []
            : (values.witnesses ?? "")
                .split(/[，,]/)
                .map((item) => item.trim())
                .filter(Boolean)
      });
      void message.success("退车现场清单已形成不可变修订版。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法保存退车现场清单");
    } finally {
      setSaving(false);
    }
  }

  async function uploadItemEvidence(itemId: string) {
    const file = itemFiles[itemId];
    if (!file) return void message.info("请先选择现场文件。");
    const selected = selectSubscriptionReturnFile(file);
    const evidenceType = subscriptionReturnEvidenceType(file);
    if (selected.status === "FAILED" || !evidenceType) {
      return void message.error(selected.error ?? "证据文件无效。");
    }
    setUploadingItemId(itemId);
    try {
      await uploadSubscriptionReturnEvidence(closure.closureCaseId, {
        capturedAt: new Date().toISOString(),
        evidenceType,
        file,
        idempotencyKey: crypto.randomUUID(),
        targetId: itemId,
        targetType: "CHECKLIST_ITEM",
        visibility: "CUSTOMER_VISIBLE"
      });
      setItemFiles((current) => ({ ...current, [itemId]: null }));
      void message.success("现场证据已上传并绑定到确认项。");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? `${error.message}，可保留文件后重试。` : "上传失败，可重试。");
    } finally {
      setUploadingItemId(null);
    }
  }

  return (
    <Card title="节点 1 · 现场取回与受管证据">
      <Alert
        message="请逐项确认车辆外观、内饰、钥匙、行驶证、充电设备和随车附件。客户拒签或缺席不会阻断取回，但必须记录原因、见证人与现场证据。"
        showIcon
        style={{ marginBottom: 16 }}
        type="info"
      />
      {closure.returnManifestSigning && closure.status === "PREPARING_RETURN" ? (
        <Alert
          action={
            returnManifestSigningCompleted ? (
              <Typography.Link
                href={`${API_BASE_URL}/subscription-closures/${closure.closureCaseId}/return-manifest/signed-document/preview`}
                rel="noreferrer"
                target="_blank"
              >
                查看已签署退车确认单
              </Typography.Link>
            ) : closure.returnManifestSigning.cancellable ? (
              <Button
                danger
                disabled={!closure.capabilities.receive}
                loading={cancellingSigning}
                onClick={() => void cancelSigningForCorrection()}
              >
                取消当前签署并更正清单
              </Button>
            ) : null
          }
          description={
            returnManifestSigningCompleted
              ? "已签署的退车确认单是不可变证据，不能取消或覆盖。请继续确认车辆取回；新发现的车况差异、补充证据和费用责任在下一节点记录。"
              : closure.returnManifestSigning.cancellable
                ? closure.returnManifestSigning.provider === "FADADA"
                  ? "签署任务存在期间，清单和客户可见证据保持锁定。如法大大任务已发出，请先由管理员在法大大后台撤销该未完成任务，再点击此按钮核验撤销结果；平台确认已撤销后，原链接失效并可保存新清单修订版。"
                  : "签署任务存在期间，清单和客户可见证据保持锁定。取消后原任务及链接失效，保存新清单修订版后会生成新的签署任务。"
                : "电子签平台任务已发出，当前供应商没有可核验的在线撤销能力。为避免双份有效文件，系统保持原任务有效；请完成签署或联系管理员线下核验处理。"
          }
          message={
            returnManifestSigningCompleted
              ? "退车确认单已签署 · 请继续确认车辆取回"
              : `退车确认单签署中 · ${closure.returnManifestSigning.taskStatus}`
          }
          showIcon
          style={{ marginBottom: 16 }}
          type={returnManifestSigningCompleted ? "success" : "warning"}
        />
      ) : null}
      <Form
        disabled={!canCaptureChecklist || Boolean(closure.returnManifestSigning)}
        form={form}
        initialValues={{
          attestationMode: closure.checklist?.attestationMode ?? "CUSTOMER_SIGNED",
          items: initialItems
        }}
        key={closure.checklist?.id ?? "new-checklist"}
        layout="vertical"
        onFinish={saveChecklist}
      >
        <Form.Item label="现场确认方式" name="attestationMode" rules={[{ required: true }]}>
          <Select
            options={[
              { label: "客户现场签署", value: "CUSTOMER_SIGNED" },
              { label: "客户拒绝签署（见证兜底）", value: "CUSTOMER_REFUSED" },
              { label: "客户未到场（见证兜底）", value: "CUSTOMER_ABSENT" }
            ]}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(before, after) => before.attestationMode !== after.attestationMode}>
          {({ getFieldValue }) =>
            getFieldValue("attestationMode") === "CUSTOMER_SIGNED" ? null : (
              <Space align="start" direction="vertical" style={{ width: "100%" }}>
                <Form.Item label="拒签/缺席原因" name="attestationReason" rules={[{ required: true }]}>
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.Item label="现场见证人（逗号分隔）" name="witnesses" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <label>
                  见证证据（照片、视频或 PDF）
                  <input
                    accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
                    disabled={!canCaptureChecklist || Boolean(closure.returnManifestSigning)}
                    onChange={(event) => setAttestationFile(event.target.files?.[0] ?? null)}
                    style={{ display: "block", marginTop: 8 }}
                    type="file"
                  />
                </label>
              </Space>
            )
          }
        </Form.Item>
        {CHECKLIST_ITEMS.map(([itemCode, label]) => (
          <Card key={itemCode} size="small" style={{ marginTop: 10 }}>
            <Typography.Text strong>{label}</Typography.Text>
            <Form.Item hidden name={["items", CHECKLIST_ITEMS.findIndex(([code]) => code === itemCode), "itemCode"]} />
            <Space align="start" style={{ marginTop: 8 }} wrap>
              <Form.Item label="状态" name={["items", CHECKLIST_ITEMS.findIndex(([code]) => code === itemCode), "state"]} rules={[{ required: true }]}>
                <Select
                  style={{ width: 170 }}
                  options={[
                    { label: "正常/已交回", value: "NORMAL" },
                    { label: "缺失", value: "MISSING" },
                    { label: "损伤", value: "DAMAGED" },
                    { label: "不适用", value: "NOT_APPLICABLE" },
                    { label: "待核验", value: "PENDING_VERIFICATION" }
                  ]}
                />
              </Form.Item>
              <Form.Item label="应交数量" name={["items", CHECKLIST_ITEMS.findIndex(([code]) => code === itemCode), "expectedQuantity"]}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item label="实交数量" name={["items", CHECKLIST_ITEMS.findIndex(([code]) => code === itemCode), "returnedQuantity"]}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item label="现场备注" name={["items", CHECKLIST_ITEMS.findIndex(([code]) => code === itemCode), "remark"]}>
                <Input style={{ width: 260 }} />
              </Form.Item>
            </Space>
          </Card>
        ))}
        <Form.Item label="客户现场备注" name="customerComments" style={{ marginTop: 12 }}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Button htmlType="submit" loading={saving} type="primary">
          {closure.checklist ? "保存新的清单修订版" : "保存现场清单"}
        </Button>
      </Form>

      {closure.checklist ? (
        <div style={{ marginTop: 20 }}>
          <Typography.Title level={5}>受管证据上传</Typography.Title>
          <Alert
            message="电子签在钥匙、行驶证、车辆外观和内饰证据齐全前保持业务等待；补齐后自动继续，不进入死信。"
            showIcon
            style={{ marginBottom: 12 }}
            type="warning"
          />
          {closure.checklist.items.map((item) => {
            const hasEvidence = evidenceItemIds.has(item.id);
            return (
              <Space key={item.id} style={{ display: "flex", marginBottom: 10 }} wrap>
                <Typography.Text style={{ width: 150 }}>{item.itemCode}</Typography.Text>
                <Tag color={hasEvidence ? "green" : "default"}>{hasEvidence ? "已有证据" : "待上传"}</Tag>
                <input
                  accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
                  disabled={!canUploadReturnEvidence || Boolean(closure.returnManifestSigning)}
                  onChange={(event) =>
                    setItemFiles((current) => ({ ...current, [item.id]: event.target.files?.[0] ?? null }))
                  }
                  type="file"
                />
                <Button
                  disabled={!canUploadReturnEvidence || Boolean(closure.returnManifestSigning)}
                  loading={uploadingItemId === item.id}
                  onClick={() => void uploadItemEvidence(item.id)}
                >
                  上传并绑定
                </Button>
                {closure.evidenceLinks
                  .filter((link) => link.checklistItemId === item.id && link.evidenceId)
                  .map((link, index) => (
                    <Typography.Link
                      href={`${API_BASE_URL}/subscription-closures/${closure.closureCaseId}/return-evidence/${link.id}/preview`}
                      key={link.id}
                      rel="noreferrer"
                      target="_blank"
                    >
                      查看证据 {index + 1}
                    </Typography.Link>
                  ))}
              </Space>
            );
          })}
          {registrationItem &&
          ["MISSING", "DAMAGED", "PENDING_VERIFICATION"].includes(
            registrationItem.state
          ) ? (
            <Alert
              action={
                !registrationApproval ||
                ["REJECTED", "EXPIRED"].includes(registrationApproval.status) ? (
                  canRequestApproval ? (
                    <Button
                      disabled={registrationEvidenceIds.length === 0}
                      loading={registrationApprovalBusy}
                      onClick={() => void requestRegistrationApproval()}
                    >
                      {registrationApproval ? "重新发起管理员审批" : "申请管理员批准继续签署"}
                    </Button>
                  ) : null
                ) : registrationApproval.status === "PENDING" ? (
                  registrationApproval.requestedBy === currentUserId ? (
                    <Typography.Text type="secondary">
                      需由另一名有审批权限的管理员处理
                    </Typography.Text>
                  ) : canApproveApproval ? (
                    <Space wrap>
                      <Input
                        onChange={(event) => setRegistrationApprovalComment(event.target.value)}
                        placeholder="填写审批意见"
                        style={{ width: 240 }}
                        value={registrationApprovalComment}
                      />
                      <Button
                        loading={registrationApprovalBusy}
                        onClick={() => void decideRegistrationApproval("APPROVED")}
                        type="primary"
                      >
                        批准继续签署
                      </Button>
                      <Button
                        danger
                        loading={registrationApprovalBusy}
                        onClick={() => void decideRegistrationApproval("REJECTED")}
                      >
                        驳回
                      </Button>
                    </Space>
                  ) : null
                ) : null
              }
              description={
                registrationApproval?.status === "APPROVED"
                  ? "审批与当前清单版本、行驶证状态及现场证明一致，电子签任务可继续。"
                  : "先上传能够证明行驶证缺失、损坏或待核验原因的现场材料；审批通过前电子签保持业务等待，不进入死信。"
              }
              message={
                registrationApproval?.status === "APPROVED"
                  ? "行驶证签署兜底已批准"
                  : registrationApproval?.status === "PENDING"
                    ? "行驶证签署兜底等待独立审批"
                    : "行驶证状态阻断电子签"
              }
              showIcon
              style={{ marginTop: 12 }}
              type={registrationApproval?.status === "APPROVED" ? "success" : "warning"}
            />
          ) : null}
          {closure.status === "PREPARING_RETURN" ? (
            <>
              <Button
                disabled={!canConfirmReceipt}
                loading={receiving}
                onClick={() => void confirmPhysicalReceipt()}
                style={{ marginTop: 12 }}
                type="primary"
              >
                确认车辆及随车资料已取回
              </Button>
              {!canConfirmReceipt ? (
                <Typography.Text style={{ marginLeft: 12 }} type="secondary">
                  客户签署路径需等待退车清单电子签归档；拒签/缺席路径完成见证证据后可继续。
                </Typography.Text>
              ) : null}
            </>
          ) : (
            <Alert
              action={
                closure.checklist?.attestationMode === "CUSTOMER_SIGNED" ? (
                  <Typography.Link
                    href={`${API_BASE_URL}/subscription-closures/${closure.closureCaseId}/return-manifest/signed-document/preview`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    查看已签署退车确认单
                  </Typography.Link>
                ) : null
              }
              message="车辆取回已确认；现场清单和证据保留为不可变审计记录。"
              showIcon
              style={{ marginTop: 12 }}
              type="success"
            />
          )}
        </div>
      ) : null}
    </Card>
  );
}

function damageTypeFor(itemCode: string) {
  if (itemCode === "VEHICLE_EXTERIOR") return "EXTERIOR";
  if (itemCode === "VEHICLE_INTERIOR") return "INTERIOR";
  if (itemCode === "BATTERY") return "BATTERY";
  if (itemCode === "CHARGING_EQUIPMENT" || itemCode === "ACCESSORIES") return "EQUIPMENT";
  return "OTHER";
}
