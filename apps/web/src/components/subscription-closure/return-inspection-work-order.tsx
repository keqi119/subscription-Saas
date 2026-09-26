"use client";

import { Alert, Button, Input, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../../lib/api";
import {
  loadAdminSubscriptionClosureByOrder,
  loadReturnInspectionWorkOrder,
  transitionReturnInspectionWorkOrder,
  type ReturnInspectionCommand
} from "../../lib/subscription-closure-api";
import type { AdminSubscriptionClosureView } from "../../lib/subscription-closure-view-model";

type Binding = {
  closureCaseId: string;
  workOrderId: string | null;
  eligible: boolean;
  canView: boolean;
  canManage: boolean;
};
type Detail = {
  id: string;
  workOrderType: string;
  status: string;
  version: number;
  costConfirmationRequired: boolean;
};
type Pending = {
  closureCaseId: string;
  workOrderId: string;
  command: ReturnInspectionCommand;
  committed: boolean;
};
type Snapshot = {
  detail: Detail | null;
  pending: Pending | null;
  busy: boolean;
  error: string | null;
  readback: "idle" | "loading" | "ready" | "unknown" | "refresh-required" | "blocked";
};
type Input = Pick<
  ReturnInspectionCommand,
  "occurredAt" | "solution" | "closeReason" | "targetStatus"
>;
type Callbacks = {
  reloadClosure: () => Promise<AdminSubscriptionClosureView>;
  onChanged: (view: AdminSubscriptionClosureView) => Promise<void> | void;
  onState: (snapshot: Snapshot) => void;
};
const emptySnapshot = (): Snapshot => ({
  detail: null,
  pending: null,
  busy: false,
  error: null,
  readback: "idle"
});

export function createReturnClosureReadback({
  orderId,
  closureCaseId,
  permissions,
  isCurrent,
  publish
}: {
  orderId: string;
  closureCaseId: string;
  permissions: ReadonlySet<string>;
  isCurrent: () => boolean;
  publish: (view: AdminSubscriptionClosureView) => void;
}) {
  const readViews = new WeakSet<AdminSubscriptionClosureView>();
  function assertCurrent() {
    if (!isCurrent()) throw new Error("订单工作区已切换，请在当前页面重新读取。");
  }
  return {
    async reloadClosure() {
      assertCurrent();
      const view = await loadAdminSubscriptionClosureByOrder(orderId, permissions);
      assertCurrent();
      if (!view || view.closureCaseId !== closureCaseId)
        throw new Error("未读到当前结案，请重新加载订单。");
      readViews.add(view);
      return view;
    },
    onClosureReadback(view: AdminSubscriptionClosureView) {
      assertCurrent();
      if (!readViews.has(view) || view.closureCaseId !== closureCaseId)
        throw new Error("结案读回与当前页面不符。");
      publish(view);
    }
  };
}

export function returnInspectionBinding(
  closure: AdminSubscriptionClosureView,
  canView: boolean,
  canManage: boolean
): Binding {
  const workOrderId = closure.returnAssetWorkOrderId;
  return {
    closureCaseId: closure.closureCaseId,
    workOrderId,
    canView,
    canManage,
    eligible:
      closure.returnThreeStageEnabled &&
      closure.closureType === "NORMAL_COMPLETION" &&
      closure.physicalControlMode === "VOLUNTARY_RETURN" &&
      closure.status === "RETURN_INSPECTION" &&
      closure.capabilities.inspect &&
      Boolean(
        workOrderId &&
        closure.workOrders.some(
          (workOrder) => workOrder.id === workOrderId && workOrder.type === "RETURN_INBOUND"
        )
      )
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function readDetail(value: unknown, workOrderId: string): Detail {
  const row = record(record(value).workOrder);
  if (
    row.id !== workOrderId ||
    row.workOrderType !== "RETURN_INBOUND" ||
    typeof row.version !== "number" ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    row.costConfirmationRequired !== false ||
    typeof row.status !== "string"
  ) {
    throw new Error("检查工单详情不完整或与本案不符，请核对关联工单。");
  }
  return row as Detail;
}
function nextStatus(detail: Detail | null) {
  if (
    !detail ||
    detail.workOrderType !== "RETURN_INBOUND" ||
    detail.costConfirmationRequired !== false ||
    !Number.isSafeInteger(detail.version) ||
    detail.version < 0
  )
    return null;
  return detail.status === "IN_PROGRESS"
    ? "PENDING_ACCEPTANCE"
    : detail.status === "PENDING_ACCEPTANCE"
      ? "CLOSED"
      : null;
}

export function createReturnInspectionController(callbacks: Callbacks) {
  let binding: Binding | null = null;
  let generation = 0;
  let readSequence = 0;
  let disposed = false;
  let snapshot = emptySnapshot();
  const current = (token: number) => !disposed && generation === token;
  const readable = () => binding?.eligible && binding.canView && binding.workOrderId;
  function publish(patch: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...patch };
    callbacks.onState(snapshot);
  }
  async function read(token: number) {
    const workOrderId = binding!.workOrderId!;
    const sequence = ++readSequence;
    const result = await loadReturnInspectionWorkOrder(workOrderId);
    if (!current(token) || sequence !== readSequence) return null;
    const detail = readDetail(result, workOrderId);
    publish({ detail });
    return { detail, events: record(result).events };
  }
  async function reconcile(token: number, pending: Pending) {
    const result = await read(token);
    if (!result || !current(token)) return;
    const eventFound =
      Array.isArray(result.events) &&
      result.events.some((value) => {
        const event = record(value);
        return (
          event.workOrderId === pending.workOrderId &&
          event.afterStatus === pending.command.targetStatus &&
          event.sourceType === pending.command.source.type &&
          event.sourceId === pending.command.source.id &&
          event.sourceKey === pending.command.source.key
        );
      });
    if (!pending.committed && !eventFound) {
      publish({
        readback: "unknown",
        error: "提交结果尚未确认。请核对当前工单，必要时重试原操作。"
      });
      return;
    }
    pending = { ...pending, committed: true };
    publish({ pending, readback: "refresh-required" });
    const view = await callbacks.reloadClosure();
    if (!current(token)) return;
    if (
      view.closureCaseId !== pending.closureCaseId ||
      view.returnAssetWorkOrderId !== pending.workOrderId
    ) {
      throw new Error("读回的结案或工单已变化，请重新进入当前订单。");
    }
    await callbacks.onChanged(view);
    if (!current(token)) return;
    publish({ pending: null, readback: "ready", error: null });
  }
  async function execute(pending: Pending, send: boolean) {
    const token = generation;
    publish({
      busy: true,
      error: null,
      pending,
      readback: pending.committed ? "refresh-required" : "loading"
    });
    try {
      if (send) {
        try {
          await transitionReturnInspectionWorkOrder(pending.workOrderId, pending.command);
          if (!current(token)) return;
          pending = { ...pending, committed: true };
          publish({ pending });
        } catch (error) {
          if (!current(token)) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            await read(token);
            if (current(token))
              publish({
                pending: null,
                readback: "ready",
                error: `${error.message}；已重新读取工单，请重新核对并决定下一操作。`
              });
            return;
          }
        }
      }
      await reconcile(token, pending);
    } catch (error) {
      if (current(token))
        publish({
          error: error instanceof Error ? error.message : "读回失败，请刷新核对。",
          readback: snapshot.pending?.committed ? "refresh-required" : "unknown"
        });
    } finally {
      if (current(token)) publish({ busy: false });
    }
  }
  return {
    bind(context: Binding) {
      if (disposed || JSON.stringify(binding) === JSON.stringify(context)) return;
      binding = { ...context };
      generation++;
      readSequence++;
      snapshot = emptySnapshot();
      callbacks.onState(snapshot);
    },
    async reload() {
      if (disposed || !readable() || (snapshot.busy && snapshot.pending)) return;
      if (snapshot.pending) return execute(snapshot.pending, false);
      const token = generation;
      const sequence = readSequence + 1;
      publish({ busy: true, detail: null, readback: "loading", error: null });
      try {
        if (await read(token)) publish({ readback: "ready" });
      } catch (error) {
        if (current(token) && sequence === readSequence)
          publish({
            detail: null,
            readback: "blocked",
            error: error instanceof Error ? error.message : "工单读取失败。"
          });
      } finally {
        if (current(token) && sequence === readSequence) publish({ busy: false });
      }
    },
    async submit(input: Input) {
      if (
        disposed ||
        !readable() ||
        !binding!.canManage ||
        snapshot.busy ||
        snapshot.pending ||
        snapshot.readback !== "ready" ||
        nextStatus(snapshot.detail) !== input.targetStatus
      )
        return;
      if (
        !input.solution?.trim() ||
        input.solution.length > 4000 ||
        (input.closeReason?.length ?? 0) > 1000 ||
        (input.targetStatus === "CLOSED" && !input.closeReason?.trim()) ||
        !Number.isFinite(Date.parse(input.occurredAt)) ||
        Date.parse(input.occurredAt) > Date.now()
      ) {
        publish({ error: "请填写实际发生时间、检查/验收说明及关闭原因（关闭时必填）。" });
        return;
      }
      const operationId = crypto.randomUUID();
      const command = Object.freeze({
        ...input,
        expectedVersion: snapshot.detail!.version,
        source: Object.freeze({
          type: "MANUAL_OPERATION" as const,
          id: operationId,
          key: `return-inspection:${operationId}`
        }),
        detailSnapshot: Object.freeze({ closureCaseId: binding!.closureCaseId })
      });
      return execute(
        {
          closureCaseId: binding!.closureCaseId,
          workOrderId: binding!.workOrderId!,
          command,
          committed: false
        },
        true
      );
    },
    async retry() {
      if (disposed || !readable() || !binding!.canManage || snapshot.busy || !snapshot.pending)
        return;
      return execute(snapshot.pending, !snapshot.pending.committed);
    },
    dispose() {
      disposed = true;
      generation++;
      readSequence++;
      snapshot = emptySnapshot();
    },
    getSnapshot() {
      return snapshot;
    }
  };
}

export function ReturnInspectionWorkOrderActions({
  detail,
  busy,
  canManage,
  onSubmit
}: {
  detail: Detail | null;
  busy: boolean;
  canManage: boolean;
  onSubmit: (target: "PENDING_ACCEPTANCE" | "CLOSED") => void;
}) {
  if (detail?.status === "CLOSED")
    return (
      <Typography.Text type="success">
        检查工单已关闭；仍需完成车况差异及结案检查确认。
      </Typography.Text>
    );
  const target = nextStatus(detail);
  if (!target || !canManage) return null;
  return (
    <Button disabled={busy} onClick={() => onSubmit(target)}>
      {target === "CLOSED" ? "验收并关闭工单" : "提交检查验收"}
    </Button>
  );
}

export function ReturnInspectionWorkOrder({
  closure,
  canView,
  canManage,
  reloadClosure,
  onChanged,
  onClosedReadback
}: {
  closure: AdminSubscriptionClosureView;
  canView: boolean;
  canManage: boolean;
  reloadClosure: Callbacks["reloadClosure"];
  onChanged: Callbacks["onChanged"];
  onClosedReadback: (closed: boolean) => void;
}) {
  const binding = returnInspectionBinding(closure, canView, canManage);
  const key = JSON.stringify(binding);
  const callbacks = useRef({ reloadClosure, onChanged, onClosedReadback });
  callbacks.current = { reloadClosure, onChanged, onClosedReadback };
  const controller = useRef<ReturnType<typeof createReturnInspectionController> | null>(null);
  const [state, setState] = useState({ key, snapshot: emptySnapshot() });
  const [occurredAt, setOccurredAt] = useState("");
  const [solution, setSolution] = useState("");
  const [closeReason, setCloseReason] = useState("");
  useEffect(() => {
    // Each setup owns its controller; StrictMode cleanup cannot dispose the next setup's instance.
    const boundCallbacks = callbacks.current;
    const instance = createReturnInspectionController({
      reloadClosure: () => boundCallbacks.reloadClosure(),
      onChanged: (view) => boundCallbacks.onChanged(view),
      onState: (snapshot) => {
        setState({ key, snapshot });
        boundCallbacks.onClosedReadback(
          snapshot.readback === "ready" && snapshot.detail?.status === "CLOSED"
        );
      }
    });
    controller.current = instance;
    instance.bind(JSON.parse(key) as Binding);
    setOccurredAt("");
    setSolution("");
    setCloseReason("");
    void instance.reload();
    return () => {
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, [key, reloadClosure, onChanged]);
  const snapshot = state.key === key ? state.snapshot : emptySnapshot();
  if (!binding.eligible)
    return <Alert type="warning" title="缺少本案正常退车检查工单关联，无法办理检查验收。" />;
  if (!canView) return <Alert type="warning" title="需要资产运营查看权限才能读取检查工单。" />;
  const locked = snapshot.busy || Boolean(snapshot.pending);
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Text>
        关联检查工单：{binding.workOrderId}。提交检查与验收关闭为两个独立人工动作。
      </Typography.Text>
      {snapshot.error && <Alert type="warning" title={snapshot.error} />}
      {!canManage && (
        <Typography.Text type="secondary">当前角色仅可查看工单，无法提交或关闭。</Typography.Text>
      )}
      {canManage && nextStatus(snapshot.detail) && (
        <>
          <Input
            aria-label="检查实际发生时间"
            type="datetime-local"
            value={occurredAt}
            disabled={locked}
            onChange={(event) => setOccurredAt(event.target.value)}
          />
          <Input.TextArea
            aria-label="检查或验收说明"
            placeholder="填写真实检查/验收说明"
            maxLength={4000}
            value={solution}
            disabled={locked}
            onChange={(event) => setSolution(event.target.value)}
          />
          {snapshot.detail?.status === "PENDING_ACCEPTANCE" && (
            <Input.TextArea
              aria-label="关闭原因"
              placeholder="填写真实关闭原因"
              maxLength={1000}
              value={closeReason}
              disabled={locked}
              onChange={(event) => setCloseReason(event.target.value)}
            />
          )}
        </>
      )}
      <Space>
        <ReturnInspectionWorkOrderActions
          detail={snapshot.detail}
          busy={locked}
          canManage={canManage}
          onSubmit={(targetStatus) => {
            const time = new Date(occurredAt);
            void controller.current?.submit({
              targetStatus,
              occurredAt: Number.isFinite(time.getTime()) ? time.toISOString() : "",
              solution,
              closeReason: targetStatus === "CLOSED" ? closeReason : null
            });
          }}
        />
        <Button disabled={snapshot.busy} onClick={() => void controller.current?.reload()}>
          重新读取工单
        </Button>
        {snapshot.pending && (
          <Button
            disabled={snapshot.busy || !canManage}
            onClick={() => void controller.current?.retry()}
          >
            {snapshot.pending.committed ? "重试刷新" : "重试原操作"}
          </Button>
        )}
      </Space>
    </Space>
  );
}
