"use client";

import { Alert, App, Button, Card, Descriptions, Input, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../../lib/api";

import {
  advanceSubscriptionClosureSettlement,
  confirmSubscriptionClosureInspection,
  confirmSubscriptionReturnDelta,
  createSubscriptionClosurePricing,
  decideSubscriptionClosureApproval,
  generateSubscriptionReturnDelta,
  requestSubscriptionClosureApproval
} from "../../lib/subscription-closure-api";
import {
  acceptedDisputeDeltaItemIds,
  type AdminSubscriptionClosureView,
  type SubscriptionClosureApprovalView,
  type SubscriptionClosureChargeLineView,
  type SubscriptionClosureDeltaItemView
} from "../../lib/subscription-closure-view-model";
import { ReturnInspectionWorkOrder } from "./return-inspection-work-order";

type Responsibility = "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR";

type RefreshBinding = { closureCaseId: string; settlementRevisionId: string; canRefresh: boolean };
type RefreshPending = {
  closureCaseId: string;
  settlementRevisionId: string;
  command: Readonly<{ idempotencyKey: string; occurredAt: string }>;
  committed: boolean;
  changed: boolean;
  response: { id: string; resultHash: string } | null;
};
type RefreshSnapshot = {
  pending: RefreshPending | null;
  busy: boolean;
  error: string | null;
  readback: "idle" | "ready" | "unknown" | "refresh-required" | "changed";
};
const emptyRefreshSnapshot = (): RefreshSnapshot => ({
  pending: null,
  busy: false,
  error: null,
  readback: "idle"
});

export function createReturnSettlementRefreshController(callbacks: {
  reloadClosure: () => Promise<AdminSubscriptionClosureView>;
  onChanged: (view: AdminSubscriptionClosureView) => Promise<void> | void;
  onState: (snapshot: RefreshSnapshot) => void;
}) {
  let binding: RefreshBinding | null = null;
  let generation = 0;
  let readSequence = 0;
  let disposed = false;
  let snapshot = emptyRefreshSnapshot();
  const current = (token: number) => !disposed && generation === token;
  function publish(patch: Partial<RefreshSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    callbacks.onState(snapshot);
  }
  async function read(token: number) {
    const sequence = ++readSequence;
    const view = await callbacks.reloadClosure();
    if (!current(token) || sequence !== readSequence) return null;
    if (view.closureCaseId !== binding!.closureCaseId) throw new Error("结算读回与当前结案不符。");
    return view;
  }
  async function reconcile(token: number, pending: RefreshPending) {
    const view = await read(token);
    if (!view || !current(token)) return;
    const revision = view.settlementRevisions.at(-1);
    const matchesResponse =
      pending.response &&
      revision?.id === pending.response.id &&
      revision.resultHash === pending.response.resultHash &&
      revision.stage === "PROPOSED";
    const changed =
      pending.changed ||
      (pending.committed ? !matchesResponse : revision?.id !== pending.settlementRevisionId);
    if (changed) {
      pending = { ...pending, changed: true };
      publish({
        pending,
        readback: "changed",
        error: "结算状态已变化，需核对当前草案。请勿重复生成或直接发布。"
      });
    } else if (!pending.committed) {
      publish({
        readback: "unknown",
        error: "更新草案结果尚未确认，可先重新读取，必要时重试原操作。"
      });
    } else {
      publish({ readback: "refresh-required" });
    }
    await callbacks.onChanged(view);
    if (!current(token)) return;
    if (matchesResponse && !changed) publish({ pending: null, readback: "ready", error: null });
  }
  async function execute(pending: RefreshPending, send: boolean) {
    const token = generation;
    publish({ pending, busy: true, error: null });
    try {
      if (send) {
        try {
          const response = await advanceSubscriptionClosureSettlement(
            pending.closureCaseId,
            "propose",
            pending.command
          );
          if (!current(token)) return;
          const valid =
            response &&
            response.closureCaseId === pending.closureCaseId &&
            response.stage === "PROPOSED" &&
            typeof response.id === "string" &&
            response.id.length > 0 &&
            response.id !== pending.settlementRevisionId &&
            typeof response.resultHash === "string" &&
            response.resultHash.length > 0;
          pending = {
            ...pending,
            committed: true,
            response: valid
              ? { id: response.id as string, resultHash: response.resultHash as string }
              : null
          };
          publish({ pending });
        } catch (error) {
          if (!current(token)) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            pending = { ...pending, changed: true };
            publish({ pending });
          }
        }
      }
      await reconcile(token, pending);
    } catch (error) {
      if (current(token))
        publish({
          error: error instanceof Error ? error.message : "结算刷新失败，请重新读取。",
          readback: snapshot.pending?.committed
            ? "refresh-required"
            : snapshot.pending?.changed
              ? "changed"
              : "unknown"
        });
    } finally {
      if (current(token)) publish({ busy: false });
    }
  }
  return {
    bind(context: RefreshBinding) {
      if (disposed || JSON.stringify(binding) === JSON.stringify(context)) return;
      binding = { ...context };
      generation++;
      readSequence++;
      snapshot = emptyRefreshSnapshot();
      callbacks.onState(snapshot);
    },
    async refresh() {
      if (disposed || !binding?.canRefresh || snapshot.busy || snapshot.pending) return;
      return execute(
        {
          closureCaseId: binding.closureCaseId,
          settlementRevisionId: binding.settlementRevisionId,
          command: Object.freeze({
            idempotencyKey: crypto.randomUUID(),
            occurredAt: new Date().toISOString()
          }),
          committed: false,
          changed: false,
          response: null
        },
        true
      );
    },
    async retry() {
      if (disposed || !binding?.canRefresh || snapshot.busy || !snapshot.pending) return;
      return execute(snapshot.pending, !snapshot.pending.committed && !snapshot.pending.changed);
    },
    async reload() {
      if (disposed || !binding?.canRefresh || (snapshot.busy && snapshot.pending)) return;
      if (snapshot.pending) return execute(snapshot.pending, false);
      const token = generation;
      const sequence = readSequence + 1;
      publish({ busy: true, error: null });
      try {
        const view = await read(token);
        if (!view || !current(token)) return;
        await callbacks.onChanged(view);
        if (current(token) && sequence === readSequence) publish({ readback: "ready" });
      } catch (error) {
        if (current(token) && sequence === readSequence)
          publish({ error: error instanceof Error ? error.message : "结算读取失败。" });
      } finally {
        if (current(token) && sequence === readSequence) publish({ busy: false });
      }
    },
    dispose() {
      disposed = true;
      generation++;
      readSequence++;
      snapshot = emptyRefreshSnapshot();
    },
    getSnapshot() {
      return snapshot;
    }
  };
}

export function ReturnSettlementProposalActions({
  mode,
  busy,
  onPropose
}: {
  mode: "initial" | "refresh" | "dispute" | "hidden";
  busy: boolean;
  onPropose: () => void;
}) {
  if (mode === "hidden") return null;
  return (
    <Button
      disabled={busy}
      loading={busy}
      onClick={onPropose}
      style={{ marginTop: 16 }}
      type="primary"
    >
      {mode === "refresh"
        ? "更新结算草案"
        : mode === "dispute"
          ? "生成争议调整后继结算"
          : "生成结算草案"}
    </Button>
  );
}

export function ReturnPricingStage({
  canApproveApproval,
  canRequestApproval,
  canViewAssetWorkOrder,
  canManageAssetWorkOrder,
  closure,
  currentUserId,
  onChanged,
  reloadClosure,
  onClosureReadback
}: {
  canApproveApproval: boolean;
  canRequestApproval: boolean;
  canViewAssetWorkOrder: boolean;
  canManageAssetWorkOrder: boolean;
  closure: AdminSubscriptionClosureView;
  currentUserId: string | null;
  onChanged: () => Promise<void> | void;
  reloadClosure: () => Promise<AdminSubscriptionClosureView>;
  onClosureReadback: (view: AdminSubscriptionClosureView) => Promise<void> | void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [closedInspectionBinding, setClosedInspectionBinding] = useState<string | null>(null);
  const inspectionBinding = `${closure.closureCaseId}:${closure.returnAssetWorkOrderId}`;
  const normalInspection = closure.returnThreeStageEnabled && closure.closureType === "NORMAL_COMPLETION" &&
    closure.physicalControlMode === "VOLUNTARY_RETURN" && closure.status === "RETURN_INSPECTION";
  const inspectionWorkOrderClosed = !normalInspection || (canViewAssetWorkOrder &&
    closedInspectionBinding === inspectionBinding && closure.workOrders.some((workOrder) =>
      workOrder.id === closure.returnAssetWorkOrderId && workOrder.status === "CLOSED"));
  const [responsibilities, setResponsibilities] = useState<Record<string, Responsibility>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [clauseByItem, setClauseByItem] = useState<Record<string, string>>({});
  const [manualBasisByItem, setManualBasisByItem] = useState<Record<string, string>>({});
  const [manualUnitPriceByItem, setManualUnitPriceByItem] = useState<Record<string, string>>({});
  const [approvalCommentByItem, setApprovalCommentByItem] = useState<Record<string, string>>({});
  const [pricingPreview, setPricingPreview] = useState<SubscriptionClosureChargeLineView[]>([]);
  const allowedActionKeys = new Set(closure.allowedActions.map(({ key }) => key));
  const canGenerateConditionDelta =
    closure.capabilities.inspect && allowedActionKeys.has("GENERATE_CONDITION_DELTA");
  const canRecordReturnInspection =
    closure.capabilities.inspect && allowedActionKeys.has("RECORD_RETURN_INSPECTION");
  const canPreviewPricing =
    closure.capabilities.settle && allowedActionKeys.has("PREVIEW_CONTRACT_PRICING");
  const canFinalizePricing =
    closure.capabilities.settle && allowedActionKeys.has("FINALIZE_CONTRACT_PRICING");
  const canProposeSettlement =
    closure.capabilities.settle && allowedActionKeys.has("PROPOSE_SETTLEMENT");
  const currentSettlement = closure.settlementRevisions.at(-1) ?? null;
  const needsPricingProposalRefresh = canProposeSettlement && closure.status === "PENDING_SETTLEMENT" &&
    currentSettlement?.stage === "PROPOSED";
  const refreshBindingKey = JSON.stringify({
    closureCaseId: closure.closureCaseId,
    settlementRevisionId: currentSettlement?.id ?? "",
    canRefresh: needsPricingProposalRefresh
  } satisfies RefreshBinding);
  const refreshController = useRef<ReturnType<typeof createReturnSettlementRefreshController> | null>(null);
  const [refreshState, setRefreshState] = useState({ key: refreshBindingKey, snapshot: emptyRefreshSnapshot() });
  useEffect(() => {
    let lastNotice: string | null = null;
    const instance = createReturnSettlementRefreshController({
      reloadClosure,
      onChanged: onClosureReadback,
      onState: (snapshot) => {
        setRefreshState({ key: refreshBindingKey, snapshot });
        if (snapshot.readback === "changed" && snapshot.error && snapshot.error !== lastNotice) {
          lastNotice = snapshot.error;
          void message.warning(snapshot.error);
        }
      }
    });
    refreshController.current = instance;
    instance.bind(JSON.parse(refreshBindingKey) as RefreshBinding);
    return () => { instance.dispose(); if (refreshController.current === instance) refreshController.current = null; };
  }, [refreshBindingKey, reloadClosure, onClosureReadback, message]);
  const refreshSnapshot = refreshState.key === refreshBindingKey ? refreshState.snapshot : emptyRefreshSnapshot();
  const refreshLocked = refreshSnapshot.busy || Boolean(refreshSnapshot.pending);
  const conflictingBusy = Boolean(busy) || refreshLocked;
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
  const unresolved = closure.delta?.items.filter((item) => item.responsibility === "UNDETERMINED") ?? [];
  const acceptedDisputeLineIds = new Set(
    closure.disputes
      .filter((dispute) => dispute.status === "ACCEPTED_BY_PLATFORM")
      .map((dispute) => dispute.chargeLineId)
  );
  const acceptedDeltaItemIds = acceptedDisputeDeltaItemIds({
    chargeLines: closure.chargeLines,
    currentDeltaItemIds: closure.delta?.items.map(({ id }) => id) ?? [],
    disputes: closure.disputes
  });
  const customerItems =
    closure.delta?.items.filter(
      (item) =>
        item.responsibility === "CUSTOMER" &&
        item.wearClassification !== "UNCHANGED" &&
        !acceptedDeltaItemIds.has(item.id)
    ) ?? [];
  const evidenceByCode = useMemo(() => {
    const itemCodeById = new Map(
      (closure.checklist?.items ?? []).map((item) => [item.id, item.itemCode])
    );
    const result = new Map<string, string[]>();
    for (const link of closure.evidenceLinks) {
      const code = link.checklistItemId ? itemCodeById.get(link.checklistItemId) : null;
      if (!code || !link.evidenceId) continue;
      result.set(code, [...(result.get(code) ?? []), link.evidenceId]);
    }
    return result;
  }, [closure.checklist, closure.evidenceLinks]);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    if (refreshController.current?.getSnapshot().busy || refreshController.current?.getSnapshot().pending) return;
    setBusy(key);
    try {
      await action();
      void message.success(success);
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败，请根据页面提示修正后重试。");
    } finally {
      setBusy(null);
    }
  }

  function confirmResponsibilities() {
    const decisions = unresolved.map((item) => ({
      decisionReason: reasons[item.id]?.trim() ?? "",
      itemId: item.id,
      responsibility: responsibilities[item.id]
    }));
    if (decisions.some((item) => !item.responsibility || !item.decisionReason)) {
      void message.error("每一项待判定差异都必须选择责任方并填写判定依据。");
      return;
    }
    void run(
      "responsibility",
      () =>
        confirmSubscriptionReturnDelta(closure.closureCaseId, {
          baseRevisionId: closure.delta?.id,
          decisions,
          idempotencyKey: crypto.randomUUID()
        }),
      "责任判定已形成不可变后继版本。"
    );
  }

  function pricingApprovalForItem(item: SubscriptionClosureDeltaItemView) {
    const clauseId = clauseByItem[item.id];
    const evidenceIds = [...(evidenceByCode.get(item.itemCode) ?? [])].sort();
    return [...closure.approvals]
      .reverse()
      .find(
        (approval) =>
          approval.type === "SETTLEMENT_PRICING_EXCEPTION" &&
          approval.subjectField === `pricingOverride:${item.id}` &&
          approval.settlementRevisionId === currentSettlement?.id &&
          approval.deltaItemId === item.id &&
          approval.clauseSnapshotId === clauseId &&
          approval.manualBasis === manualBasisByItem[item.id]?.trim() &&
          approval.manualUnitPriceCents === manualUnitPriceByItem[item.id] &&
          sameStrings(approval.evidenceIds, evidenceIds)
      );
  }

  function pricingLines() {
    return customerItems.map((item) => {
      const clause = closure.contractChargeClauses.find(
        (candidate) => candidate.id === clauseByItem[item.id]
      );
      const approval = pricingApprovalForItem(item);
      return {
        chargeType: clause?.chargeType ?? chargeTypeFor(item),
        clauseSnapshotId: clause?.id ?? null,
        deltaItemId: item.id,
        evidenceIds: evidenceByCode.get(item.itemCode) ?? [],
        exceptionApprovalId:
          clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED" &&
          approval?.status === "APPROVED" &&
          approval.decision === "APPROVED"
            ? approval.id
            : null,
        lineCode: `RETURN_${item.itemCode}`,
        manualBasis:
          clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED"
            ? manualBasisByItem[item.id]?.trim() || null
            : null,
        manualUnitPriceCents:
          clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED"
            ? manualUnitPriceByItem[item.id] || null
            : null,
        quantity: quantityFor(item),
        responsibility: item.responsibility
      };
    });
  }

  const finalPricingReady = customerItems.every((item) => {
    const clause = closure.contractChargeClauses.find(
      (candidate) => candidate.id === clauseByItem[item.id]
    );
    const clauseReady =
      clause?.status === "EXECUTABLE" ||
      (clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED" &&
        /^(?:0|[1-9]\d*)$/.test(manualUnitPriceByItem[item.id] ?? "") &&
        Boolean(manualBasisByItem[item.id]?.trim()) &&
        pricingApprovalForItem(item)?.status === "APPROVED" &&
        pricingApprovalForItem(item)?.decision === "APPROVED");
    return clauseReady && (evidenceByCode.get(item.itemCode)?.length ?? 0) > 0;
  });
  const currentFinalLines = closure.chargeLines.filter(
    (line) => line.settlementRevisionId === currentPricingSettlementId && line.status === "FINAL"
  );
  const currentExceptions = closure.chargeLines.filter(
    (line) =>
      line.settlementRevisionId === currentPricingSettlementId && line.status === "PRICING_EXCEPTION"
  );

  async function requestPricingApproval(item: SubscriptionClosureDeltaItemView) {
    const clauseId = clauseByItem[item.id];
    const manualBasis = manualBasisByItem[item.id]?.trim();
    const manualUnitPriceCents = manualUnitPriceByItem[item.id];
    const evidenceIds = evidenceByCode.get(item.itemCode) ?? [];
    if (
      !currentSettlement ||
      !clauseId ||
      !manualBasis ||
      !/^(?:0|[1-9]\d*)$/.test(manualUnitPriceCents ?? "") ||
      evidenceIds.length === 0
    ) {
      void message.error("请先补齐条款、核定单价、定价依据和现场证据。");
      return;
    }
    await run(
      `approval-request:${item.id}`,
      () =>
        requestSubscriptionClosureApproval(closure.closureCaseId, {
          approvalType: "PRICING_OVERRIDE",
          clauseSnapshotId: clauseId,
          deltaItemId: item.id,
          evidenceIds,
          idempotencyKey: crypto.randomUUID(),
          manualBasis,
          manualUnitPriceCents,
          requestReason: `人工定价申请：${manualBasis}`,
          settlementRevisionId: currentSettlement.id
        }),
      "人工定价审批已发起，需由另一名有审批权限的管理员决定。"
    );
  }

  async function decidePricingApproval(
    item: SubscriptionClosureDeltaItemView,
    approval: SubscriptionClosureApprovalView,
    decision: "APPROVED" | "REJECTED"
  ) {
    const comment = approvalCommentByItem[item.id]?.trim();
    if (!comment) {
      void message.error("请填写审批意见。");
      return;
    }
    await run(
      `approval-decision:${item.id}`,
      () =>
        decideSubscriptionClosureApproval(closure.closureCaseId, approval.id, {
          decision,
          decisionComment: comment,
          expectedVersion: approval.version,
          idempotencyKey: crypto.randomUUID()
        }),
      decision === "APPROVED" ? "人工定价审批已通过。" : "人工定价审批已驳回。"
    );
  }

  async function previewPricing() {
    if (!currentSettlement || refreshController.current?.getSnapshot().busy || refreshController.current?.getSnapshot().pending) return;
    setBusy("preview");
    try {
      const value = await createSubscriptionClosurePricing(closure.closureCaseId, {
        finalize: false,
        idempotencyKey: crypto.randomUUID(),
        lines: pricingLines(),
        settlementRevisionId: currentSettlement.id
      });
      setPricingPreview(value as unknown as SubscriptionClosureChargeLineView[]);
      void message.success("合同计费预览已生成；预览不会写入账单或异常事实。");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "无法生成合同计费预览。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="节点 2 · 交付/退回差异与合同计费">
      {normalInspection && closure.capabilities.inspect && <ReturnInspectionWorkOrder
        closure={closure}
        canView={canViewAssetWorkOrder}
        canManage={canManageAssetWorkOrder}
        reloadClosure={reloadClosure}
        onChanged={onClosureReadback}
        onClosedReadback={(closed) => setClosedInspectionBinding(closed ? inspectionBinding : null)}
      />}
      {normalInspection && !inspectionWorkOrderClosed && <Alert
        type="info"
        title="先提交并验收关闭关联检查工单，再生成差异、确认责任并完成车况检查。"
        style={{ marginTop: 12 }}
      />}
      <Alert
        message="差异只从已归档交车文件与当前受管退车清单计算；客户收费必须同时绑定合同条款、差异项和现场证据。"
        showIcon
        style={{ marginBottom: 16 }}
        type="info"
      />
      {!closure.delta ? (
        <Button
          disabled={!canGenerateConditionDelta || conflictingBusy}
          loading={busy === "delta"}
          onClick={() =>
            void run(
              "delta",
              () =>
                generateSubscriptionReturnDelta(closure.closureCaseId, {
                  idempotencyKey: crypto.randomUUID()
                }),
              "交付/退回差异已生成。"
            )
          }
          type="primary"
        >
          生成受管车况差异
        </Button>
      ) : (
        <>
          <Descriptions
            bordered
            column={2}
            items={[
              { label: "差异版本", children: `R${closure.delta.revisionNumber}` },
              { label: "结果哈希", children: <Typography.Text code>{closure.delta.resultHash}</Typography.Text> }
            ]}
            size="small"
          />
          <Table
            columns={[
              { dataIndex: "itemCode", title: "项目" },
              { dataIndex: "wearClassification", title: "差异类型" },
              { dataIndex: "quantityDifference", title: "数量差" },
              {
                dataIndex: "responsibility",
                render: (value: string) => <Tag color={value === "UNDETERMINED" ? "orange" : "blue"}>{value}</Tag>,
                title: "责任"
              },
              { dataIndex: "decisionReason", title: "依据" }
            ]}
            dataSource={closure.delta.items}
            pagination={false}
            rowKey="id"
            size="small"
            style={{ marginTop: 12 }}
          />
        </>
      )}

      {unresolved.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>人工责任判定</Typography.Title>
          {unresolved.map((item) => (
            <Space key={item.id} style={{ display: "flex", marginBottom: 10 }} wrap>
              <Typography.Text style={{ width: 160 }}>{item.itemCode}</Typography.Text>
              <Select
                onChange={(value: Responsibility) =>
                  setResponsibilities((current) => ({ ...current, [item.id]: value }))
                }
                options={[
                  { label: "客户责任", value: "CUSTOMER" },
                  { label: "平台责任", value: "PLATFORM" },
                  { label: "第三方责任", value: "THIRD_PARTY" },
                  { label: "正常损耗", value: "NORMAL_WEAR" }
                ]}
                placeholder="选择责任方"
                style={{ width: 160 }}
                value={responsibilities[item.id]}
              />
              <Input
                onChange={(event) =>
                  setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                }
                placeholder="填写证据比对及判定依据"
                style={{ width: 380 }}
                value={reasons[item.id]}
              />
            </Space>
          ))}
          <Button
            disabled={!canRecordReturnInspection || conflictingBusy}
            loading={busy === "responsibility"}
            onClick={confirmResponsibilities}
            type="primary"
          >
            确认全部责任判定
          </Button>
        </div>
      ) : null}

      {closure.delta && unresolved.length === 0 && closure.status === "RETURN_INSPECTION" ? (
        <Button
          disabled={!canRecordReturnInspection || !inspectionWorkOrderClosed || conflictingBusy}
          loading={busy === "inspection"}
          onClick={() =>
            void run(
              "inspection",
              () => confirmSubscriptionClosureInspection(closure.closureCaseId, false),
              "车况检查已确认，进入结算准备。"
            )
          }
          style={{ marginTop: 16 }}
          type="primary"
        >
          确认车况检查完成
        </Button>
      ) : null}

      {needsPricingProposalRefresh && <Alert
        title="正式收费已生成账单，请更新草案后重新绑定收费清单"
        type="info"
        style={{ marginTop: 16 }}
      />}
      {refreshSnapshot.error && <Alert title={refreshSnapshot.error} type="warning" style={{ marginTop: 12 }} />}
      <ReturnSettlementProposalActions
        mode={!canProposeSettlement || closure.status !== "PENDING_SETTLEMENT" ? "hidden" :
          needsPricingProposalRefresh ? "refresh" : !currentSettlement ? "initial" :
            currentSettlement.stage === "FINALIZED" && acceptedDisputeLineIds.size > 0 ? "dispute" : "hidden"}
        busy={conflictingBusy}
        onPropose={() => {
          if (needsPricingProposalRefresh) {
            if (!busy) void refreshController.current?.refresh();
          } else {
            void run(
              "propose",
              () => advanceSubscriptionClosureSettlement(closure.closureCaseId, "propose"),
              currentSettlement ? "争议调整后的后继结算草案已生成。" : "结算草案已生成。"
            );
          }
        }}
      />
      {refreshSnapshot.pending && <Space style={{ marginLeft: 8 }}>
        <Button disabled={Boolean(busy) || refreshSnapshot.busy} onClick={() => void refreshController.current?.reload()}>重新读取结算</Button>
        {!refreshSnapshot.pending.changed && <Button disabled={Boolean(busy) || refreshSnapshot.busy} onClick={() => void refreshController.current?.retry()}>
          {refreshSnapshot.pending.committed ? "重试刷新" : "重试原更新"}
        </Button>}
      </Space>}

      {currentSettlement?.stage === "PROPOSED" ? (
        <div style={{ marginTop: 18 }}>
          <Typography.Title level={5}>合同收费匹配</Typography.Title>
          {customerItems.length === 0 ? (
            <Alert message="当前差异没有客户责任收费项，可生成零收费正式清单。" showIcon type="success" />
          ) : (
            customerItems.map((item) => (
              <Space key={item.id} style={{ display: "flex", marginBottom: 10 }} wrap>
                <Typography.Text style={{ width: 160 }}>{item.itemCode}</Typography.Text>
                <Typography.Text>数量 {quantityFor(item)}</Typography.Text>
                <Select
                  onChange={(value: string) =>
                    setClauseByItem((current) => ({ ...current, [item.id]: value }))
                  }
                  options={closure.contractChargeClauses
                    .filter((clause) => clause.chargeType === chargeTypeFor(item))
                    .map((clause) => ({
                      label: `${clause.clauseCode} · ${clause.status}`,
                      value: clause.id
                    }))}
                  placeholder="选择合同收费条款"
                  style={{ width: 320 }}
                  value={clauseByItem[item.id]}
                />
                {closure.contractChargeClauses.find(
                  (clause) => clause.id === clauseByItem[item.id]
                )?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED" ? (
                  <>
                    <Input
                      inputMode="numeric"
                      onChange={(event) =>
                        setManualUnitPriceByItem((current) => ({
                          ...current,
                          [item.id]: event.target.value.replace(/\D/g, "")
                        }))
                      }
                      placeholder="人工核定单价（分）"
                      style={{ width: 180 }}
                      value={manualUnitPriceByItem[item.id]}
                    />
                    <Input
                      onChange={(event) =>
                        setManualBasisByItem((current) => ({
                          ...current,
                          [item.id]: event.target.value
                        }))
                      }
                      placeholder="填写合同条款、维修报价或审批依据"
                      style={{ width: 360 }}
                      value={manualBasisByItem[item.id]}
                    />
                    {(() => {
                      const approval = pricingApprovalForItem(item);
                      if (!approval) {
                        return canRequestApproval ? (
                          <Button
                            loading={busy === `approval-request:${item.id}`}
                            disabled={conflictingBusy}
                            onClick={() => void requestPricingApproval(item)}
                          >
                            发起人工定价审批
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
                              <Typography.Text type="secondary">
                                申请人与审批人必须为不同管理员
                              </Typography.Text>
                            ) : canApproveApproval ? (
                              <>
                                <Input
                                  onChange={(event) =>
                                    setApprovalCommentByItem((current) => ({
                                      ...current,
                                      [item.id]: event.target.value
                                    }))
                                  }
                                  placeholder="填写审批意见"
                                  style={{ width: 260 }}
                                  value={approvalCommentByItem[item.id]}
                                />
                                <Button
                                  loading={busy === `approval-decision:${item.id}`}
                                  disabled={conflictingBusy}
                                  onClick={() =>
                                    void decidePricingApproval(item, approval, "APPROVED")
                                  }
                                  type="primary"
                                >
                                  批准定价
                                </Button>
                                <Button
                                  danger
                                  loading={busy === `approval-decision:${item.id}`}
                                  disabled={conflictingBusy}
                                  onClick={() =>
                                    void decidePricingApproval(item, approval, "REJECTED")
                                  }
                                >
                                  驳回定价
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
                      return (
                        <Space wrap>
                          <Tag color={approval.status === "APPROVED" ? "green" : "red"}>
                            {approval.status === "APPROVED" ? "人工定价已批准" : "人工定价已驳回"}
                          </Tag>
                          {approval.status !== "APPROVED" && canRequestApproval ? (
                            <Button
                              loading={busy === `approval-request:${item.id}`}
                              disabled={conflictingBusy}
                              onClick={() => void requestPricingApproval(item)}
                            >
                              重新发起审批
                            </Button>
                          ) : null}
                        </Space>
                      );
                    })()}
                  </>
                ) : null}
                <Tag color={(evidenceByCode.get(item.itemCode)?.length ?? 0) > 0 ? "green" : "red"}>
                  证据 {(evidenceByCode.get(item.itemCode)?.length ?? 0) > 0 ? "已绑定" : "缺失"}
                </Tag>
              </Space>
            ))
          )}
          {!finalPricingReady ? (
            <Alert
              message="正式计费前，每个客户责任项都必须匹配合同条款并绑定受管证据；人工审查条款还需完成独立例外审批。"
              showIcon
              style={{ marginBottom: 12 }}
              type="warning"
            />
          ) : null}
          <Space wrap>
            {canPreviewPricing ? <Button
              loading={busy === "preview"}
              disabled={conflictingBusy}
              onClick={() => void previewPricing()}
            >
              预览合同计费
            </Button> : null}
            {canFinalizePricing ? <Button
              disabled={!finalPricingReady || conflictingBusy || needsPricingProposalRefresh}
              loading={busy === "pricing"}
              onClick={() =>
                void run(
                  "pricing",
                  () =>
                    createSubscriptionClosurePricing(closure.closureCaseId, {
                      finalize: true,
                      idempotencyKey: crypto.randomUUID(),
                      lines: pricingLines(),
                      settlementRevisionId: currentSettlement.id
                    }),
                  "正式收费清单与账单已生成。"
                )
              }
              type="primary"
            >
              按合同生成正式收费清单
            </Button> : null}
          </Space>
          {pricingPreview.length > 0 ? (
            <Table
              columns={[
                { dataIndex: "lineCode", title: "预览收费项" },
                { dataIndex: "unitPriceCents", title: "单价（分）" },
                { dataIndex: "quantity", title: "数量" },
                { dataIndex: "amountCents", title: "金额（分）" },
                { dataIndex: "status", title: "预览结果" }
              ]}
              dataSource={pricingPreview}
              pagination={false}
              rowKey="id"
              size="small"
              style={{ marginTop: 12 }}
            />
          ) : null}
          {currentExceptions.length > 0 ? (
            <Alert message="存在合同条款定价异常，需先补齐可执行合同条款，禁止正式结算。" showIcon style={{ marginTop: 12 }} type="error" />
          ) : null}
          {canFinalizePricing &&
          (currentFinalLines.length > 0 || (customerItems.length === 0 && finalPricingReady)) ? (
            <Button
              loading={busy === "finalize"}
              disabled={needsPricingProposalRefresh || conflictingBusy}
              onClick={() =>
                void run(
                  "finalize",
                  () => advanceSubscriptionClosureSettlement(closure.closureCaseId, "finalize"),
                  "最终结算方案已发布，等待客户确认或逐项争议。"
                )
              }
              style={{ marginTop: 12 }}
              type="primary"
            >
              发布最终结算方案
            </Button>
          ) : null}
        </div>
      ) : null}

      {currentSettlement?.stage === "FINALIZED" ? (
        <Alert
          message={
            closure.customerResponse
              ? `客户反馈：${closure.customerResponse.status}`
              : "最终方案已发布，等待客户在 Portal 确认或逐项提出争议。"
          }
          showIcon
          style={{ marginTop: 16 }}
          type={closure.customerResponse ? "success" : "warning"}
        />
      ) : null}
    </Card>
  );
}

function chargeTypeFor(item: SubscriptionClosureDeltaItemView) {
  if (item.itemCode === "MILEAGE") return "OVER_MILEAGE";
  if (item.wearClassification === "MISSING") return `MISSING_${item.itemCode}`;
  return `DAMAGE_${item.itemCode}`;
}

function quantityFor(item: SubscriptionClosureDeltaItemView) {
  if (item.itemCode === "MILEAGE") return Math.max(0, item.quantityDifference);
  if (item.wearClassification === "MISSING") {
    return Math.max(1, Math.abs(item.quantityDifference));
  }
  return 1;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
