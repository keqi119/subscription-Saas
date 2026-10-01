"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import { useEffect, useRef, useState } from "react";

import { API_BASE_URL, ApiError } from "../../lib/api";
import {
  advanceSubscriptionClosureSettlement,
  completeSubscriptionClosureOperations,
  decideSubscriptionClosureApproval,
  decideSubscriptionClosureDispute,
  exportSubscriptionClosureEvidencePackage,
  recordSubscriptionClosureLegalEvent,
  recordSubscriptionClosureNoResponse,
  recordSubscriptionClosureDisposition,
  releaseSubscriptionClosureInventory,
  requestSubscriptionClosureApproval,
  transferSubscriptionClosureLegalCollection,
  uploadSubscriptionClosureFinancialProof
} from "../../lib/subscription-closure-api";
import type { AdminSubscriptionClosureView } from "../../lib/subscription-closure-view-model";

type EvidenceExport = { exportId: string; manifestHash: string; version: number };

type FinancialBinding = {
  closureCaseId: string;
  currentUserId: string | null;
  settlementRevisionId: string;
  settlementResultHash: string;
  canRequest: boolean;
  canApprove: boolean;
  canSettle: boolean;
  bills: readonly { id: string; remainingAmount: string }[];
};
type FinancialKind = "WAIVER" | "WRITE_OFF";
export function returnFinancialApprovalBinding(
  closure: AdminSubscriptionClosureView,
  currentUserId: string | null,
  canRequest: boolean,
  canApprove: boolean
): FinancialBinding {
  const currentSettlement = closure.settlementRevisions.at(-1);
  return {
    closureCaseId: closure.closureCaseId,
    currentUserId,
    settlementRevisionId: currentSettlement?.id ?? "",
    settlementResultHash: currentSettlement?.resultHash ?? "",
    canRequest,
    canApprove,
    canSettle:
      closure.capabilities.settle &&
      closure.allowedActions.some(({ key }) => key === "RECORD_RECEIVABLE_DISPOSITION") &&
      ["FINALIZED", "SETTLED"].includes(currentSettlement?.stage ?? ""),
    bills: closure.receivableBills.map(({ id, remainingAmount }) => ({ id, remainingAmount }))
  };
}
type FinancialRequest = {
  billId: string;
  approvalType: FinancialKind;
  reason: string;
  proof: File;
};
type FinancialDecision = {
  billId: string;
  approvalType: FinancialKind;
  approval: { id: string; version: number; status: string; requestedBy: string };
  decision: "APPROVED" | "REJECTED";
  comment: string;
};
type FinancialPending = {
  kind: "request" | "decision";
  closureCaseId: string;
  billId: string;
  approvalId: string | null;
  command: Readonly<Record<string, unknown>> | null;
  committed: boolean;
  blocked: boolean;
  responseId: string | null;
};
type FinancialSnapshot = {
  pending: FinancialPending | null;
  busy: boolean;
  error: string | null;
  status:
    | "idle"
    | "uploading"
    | "posting"
    | "upload-unknown"
    | "unknown"
    | "refresh-required"
    | "blocked"
    | "ready";
};
const emptyFinancialSnapshot = (): FinancialSnapshot => ({
  pending: null,
  busy: false,
  error: null,
  status: "idle"
});

export function createReturnFinancialApprovalController(callbacks: {
  reloadClosure: () => Promise<AdminSubscriptionClosureView>;
  onClosureReadback: (view: AdminSubscriptionClosureView) => Promise<void> | void;
  onState: (snapshot: FinancialSnapshot) => void;
  isCurrent?: () => boolean;
}) {
  let binding: FinancialBinding | null = null;
  let generation = 0;
  let readSequence = 0;
  let disposed = false;
  let writing = false;
  let snapshot = emptyFinancialSnapshot();
  const current = (token: number) =>
    !disposed && generation === token && callbacks.isCurrent?.() !== false;
  function publish(patch: Partial<FinancialSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    callbacks.onState(snapshot);
  }
  function writable(kind: FinancialPending["kind"], billId: string) {
    return (
      current(generation) &&
      binding?.currentUserId &&
      binding.canSettle &&
      (kind === "request" ? binding.canRequest : binding.canApprove) &&
      binding.bills.some(
        (bill) =>
          bill.id === billId &&
          /^\d+$/.test(bill.remainingAmount) &&
          BigInt(bill.remainingAmount) > 0n
      )
    );
  }
  function unresolvedStatus(pending = snapshot.pending): FinancialSnapshot["status"] {
    return !pending
      ? "idle"
      : pending.blocked
        ? "blocked"
        : pending.committed
          ? "refresh-required"
          : !pending.command
            ? "upload-unknown"
            : "unknown";
  }
  async function read(clearIntent = false) {
    if (!current(generation) || !binding || writing) return;
    const token = generation;
    const sequence = ++readSequence;
    publish({ busy: true, error: null });
    const active = () => current(token) && sequence === readSequence;
    try {
      const view = await callbacks.reloadClosure();
      if (!active()) return;
      if (view.closureCaseId !== binding!.closureCaseId)
        throw new Error("财务审批读回与当前结案不符。");
      const revision = view.settlementRevisions.at(-1);
      let pending = snapshot.pending;
      if (
        pending &&
        (revision?.id !== binding!.settlementRevisionId ||
          revision.resultHash !== binding!.settlementResultHash ||
          view.receivableBills.find((bill) => bill.id === pending!.billId)?.remainingAmount !==
            binding!.bills.find((bill) => bill.id === pending!.billId)?.remainingAmount)
      ) {
        pending = { ...pending, blocked: true };
        publish({ pending });
      }
      // A historical command ACK cannot grant authority; only publish the actual current GET.
      await callbacks.onClosureReadback(view);
      if (!active()) return;
      const acknowledged =
        pending?.committed &&
        pending.responseId &&
        view.approvals.some((approval) => approval.id === pending.responseId);
      if (clearIntent || !pending || (acknowledged && !pending.blocked)) {
        publish({ pending: null, status: "ready", error: null });
      } else {
        publish({
          status: unresolvedStatus(pending),
          error: pending.blocked
            ? "审批依据或权限已变化，请核对后开始新操作。"
            : "操作结果仍待确认，请读取当前状态或重试原操作。"
        });
      }
    } catch (error) {
      if (active())
        publish({
          status: unresolvedStatus(),
          error: error instanceof Error ? error.message : "财务审批读取失败。"
        });
    } finally {
      if (active()) publish({ busy: false });
    }
  }
  async function send(pending: FinancialPending, token: number) {
    if (!current(token) || !pending.command || !writable(pending.kind, pending.billId)) return;
    writing = true;
    publish({ pending, busy: true, status: "posting", error: null });
    try {
      const response =
        pending.kind === "request"
          ? await requestSubscriptionClosureApproval(pending.closureCaseId, pending.command)
          : await decideSubscriptionClosureApproval(
              pending.closureCaseId,
              pending.approvalId!,
              pending.command
            );
      if (!current(token)) return;
      pending = {
        ...pending,
        committed: true,
        responseId: typeof response?.id === "string" && response.id.length > 0 ? response.id : null
      };
      publish({ pending, status: "refresh-required" });
    } catch (error) {
      if (!current(token)) return;
      pending = {
        ...pending,
        blocked: error instanceof ApiError && error.status >= 400 && error.status < 500
      };
      publish({
        pending,
        status: unresolvedStatus(pending),
        error: error instanceof Error ? error.message : "审批响应未知。"
      });
    } finally {
      if (current(token)) writing = false;
    }
    if (current(token)) await read();
  }
  return {
    bind(context: FinancialBinding) {
      if (disposed || JSON.stringify(binding) === JSON.stringify(context)) return;
      binding = { ...context, bills: context.bills.map((bill) => ({ ...bill })) };
      generation++;
      readSequence++;
      writing = false;
      snapshot = emptyFinancialSnapshot();
      callbacks.onState(snapshot);
    },
    async startRequest(input: FinancialRequest) {
      if (
        !writable("request", input.billId) ||
        snapshot.busy ||
        snapshot.pending ||
        !input.reason.trim() ||
        !input.proof
      )
        return;
      const token = generation;
      const reason = input.reason.trim();
      const proof = input.proof;
      const approvalType = input.approvalType;
      const revisionId = binding!.settlementRevisionId;
      const key = crypto.randomUUID();
      let pending: FinancialPending = {
        kind: "request",
        closureCaseId: binding!.closureCaseId,
        billId: input.billId,
        approvalId: null,
        command: null,
        committed: false,
        blocked: false,
        responseId: null
      };
      writing = true;
      publish({ pending, busy: true, status: "uploading", error: null });
      try {
        const uploaded = await uploadSubscriptionClosureFinancialProof(
          pending.closureCaseId,
          proof
        );
        if (!current(token)) return;
        if (typeof uploaded?.fileId !== "string" || !uploaded.fileId)
          throw new Error("上传结果未包含可确认的文件编号。");
        pending = {
          ...pending,
          command: Object.freeze({
            approvalType,
            billId: pending.billId,
            evidenceIds: Object.freeze([uploaded.fileId]),
            idempotencyKey: key,
            requestReason: reason,
            settlementRevisionId: revisionId
          })
        };
      } catch (error) {
        if (current(token))
          publish({
            status: "upload-unknown",
            error:
              error instanceof Error
                ? error.message
                : "上传结果尚未确定，请先读取后再决定是否重新上传。"
          });
        return;
      } finally {
        if (current(token)) {
          writing = false;
          publish({ busy: false });
        }
      }
      if (current(token)) await send(pending, token);
    },
    async startDecision(input: FinancialDecision) {
      if (
        !writable("decision", input.billId) ||
        snapshot.busy ||
        snapshot.pending ||
        input.approval.status !== "PENDING" ||
        input.approval.requestedBy.toLowerCase() === binding!.currentUserId!.toLowerCase() ||
        !input.comment.trim() ||
        !Number.isSafeInteger(input.approval.version) ||
        input.approval.version < 0
      )
        return;
      await send(
        {
          kind: "decision",
          closureCaseId: binding!.closureCaseId,
          billId: input.billId,
          approvalId: input.approval.id,
          command: Object.freeze({
            decision: input.decision,
            decisionComment: input.comment.trim(),
            expectedVersion: input.approval.version,
            idempotencyKey: crypto.randomUUID()
          }),
          committed: false,
          blocked: false,
          responseId: null
        },
        generation
      );
    },
    async retry() {
      const pending = snapshot.pending;
      if (disposed || snapshot.busy || !pending) return;
      if (!pending.command || pending.committed || pending.blocked) return read();
      if (writable(pending.kind, pending.billId)) return send(pending, generation);
    },
    async reload() {
      return read();
    },
    async beginNewIntent() {
      if (!snapshot.busy) return read(true);
    },
    dispose() {
      disposed = true;
      generation++;
      readSequence++;
      writing = false;
    },
    getSnapshot() {
      return snapshot;
    }
  };
}

export function ReturnFinancialApprovalRecovery({
  snapshot,
  onRetry,
  onReload,
  onNewIntent
}: {
  snapshot: FinancialSnapshot;
  onRetry: () => void;
  onReload: () => void;
  onNewIntent: () => void;
}) {
  if (!snapshot.pending) return null;
  const uploadUnknown = snapshot.status === "upload-unknown";
  return (
    <Alert
      type="warning"
      showIcon
      title={
        uploadUnknown
          ? "上传结果未确定"
          : snapshot.pending.committed
            ? "审批命令已确认，需读取当前状态"
            : "财务审批操作待确认"
      }
      description={
        <Space orientation="vertical">
          <Typography.Text>
            {uploadUnknown
              ? "尚未取得文件编号，审批未提交。不会自动重新上传；读取后可选择开始新操作，原上传文件可能已经保存。"
              : (snapshot.error ?? "请先确认当前审批状态，再继续账单处理。")}
          </Typography.Text>
          <Space wrap>
            {snapshot.pending.command &&
            !snapshot.pending.committed &&
            !snapshot.pending.blocked ? (
              <Button disabled={snapshot.busy} onClick={onRetry}>
                重试原审批命令
              </Button>
            ) : null}
            <Button disabled={snapshot.busy} onClick={onReload}>
              重新读取当前状态
            </Button>
            <Button disabled={snapshot.busy} onClick={onNewIntent}>
              读取后开始新操作
            </Button>
          </Space>
        </Space>
      }
    />
  );
}

export function ReturnSettlementStage({
  canApproveApproval,
  canRequestApproval,
  closure,
  currentUserId,
  onChanged,
  reloadClosure,
  onClosureReadback
}: {
  canApproveApproval: boolean;
  canRequestApproval: boolean;
  closure: AdminSubscriptionClosureView;
  currentUserId: string | null;
  onChanged: () => Promise<void> | void;
  reloadClosure: () => Promise<AdminSubscriptionClosureView>;
  onClosureReadback: (view: AdminSubscriptionClosureView) => Promise<void> | void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [financialState, setFinancialState] = useState(emptyFinancialSnapshot);
  const financialController = useRef<ReturnType<typeof createReturnFinancialApprovalController> | null>(null);
  const [dispositionByBill, setDispositionByBill] = useState<Record<string, string>>({});
  const [detailByBill, setDetailByBill] = useState<Record<string, string>>({});
  const [proofFileByBill, setProofFileByBill] = useState<Record<string, File | null>>({});
  const [evidenceExport, setEvidenceExport] = useState<EvidenceExport | null>(null);
  const [approvalCommentByBill, setApprovalCommentByBill] = useState<Record<string, string>>({});
  const [disputeDecision, setDisputeDecision] = useState<Record<string, string>>({});
  const [disputeRationale, setDisputeRationale] = useState<Record<string, string>>({});
  const [disputeEvidence, setDisputeEvidence] = useState<Record<string, string[]>>({});
  const [legalBillId, setLegalBillId] = useState<string | null>(null);
  const [legalCaseId, setLegalCaseId] = useState<string | null>(null);
  const [legalEventType, setLegalEventType] = useState<string | null>(null);
  const [legalEventAmount, setLegalEventAmount] = useState("");
  const [legalEventDetail, setLegalEventDetail] = useState("");
  const [legalEventProof, setLegalEventProof] = useState<File | null>(null);
  const allowedActionKeys = new Set(closure.allowedActions.map(({ key }) => key));
  const canPerform = (key: string) =>
    closure.capabilities.settle && allowedActionKeys.has(key);
  const canDisposition = canPerform("RECORD_RECEIVABLE_DISPOSITION");
  const canDecideDispute = canPerform("DECIDE_DISPUTE");
  const canRecordNoResponse = canPerform("RECORD_NO_RESPONSE");
  const canSettleFinancial = canPerform("SETTLE_FINANCIAL");
  const canReleaseInventory = canPerform("RELEASE_INVENTORY");
  const canCompleteOperations = canPerform("COMPLETE_OPERATIONS");
  const canExportEvidence = canPerform("EXPORT_EVIDENCE_PACKAGE");
  const canTransferLegal = canPerform("TRANSFER_LEGAL_COLLECTION");
  const canRecordLegalEvent = canPerform("RECORD_LEGAL_EVENT");
  const currentSettlement = closure.settlementRevisions.at(-1) ?? null;
  const financialBinding = returnFinancialApprovalBinding(closure, currentUserId, canRequestApproval, canApproveApproval);
  const financialBindingKey = JSON.stringify(financialBinding);
  const financialBindingRef = useRef(financialBinding);
  financialBindingRef.current = financialBinding;
  const financialKeyRef = useRef(financialBindingKey);
  financialKeyRef.current = financialBindingKey;
  useEffect(() => {
    // Each effect setup owns a fresh controller; disposed StrictMode instances stay unusable.
    const isCurrent = () => financialKeyRef.current === financialBindingKey;
    const instance = createReturnFinancialApprovalController({
      reloadClosure,
      onClosureReadback,
      isCurrent,
      onState: (state) => { if (isCurrent()) setFinancialState(state); }
    });
    financialController.current = instance;
    instance.bind(financialBindingRef.current);
    return () => {
      instance.dispose();
      if (financialController.current === instance) financialController.current = null;
    };
  }, [financialBindingKey, reloadClosure, onClosureReadback]);
  const financialLocked = financialState.busy || financialState.pending !== null;
  const finalizedSettlement =
    currentSettlement?.stage === "SETTLED"
      ? closure.settlementRevisions.find(
          (settlement) => settlement.id === currentSettlement.supersedesRevisionId
        ) ?? null
      : currentSettlement?.stage === "FINALIZED"
        ? currentSettlement
        : null;
  const currentPricingSettlementId =
    currentSettlement?.stage === "PROPOSED"
      ? currentSettlement.id
      : finalizedSettlement?.supersedesRevisionId ?? null;
  const noResponseDeadline = currentSettlement?.publishedAt
    ? new Date(new Date(currentSettlement.publishedAt).getTime() + 72 * 60 * 60 * 1000)
    : null;
  const billLines = closure.chargeLines.filter(
    (line) =>
      line.status === "FINAL" &&
      line.settlementRevisionId === currentPricingSettlementId &&
      Boolean(line.billId)
  );
  const currentFinalLineIds = new Set(
    closure.chargeLines
      .filter(
        (line) =>
          line.status === "FINAL" &&
          line.settlementRevisionId === currentPricingSettlementId
      )
      .map((line) => line.id)
  );
  const currentBlockingDisputes = closure.disputes.filter(
    (dispute) =>
      currentFinalLineIds.has(dispute.chargeLineId) &&
      (dispute.status === "OPEN" || dispute.status === "ACCEPTED_BY_PLATFORM")
  );
  const canCompleteFinancialSettlement =
    canSettleFinancial &&
    currentSettlement?.stage === "FINALIZED" &&
    Boolean(
      closure.customerResponse &&
        ["ACCEPTED", "DISPUTED", "PARTIALLY_DISPUTED", "NO_RESPONSE"].includes(
          closure.customerResponse.status
        )
    ) &&
    currentBlockingDisputes.length === 0 &&
    closure.receivableBills.every((bill) => BigInt(bill.remainingAmount) === 0n);
  const latestPersistedEvidencePackage = closure.evidencePackages.at(-1);
  const activeEvidenceExport =
    evidenceExport ??
    (latestPersistedEvidencePackage
      ? {
          exportId: latestPersistedEvidencePackage.id,
          manifestHash: latestPersistedEvidencePackage.manifestHash,
          version: latestPersistedEvidencePackage.version
        }
      : null);

  function financialApprovalForBill(billId: string, disposition: string) {
    const bill = closure.receivableBills.find((item) => item.id === billId);
    const approvalType =
      disposition === "WAIVED"
        ? "SETTLEMENT_WAIVER"
        : disposition === "WRITTEN_OFF"
          ? "SETTLEMENT_WRITE_OFF"
          : null;
    const subjectPrefix = disposition === "WAIVED" ? "settlementWaiver" : "settlementWriteOff";
    if (!bill || !approvalType || !currentSettlement) return null;
    return [...closure.approvals]
      .reverse()
      .find(
        (approval) =>
          approval.type === approvalType &&
          approval.subjectField === `${subjectPrefix}:${billId}` &&
          approval.billId === billId &&
          approval.amountCents === bill.remainingAmount &&
          approval.settlementRevisionId === currentSettlement.id
      ) ?? null;
  }

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    if (financialController.current?.getSnapshot().pending || financialController.current?.getSnapshot().busy) {
      void message.warning("请先确认财务审批操作结果，再继续结算操作。");
      return;
    }
    setBusy(key);
    try {
      await action();
      void message.success(success);
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败，请按页面提示处理后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function exportPackage() {
    setBusy("export");
    try {
      const value = await exportSubscriptionClosureEvidencePackage(closure.closureCaseId);
      if (
        typeof value.exportId !== "string" ||
        typeof value.manifestHash !== "string" ||
        typeof value.version !== "number"
      ) {
        throw new Error("证据包导出结果无效。");
      }
      setEvidenceExport(value as EvidenceExport);
      void message.success("证据包已按当前事实快照固化。");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法导出证据包。");
    } finally {
      setBusy(null);
    }
  }

  async function requestFinancialApproval(billId: string, disposition: string) {
    const bill = closure.receivableBills.find((item) => item.id === billId);
    const proofFile = proofFileByBill[billId];
    const detail = detailByBill[billId]?.trim();
    if (
      !bill ||
      !currentSettlement ||
      !["WAIVED", "WRITTEN_OFF"].includes(disposition) ||
      !proofFile ||
      !detail
    ) {
      void message.error("发起减免或核销审批前，必须填写处理说明并上传证明文件。");
      return;
    }
    if (busy) return;
    await financialController.current?.startRequest({ billId, approvalType: disposition === "WAIVED" ? "WAIVER" : "WRITE_OFF", reason: detail, proof: proofFile });
  }

  async function decideFinancialApproval(
    billId: string,
    disposition: string,
    decision: "APPROVED" | "REJECTED"
  ) {
    const approval = financialApprovalForBill(billId, disposition);
    const comment = approvalCommentByBill[billId]?.trim();
    if (!approval || approval.status !== "PENDING" || !comment) {
      void message.error("请确认待审批记录并填写审批意见。");
      return;
    }
    if (busy) return;
    await financialController.current?.startDecision({ billId, approvalType: disposition === "WAIVED" ? "WAIVER" : "WRITE_OFF", approval, decision, comment });
  }

  function recordDisposition(billId: string, chargeLineId: string | null) {
    const disposition = dispositionByBill[billId];
    const detail = detailByBill[billId]?.trim();
    if (!disposition || !detail) {
      void message.error("请选择未清应收归口并填写处理说明。");
      return;
    }
    const approval = financialApprovalForBill(billId, disposition);
    const approvalId = approval?.status === "APPROVED" ? approval.id : null;
    if (
      (disposition === "WAIVED" || disposition === "WRITTEN_OFF") &&
      (!approvalId || approval?.decision !== "APPROVED")
    ) {
      void message.error("请先完成与当前账单余额和证明文件一致的独立审批。");
      return;
    }
    if (disposition === "MANUAL_PAYMENT_CONFIRMED" && !proofFileByBill[billId]) {
      void message.error("人工收款、减免或核销必须上传证明文件。");
      return;
    }
    void run(
      `disposition:${billId}`,
      async () => {
        const proof = disposition === "MANUAL_PAYMENT_CONFIRMED"
          ? await uploadSubscriptionClosureFinancialProof(
              closure.closureCaseId,
              proofFileByBill[billId]!
            )
          : null;
        const governedProofFileId =
          disposition === "WAIVED" || disposition === "WRITTEN_OFF"
            ? approval?.evidenceIds[0] ?? null
            : proof?.fileId ?? null;
        return recordSubscriptionClosureDisposition(closure.closureCaseId, {
          approvalId,
          billId,
          chargeLineId,
          detail: { note: detail },
          disposition,
          idempotencyKey: crypto.randomUUID(),
          ownerId: currentUserId,
          ownerType: "ADMIN_USER",
          proofFileId: governedProofFileId
        });
      },
      "未清应收归口已记录；车辆与合同运营闭环不会被悬空账款阻断。"
    );
  }

  function decideDispute(disputeId: string) {
    const decision = disputeDecision[disputeId];
    const rationale = disputeRationale[disputeId]?.trim();
    const evidenceIds = disputeEvidence[disputeId] ?? [];
    if (!decision || !rationale || evidenceIds.length === 0) {
      void message.error("争议结论必须包含决定、理由及至少一项受管证据。");
      return;
    }
    void run(
      `dispute:${disputeId}`,
      () =>
        decideSubscriptionClosureDispute(closure.closureCaseId, disputeId, {
          decision,
          evidenceIds,
          idempotencyKey: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          rationale
        }),
      "争议处理结论已锁定。收费金额如需变化，必须另建后继结算版本。"
    );
  }

  function recordLegalEvent() {
    const selectedCase = closure.legalCases.find((item) => item.id === legalCaseId);
    const detail = legalEventDetail.trim();
    if (!selectedCase || !legalEventType || !detail) {
      void message.error("请选择法催案件、事件类型并填写事件说明。");
      return;
    }
    const amountCents = legalEventAmount.trim();
    if (
      legalEventType === "EXECUTION_RECEIVED" &&
      (!/^[1-9]\d*$/.test(amountCents) || !legalEventProof)
    ) {
      void message.error("执行回款必须填写正整数金额并上传回款凭证。");
      return;
    }
    void run(
      `legal-event:${selectedCase.id}`,
      async () => {
        const proof = legalEventProof
          ? await uploadSubscriptionClosureFinancialProof(
              closure.closureCaseId,
              legalEventProof
            )
          : null;
        return recordSubscriptionClosureLegalEvent(closure.closureCaseId, {
          amountCents: amountCents || null,
          detail: { note: detail },
          eventType: legalEventType,
          idempotencyKey: crypto.randomUUID(),
          legalCaseId: selectedCase.id,
          occurredAt: new Date().toISOString(),
          proofFileId: proof?.fileId ?? null
        });
      },
      "法催事件已固化；执行回款已同步核销对应账单。"
    );
  }

  function renderFinancialApproval(
    bill: AdminSubscriptionClosureView["receivableBills"][number]
  ) {
    const disposition = dispositionByBill[bill.id];
    if (disposition !== "WAIVED" && disposition !== "WRITTEN_OFF") return null;
    const approval = financialApprovalForBill(bill.id, disposition);
    if (!approval || approval.status === "REJECTED" || approval.status === "EXPIRED") {
      return canRequestApproval ? (
        <Button
          disabled={financialLocked || Boolean(busy)}
          loading={financialState.busy && financialState.pending?.kind === "request" && financialState.pending.billId === bill.id}
          onClick={() => void requestFinancialApproval(bill.id, disposition)}
        >
          {approval ? "重新发起审批" : "上传证明并发起审批"}
        </Button>
      ) : (
        <Tag color="orange">需有“例外申请”权限的管理员发起审批</Tag>
      );
    }
    if (approval.status === "PENDING") {
      return (
        <Space wrap>
          <Tag color="orange">等待独立审批</Tag>
          {approval.requestedBy === currentUserId ? (
            <Typography.Text type="secondary">申请人与审批人必须为不同管理员</Typography.Text>
          ) : canApproveApproval ? (
            <>
              <Input
                disabled={financialLocked}
                onChange={(event) =>
                  setApprovalCommentByBill((current) => ({
                    ...current,
                    [bill.id]: event.target.value
                  }))
                }
                placeholder="填写审批意见"
                style={{ width: 240 }}
                value={approvalCommentByBill[bill.id]}
              />
              <Button
                disabled={financialLocked || Boolean(busy)}
                loading={financialState.busy && financialState.pending?.kind === "decision" && financialState.pending.billId === bill.id}
                onClick={() =>
                  void decideFinancialApproval(bill.id, disposition, "APPROVED")
                }
                type="primary"
              >
                批准
              </Button>
              <Button
                danger
                disabled={financialLocked || Boolean(busy)}
                loading={financialState.busy && financialState.pending?.kind === "decision" && financialState.pending.billId === bill.id}
                onClick={() =>
                  void decideFinancialApproval(bill.id, disposition, "REJECTED")
                }
              >
                驳回
              </Button>
            </>
          ) : (
            <Typography.Text type="secondary">
              需有“例外审批”权限的另一名管理员处理
            </Typography.Text>
          )}
        </Space>
      );
    }
    return <Tag color="green">审批已通过，可保存归口</Tag>;
  }

  return (
    <Card title="节点 3 · 客户确认、账单处理与订单完结">
      <ReturnFinancialApprovalRecovery
        snapshot={financialState}
        onRetry={() => { void financialController.current?.retry(); }}
        onReload={() => { void financialController.current?.reload(); }}
        onNewIntent={() => { void financialController.current?.beginNewIntent(); }}
      />
      <Descriptions
        bordered
        column={2}
        items={[
          { label: "结算阶段", children: currentSettlement?.stage ?? "待生成" },
          { label: "客户反馈", children: closure.customerResponse?.status ?? "待客户确认" },
          { label: "运营闭环", children: closure.operationalCompletedAt ? "已完成" : "未完成" },
          { label: "财务状态", children: <Tag>{closure.financialStatus}</Tag> }
        ]}
        size="small"
      />
      <Alert
        message="客户拒绝或争议不阻断车辆取回和运营完结；但每笔未清应收必须明确为争议、催收或法催归口。"
        showIcon
        style={{ margin: "14px 0" }}
        type="info"
      />
      <Table
        columns={[
          { dataIndex: "lineCode", title: "收费项" },
          { dataIndex: "amountCents", title: "金额（分）" },
          { dataIndex: "status", title: "状态" },
          { dataIndex: "billId", render: (value: string | null) => value ?? "无需客户付款", title: "账单" }
        ]}
        dataSource={closure.chargeLines.filter(
          (line) =>
            line.status === "FINAL" &&
            line.settlementRevisionId === currentPricingSettlementId
        )}
        locale={{ emptyText: "暂无正式收费项" }}
        pagination={false}
        rowKey="id"
        size="small"
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        订单全部应收（含月租、押金及其他历史账单）
      </Typography.Title>
      <Table
        columns={[
          { dataIndex: "billNo", title: "账单号" },
          { dataIndex: "billType", title: "类型" },
          { dataIndex: "billStatus", title: "账单状态" },
          { dataIndex: "remainingAmount", title: "未清金额（分）" },
          {
            key: "currentDisposition",
            render: (_, bill) =>
              closure.receivableDispositions
                .filter((item) => item.billId === bill.id)
                .at(-1)?.disposition ?? "未归口",
            title: "当前归口"
          },
          {
            key: "actions",
            render: (_, bill) =>
              BigInt(bill.remainingAmount) > 0n && canDisposition ? (
                <Space wrap>
                  <Select
                    disabled={financialLocked}
                    onChange={(value: string) =>
                      setDispositionByBill((current) => ({ ...current, [bill.id]: value }))
                    }
                    options={[
                      { label: "客户争议处理中", value: "DISPUTED" },
                      { label: "人工催收处理中", value: "COLLECTION_PENDING" },
                      { label: "保持未清并指定归口", value: "OPEN" },
                      { label: "人工收款已确认", value: "MANUAL_PAYMENT_CONFIRMED" },
                      { label: "批准减免", value: "WAIVED" },
                      { label: "批准核销", value: "WRITTEN_OFF" }
                    ]}
                    placeholder="选择处理归口"
                    style={{ width: 190 }}
                    value={dispositionByBill[bill.id]}
                  />
                  <Input
                    disabled={financialLocked}
                    onChange={(event) =>
                      setDetailByBill((current) => ({ ...current, [bill.id]: event.target.value }))
                    }
                    placeholder="处理说明"
                    style={{ width: 220 }}
                    value={detailByBill[bill.id]}
                  />
                  <input
                    disabled={financialLocked}
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(event) =>
                      setProofFileByBill((current) => ({
                        ...current,
                        [bill.id]: event.target.files?.[0] ?? null
                      }))
                    }
                    type="file"
                  />
                  {renderFinancialApproval(bill)}
                  <Button
                    disabled={
                      financialLocked || (["WAIVED", "WRITTEN_OFF"].includes(
                        dispositionByBill[bill.id] ?? ""
                      ) &&
                      financialApprovalForBill(
                        bill.id,
                        dispositionByBill[bill.id] ?? ""
                      )?.status !== "APPROVED")
                    }
                    loading={busy === `disposition:${bill.id}`}
                    onClick={() =>
                      recordDisposition(
                        bill.id,
                        billLines.find((line) => line.billId === bill.id)?.id ?? null
                      )
                    }
                  >
                    保存归口
                  </Button>
                </Space>
              ) : BigInt(bill.remainingAmount) > 0n ? (
                "无结算操作权限"
              ) : (
                "已清"
              ),
            title: "处理"
          }
        ]}
        dataSource={closure.receivableBills}
        pagination={false}
        rowKey="id"
        size="small"
      />
      {closure.disputes.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>客户逐项争议处理</Typography.Title>
          {closure.disputes.map((dispute) => (
            <Space key={dispute.id} style={{ display: "flex", marginBottom: 10 }} wrap>
              <Typography.Text style={{ width: 240 }}>
                {dispute.chargeLineId} · {dispute.customerReason}
              </Typography.Text>
              <Tag color={dispute.status === "OPEN" ? "orange" : "blue"}>{dispute.status}</Tag>
              {dispute.status === "OPEN" && canDecideDispute ? (
                <>
                  <Select
                    onChange={(value: string) =>
                      setDisputeDecision((current) => ({ ...current, [dispute.id]: value }))
                    }
                    options={[
                      { label: "平台接受客户争议", value: "ACCEPTED_BY_PLATFORM" },
                      { label: "平台驳回客户争议", value: "REJECTED_BY_PLATFORM" }
                    ]}
                    placeholder="处理结论"
                    style={{ width: 210 }}
                    value={disputeDecision[dispute.id]}
                  />
                  <Select
                    mode="multiple"
                    onChange={(value: string[]) =>
                      setDisputeEvidence((current) => ({ ...current, [dispute.id]: value }))
                    }
                    options={closure.evidenceLinks
                      .filter((link) => link.evidenceId)
                      .map((link) => ({ label: link.evidenceId!, value: link.evidenceId! }))}
                    placeholder="选择判定证据"
                    style={{ minWidth: 260 }}
                    value={disputeEvidence[dispute.id]}
                  />
                  <Input
                    onChange={(event) =>
                      setDisputeRationale((current) => ({
                        ...current,
                        [dispute.id]: event.target.value
                      }))
                    }
                    placeholder="处理理由"
                    style={{ width: 260 }}
                    value={disputeRationale[dispute.id]}
                  />
                  <Button
                    loading={busy === `dispute:${dispute.id}`}
                    onClick={() => decideDispute(dispute.id)}
                  >
                    锁定争议结论
                  </Button>
                </>
              ) : null}
            </Space>
          ))}
        </div>
      ) : null}
      {canRecordNoResponse && currentSettlement?.stage === "FINALIZED" && !closure.customerResponse ? (
        <Space style={{ marginTop: 14 }} wrap>
          <Typography.Text>
            系统确认截止时间：{noResponseDeadline?.toLocaleString() ?? "等待最终方案发布时间"}
          </Typography.Text>
          <Button
            disabled={!noResponseDeadline || Date.now() < noResponseDeadline.getTime()}
            loading={busy === "no-response"}
            onClick={() => {
              if (!noResponseDeadline || Date.now() < noResponseDeadline.getTime()) {
                void message.error("尚未到达系统计算的客户确认截止时间。");
                return;
              }
              void run(
                "no-response",
                () =>
                  recordSubscriptionClosureNoResponse(closure.closureCaseId, {
                    deadlineAt: noResponseDeadline.toISOString(),
                    idempotencyKey: crypto.randomUUID(),
                    settlementHash: currentSettlement.resultHash,
                    settlementRevisionId: currentSettlement.id
                  }),
                "客户未响应事实已记录；该事实不会被视为客户同意。"
              );
            }}
          >
            截止后记录客户未响应
          </Button>
        </Space>
      ) : null}
      <Space style={{ marginTop: 14 }} wrap>
        {canCompleteFinancialSettlement ? (
          <Button
            loading={busy === "settle"}
            onClick={() =>
              void run(
                "settle",
                () => advanceSubscriptionClosureSettlement(closure.closureCaseId, "settle"),
                "财务结算已核验完成。"
              )
            }
            type="primary"
          >
            核验账单已清并完成财务结算
          </Button>
        ) : null}
        {canReleaseInventory ? (
          <Button
            loading={busy === "release"}
            onClick={() =>
              void run(
                "release",
                () => releaseSubscriptionClosureInventory(closure.closureCaseId),
                "车辆库存限制已按当前车况解除。"
              )
            }
          >
            释放车辆库存
          </Button>
        ) : null}
        {canCompleteOperations ? (
          <Button
            loading={busy === "complete"}
            onClick={() =>
              void run(
                "complete",
                () => completeSubscriptionClosureOperations(closure.closureCaseId),
                "订单、合同与车辆运营闭环已完成。"
              )
            }
            type="primary"
          >
            完成订单运营闭环
          </Button>
        ) : null}
        {canExportEvidence ? <Button loading={busy === "export"} onClick={() => void exportPackage()}>
          固化并导出证据包
        </Button> : null}
      </Space>
      {activeEvidenceExport ? (
        <Alert
          description={
            <Space orientation="vertical">
              <Typography.Text code>{activeEvidenceExport.manifestHash}</Typography.Text>
              <Typography.Link
                href={`${API_BASE_URL}/subscription-closures/${closure.closureCaseId}/evidence-packages/${activeEvidenceExport.exportId}/download`}
                rel="noreferrer"
                target="_blank"
              >
                下载证据包 v{activeEvidenceExport.version}
              </Typography.Link>
              {closure.receivableBills.some((bill) => BigInt(bill.remainingAmount) > 0n) &&
              currentUserId && canTransferLegal ? (
                <Space wrap>
                  <Select
                    onChange={setLegalBillId}
                    options={closure.receivableBills
                      .filter((bill) => BigInt(bill.remainingAmount) > 0n)
                      .map((bill) => ({
                        label: `${bill.billNo} · ${bill.remainingAmount} 分`,
                        value: bill.id
                      }))}
                    placeholder="选择移交法催的未清账单"
                    style={{ width: 280 }}
                    value={legalBillId}
                  />
                  <Button
                    danger
                    disabled={!legalBillId}
                    loading={busy === "legal"}
                    onClick={() =>
                      void run(
                        "legal",
                        () =>
                          transferSubscriptionClosureLegalCollection(closure.closureCaseId, {
                            billId: legalBillId,
                            evidencePackageHash: activeEvidenceExport.manifestHash,
                            idempotencyKey: crypto.randomUUID(),
                            openedAt: new Date().toISOString(),
                            ownerId: currentUserId,
                            ownerType: "LEGAL"
                          }),
                        "未清应收已连同锁定证据包移交法催。"
                      )
                    }
                  >
                    移交所选账单至法催
                  </Button>
                </Space>
              ) : null}
            </Space>
          }
          message="证据包已锁定"
          showIcon
          style={{ marginTop: 14 }}
          type="success"
        />
      ) : null}
      {closure.legalCases.some((item) => !item.closedAt) && canRecordLegalEvent ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>法催案件推进与回款核销</Typography.Title>
          <Space wrap>
            <Select
              onChange={setLegalCaseId}
              options={closure.legalCases.filter((item) => !item.closedAt).map((item) => ({
                label: `${item.id.slice(0, 8)} · ${item.closedAt ? "已结案" : "进行中"}`,
                value: item.id
              }))}
              placeholder="选择法催案件"
              style={{ width: 240 }}
              value={legalCaseId}
            />
            <Select
              onChange={setLegalEventType}
              options={[
                { label: "催告已送达", value: "NOTICE_SENT" },
                { label: "已提起诉讼", value: "CLAIM_FILED" },
                { label: "判决已记录", value: "JUDGMENT_RECORDED" },
                { label: "和解已记录", value: "SETTLEMENT_RECORDED" },
                { label: "执行回款并核销", value: "EXECUTION_RECEIVED" },
                { label: "案件结案", value: "CLOSED" }
              ]}
              placeholder="选择事件类型"
              style={{ width: 210 }}
              value={legalEventType}
            />
            <Input
              onChange={(event) => setLegalEventAmount(event.target.value)}
              placeholder="金额（分，可选）"
              style={{ width: 160 }}
              value={legalEventAmount}
            />
            <Input
              onChange={(event) => setLegalEventDetail(event.target.value)}
              placeholder="事件说明/文书编号"
              style={{ width: 260 }}
              value={legalEventDetail}
            />
            <input
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) => setLegalEventProof(event.target.files?.[0] ?? null)}
              type="file"
            />
            <Button
              loading={busy === `legal-event:${legalCaseId}`}
              onClick={recordLegalEvent}
            >
              记录法催事件
            </Button>
          </Space>
          <Table
            columns={[
              { dataIndex: "eventType", title: "事件" },
              { dataIndex: "occurredAt", title: "发生时间" },
              { dataIndex: "amountCents", title: "金额（分）" }
            ]}
            dataSource={closure.legalCases.flatMap((item) => item.events)}
            pagination={false}
            rowKey="id"
            size="small"
            style={{ marginTop: 10 }}
          />
        </div>
      ) : null}
    </Card>
  );
}
