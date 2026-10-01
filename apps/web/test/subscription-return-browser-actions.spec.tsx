import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ApiError, apiFetch } from "../src/lib/api";
import * as api from "../src/lib/subscription-closure-api";
import * as inspection from "../src/components/subscription-closure/return-inspection-work-order";
import * as pricing from "../src/components/subscription-closure/return-pricing-stage";
import * as financial from "../src/components/subscription-closure/return-settlement-stage";

vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  apiFetch: vi.fn()
}));

const permissions = new Set(["subscription_closure:inspect"]);
const workOrderId = "10000000-0000-4000-8000-000000000001";
const closureCaseId = "20000000-0000-4000-8000-000000000002";
const context = { closureCaseId, workOrderId, eligible: true, canView: true, canManage: true };
const input = {
  occurredAt: "2026-09-26T08:00:00.000Z",
  solution: "已检查车辆及附件",
  closeReason: null,
  targetStatus: "PENDING_ACCEPTANCE" as const
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function detail(status = "IN_PROGRESS", version = 4, extra = {}) {
  return {
    workOrder: {
      id: workOrderId,
      workOrderType: "RETURN_INBOUND",
      status,
      version,
      costConfirmationRequired: false,
      ...extra
    },
    events: []
  };
}
function aggregate(id = closureCaseId) {
  return {
    closureCase: {
      id,
      caseNo: "SC-1",
      closureType: "NORMAL_COMPLETION",
      status: "RETURN_INSPECTION",
      physicalControlMode: "VOLUNTARY_RETURN",
      returnAssetWorkOrderId: workOrderId
    },
    returnThreeStageEnabled: true,
    workOrders: [{ id: workOrderId, workOrderType: "RETURN_INBOUND", status: "IN_PROGRESS" }]
  };
}
async function moduleUnderTest() {
  return inspection;
}
async function setup(options: { onChanged?: (view: unknown) => Promise<void> | void } = {}) {
  const { createReturnInspectionController } = await moduleUnderTest();
  const published: unknown[] = [];
  const controller = createReturnInspectionController({
    reloadClosure: async () => {
      const view = await api.loadAdminSubscriptionClosureByOrder("order-1", permissions);
      if (!view || view.closureCaseId !== closureCaseId) throw new Error("closure mismatch");
      return view;
    },
    onChanged:
      options.onChanged ??
      ((view) => {
        published.push(view);
      }),
    onState: () => undefined
  });
  controller.bind(context);
  vi.mocked(apiFetch).mockResolvedValueOnce(detail());
  await controller.reload();
  vi.mocked(apiFetch).mockClear();
  return { controller, published };
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe("return inspection browser transport", () => {
  it("publishes only a strict actual closure read while its exact page binding remains current", async () => {
    const componentModule = await moduleUnderTest();
    expect(componentModule).toHaveProperty("createReturnClosureReadback");
    let current = true;
    const published: unknown[] = [];
    const boundary = componentModule.createReturnClosureReadback({
      orderId: "order-1",
      closureCaseId,
      permissions,
      isCurrent: () => current,
      publish: (view) => {
        published.push(view);
      }
    });
    const pending = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const reading = boundary.reloadClosure();
    current = false;
    pending.resolve(aggregate());
    await expect(reading).rejects.toThrow();
    expect(published).toHaveLength(0);
    current = true;
    vi.mocked(apiFetch).mockResolvedValueOnce(aggregate("other-case"));
    await expect(boundary.reloadClosure()).rejects.toThrow();
    vi.mocked(apiFetch).mockResolvedValueOnce(aggregate());
    const view = await boundary.reloadClosure();
    current = false;
    expect(() => boundary.onClosureReadback(view)).toThrow();
    current = true;
    expect(() => boundary.onClosureReadback({ ...view })).toThrow();
    boundary.onClosureReadback(view);
    expect(published).toEqual([view]);
  });

  it.each([
    { closureCase: { returnAssetWorkOrderId: null } },
    { closureCase: { closureType: "RECOVERY" } },
    { closureCase: { physicalControlMode: "RECOVERY" } },
    { closureCase: { status: "PENDING_SETTLEMENT" } },
    { returnThreeStageEnabled: false },
    { workOrders: [] },
    { workOrders: [{ id: workOrderId, workOrderType: "RECOVERY", status: "IN_PROGRESS" }] }
  ])("does not mount a valid binding for an out-of-scope aggregate %j", async (change) => {
    const { returnInspectionBinding } = await moduleUnderTest();
    const value = aggregate();
    const altered = {
      ...value,
      ...change,
      closureCase: { ...value.closureCase, ...change.closureCase }
    };
    const { buildAdminSubscriptionClosureView } =
      await import("../src/lib/subscription-closure-view-model");
    expect(
      returnInspectionBinding(buildAdminSubscriptionClosureView(altered, permissions), true, true)
        .eligible
    ).toBe(false);
    expect(
      returnInspectionBinding(buildAdminSubscriptionClosureView(value, permissions), true, true)
        .eligible
    ).toBe(true);
  });

  it("uses the existing guarded endpoints and an exact manual-operation command", async () => {
    expect(api).toHaveProperty("loadReturnInspectionWorkOrder");
    expect(api).toHaveProperty("transitionReturnInspectionWorkOrder");
    const command = {
      ...input,
      expectedVersion: 4,
      source: {
        type: "MANUAL_OPERATION" as const,
        id: "operation-1",
        key: "return-inspection:operation-1"
      },
      detailSnapshot: { closureCaseId }
    };
    await api.loadReturnInspectionWorkOrder(workOrderId);
    await api.transitionReturnInspectionWorkOrder(workOrderId, command);
    expect(vi.mocked(apiFetch).mock.calls).toEqual([
      [`/asset-operations/work-orders/${workOrderId}`],
      [
        `/asset-operations/work-orders/${workOrderId}/transition`,
        {
          method: "POST",
          headers: { "Idempotency-Key": command.source.key },
          body: JSON.stringify(command)
        }
      ]
    ]);
  });

  it("latches double clicks before awaiting and reads both work order and closure before publishing", async () => {
    const { controller, published } = await setup();
    const post = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
      .mockResolvedValueOnce(aggregate());
    const first = controller.submit(input);
    await controller.submit(input);
    expect(posts()).toHaveLength(1);
    expect(controller.getSnapshot().busy).toBe(true);
    const command = JSON.parse(posts()[0][1]!.body as string);
    expect(command).toMatchObject({
      ...input,
      expectedVersion: 4,
      detailSnapshot: { closureCaseId },
      source: { type: "MANUAL_OPERATION" }
    });
    expect(command.source.key).toBe(`return-inspection:${command.source.id}`);
    expect(Object.keys(command).sort()).toEqual([
      "closeReason",
      "detailSnapshot",
      "expectedVersion",
      "occurredAt",
      "solution",
      "source",
      "targetStatus"
    ]);
    expect(Object.isFrozen(controller.getSnapshot().pending!.command)).toBe(true);
    expect(published).toHaveLength(0);
    post.resolve({});
    await first;
    expect(published).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      pending: null,
      readback: "ready",
      detail: { status: "PENDING_ACCEPTANCE", version: 5 }
    });
  });

  it("keeps a lost-response command byte-identical and cannot start another action during readback", async () => {
    const { controller } = await setup();
    const read = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("timeout", 0))
      .mockReturnValueOnce(read.promise);
    const first = controller.submit(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().busy).toBe(true);
    await controller.submit({ ...input, targetStatus: "CLOSED", closeReason: "验收完成" });
    read.resolve(detail("PENDING_ACCEPTANCE", 5));
    await first;
    expect(controller.getSnapshot().readback).toBe("unknown");
    const original = posts()[0];
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
      .mockResolvedValueOnce(aggregate());
    await controller.retry();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toEqual(original);
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("recognizes an exact source event after timeout without issuing a second POST", async () => {
    const { controller, published } = await setup();
    vi.mocked(apiFetch)
      .mockImplementationOnce(async () => {
        throw new ApiError("timeout", 0);
      })
      .mockImplementationOnce(async () => {
        const command = JSON.parse(posts()[0][1]!.body as string);
        return {
          ...detail("PENDING_ACCEPTANCE", 5),
          events: [
            {
              workOrderId,
              afterStatus: command.targetStatus,
              sourceType: command.source.type,
              sourceId: command.source.id,
              sourceKey: command.source.key
            }
          ]
        };
      })
      .mockResolvedValueOnce(aggregate());
    await controller.submit(input);
    await controller.retry();
    expect(posts()).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it.each(["detail", "closure", "publish"])(
    "retries only reads after a known commit and %s failure",
    async (failure) => {
      let failPublish = failure === "publish";
      const { controller } = await setup({
        onChanged: async () => {
          if (failPublish) throw new Error("publish failed");
        }
      });
      vi.mocked(apiFetch).mockResolvedValueOnce({});
      if (failure === "detail")
        vi.mocked(apiFetch).mockRejectedValueOnce(new Error("detail failed"));
      else {
        vi.mocked(apiFetch).mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5));
        if (failure === "closure")
          vi.mocked(apiFetch).mockRejectedValueOnce(new Error("closure failed"));
        else vi.mocked(apiFetch).mockResolvedValueOnce(aggregate());
      }
      await controller.submit(input);
      expect(controller.getSnapshot().readback).toBe("refresh-required");
      failPublish = false;
      vi.mocked(apiFetch)
        .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
        .mockResolvedValueOnce(aggregate());
      await controller.retry();
      expect(posts()).toHaveLength(1);
      expect(controller.getSnapshot().pending).toBeNull();
    }
  );

  it("accepts only the latest GET within the same binding", async () => {
    const { controller } = await setup();
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const a = controller.reload();
    const b = controller.reload();
    current.resolve(detail("PENDING_ACCEPTANCE", 6));
    await b;
    old.resolve(detail("IN_PROGRESS", 4));
    await a;
    expect(controller.getSnapshot().detail?.version).toBe(6);
  });

  it("preserves pending across an ordinary same-binding render", async () => {
    const { controller } = await setup();
    const post = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(post.promise);
    const request = controller.submit(input);
    const pending = controller.getSnapshot().pending;
    controller.bind({ ...context });
    expect(controller.getSnapshot().pending).toBe(pending);
    expect(controller.getSnapshot().busy).toBe(true);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
      .mockResolvedValueOnce(aggregate());
    post.resolve({});
    await request;
  });

  it.each(["case", "workOrder", "permission", "dispose"])(
    "ignores an old GET after %s changes",
    async (change) => {
      const { controller } = await setup();
      const old = deferred<unknown>();
      vi.mocked(apiFetch).mockReturnValueOnce(old.promise);
      const request = controller.reload();
      if (change === "dispose") controller.dispose();
      else
        controller.bind({
          ...context,
          ...(change === "case"
            ? { closureCaseId: "case-2" }
            : change === "workOrder"
              ? { workOrderId: "work-2" }
              : { canView: false })
        });
      old.resolve(detail("CLOSED", 99));
      await request;
      expect(controller.getSnapshot().detail).toBeNull();
      expect(controller.getSnapshot().readback).toBe("idle");
    }
  );

  it("blocks changed version retry until a fresh human command is chosen", async () => {
    const { controller } = await setup();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("版本冲突", 409, "ASSET_WORK_ORDER_VERSION_CONFLICT"))
      .mockResolvedValueOnce(detail("IN_PROGRESS", 7));
    await controller.submit(input);
    await controller.retry();
    expect(posts()).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ pending: null, detail: { version: 7 } });
    expect(controller.getSnapshot().error).toContain("重新核对");
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 8))
      .mockResolvedValueOnce(aggregate());
    await controller.submit({ ...input, solution: "重新核对后完成检查" });
    const first = JSON.parse(posts()[0][1]!.body as string);
    const second = JSON.parse(posts()[1][1]!.body as string);
    expect(second.expectedVersion).toBe(7);
    expect(second.source.key).not.toBe(first.source.key);
  });

  it("does not publish an old closure read after switching the target", async () => {
    const { controller, published } = await setup();
    const closure = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
      .mockReturnValueOnce(closure.promise);
    const request = controller.submit(input);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    controller.bind({ ...context, closureCaseId: "case-2" });
    closure.resolve(aggregate());
    await request;
    expect(published).toHaveLength(0);
    expect(controller.getSnapshot().detail).toBeNull();
  });

  it.each(["sourceId", "sourceKey", "sourceType", "workOrderId", "afterStatus"])(
    "does not accept a timeout readback event with mismatching %s",
    async (field) => {
      const { controller, published } = await setup();
      vi.mocked(apiFetch)
        .mockRejectedValueOnce(new ApiError("timeout", 0))
        .mockImplementationOnce(async () => {
          const command = JSON.parse(posts()[0][1]!.body as string);
          return {
            ...detail("PENDING_ACCEPTANCE", 5),
            events: [
              {
                workOrderId,
                afterStatus: command.targetStatus,
                sourceType: command.source.type,
                sourceId: command.source.id,
                sourceKey: command.source.key,
                [field]: "other"
              }
            ]
          };
        });
      await controller.submit(input);
      expect(controller.getSnapshot().readback).toBe("unknown");
      expect(published).toHaveLength(0);
    }
  );

  it.each([
    { solution: "" },
    { solution: "x".repeat(4001) },
    { closeReason: "x".repeat(1001) },
    { occurredAt: "invalid" },
    { occurredAt: "2999-01-01T00:00:00.000Z" },
    { targetStatus: "CLOSED" }
  ])("does not send an invalid human command %j", async (change) => {
    const { controller } = await setup();
    await controller.submit({ ...input, ...change } as typeof input);
    expect(posts()).toHaveLength(0);
  });

  it.each(["case", "workOrder", "permission", "dispose"])(
    "invalidates pending requests after %s changes",
    async (change) => {
      const { controller, published } = await setup();
      const post = deferred<unknown>();
      vi.mocked(apiFetch).mockReturnValueOnce(post.promise);
      const request = controller.submit(input);
      if (change === "dispose") controller.dispose();
      else
        controller.bind({
          ...context,
          ...(change === "case"
            ? { closureCaseId: "case-2" }
            : change === "workOrder"
              ? { workOrderId: "work-2" }
              : { canManage: false })
        });
      post.resolve({});
      await request;
      await controller.retry();
      expect(posts()).toHaveLength(1);
      expect(published).toHaveLength(0);
      expect(controller.getSnapshot().pending).toBeNull();
    }
  );

  it("does not let an old finally unlock a new target request, including A to B to A", async () => {
    const { controller } = await setup();
    const old = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise);
    const a = controller.submit(input);
    controller.bind({ ...context, closureCaseId: "case-2" });
    controller.bind(context);
    vi.mocked(apiFetch).mockResolvedValueOnce(detail());
    await controller.reload();
    const current = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(current.promise);
    const b = controller.submit(input);
    old.resolve({});
    await a;
    expect(controller.getSnapshot().busy).toBe(true);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(detail("PENDING_ACCEPTANCE", 5))
      .mockResolvedValueOnce(aggregate());
    current.resolve({});
    await b;
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it.each([
    { canView: false, canManage: true },
    { canView: false, canManage: false },
    { eligible: false }
  ])("does not GET or POST for an unreadable/invalid binding %j", async (restriction) => {
    const { controller } = await setup();
    controller.bind({ ...context, ...restriction });
    await controller.reload();
    await controller.submit(input);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("allows view-only GET but never submits a command", async () => {
    const { controller } = await setup();
    controller.bind({ ...context, canManage: false });
    vi.mocked(apiFetch).mockResolvedValueOnce(detail());
    await controller.reload();
    await controller.submit(input);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    { id: "other" },
    { workOrderType: "RECOVERY" },
    { version: 1.5 },
    { version: undefined },
    { costConfirmationRequired: true },
    { costConfirmationRequired: undefined },
    { status: "PENDING" }
  ])("rejects an unsafe detail %j before a write", async (bad) => {
    const { controller } = await setup();
    vi.mocked(apiFetch).mockResolvedValueOnce(detail("IN_PROGRESS", 4, bad));
    await controller.reload();
    await controller.submit(input);
    expect(posts()).toHaveLength(0);
  });

  it("renders the actual stateless actions for only the two allowed statuses", async () => {
    const { ReturnInspectionWorkOrderActions } = await moduleUnderTest();
    for (const [status, label] of [
      ["IN_PROGRESS", "提交检查验收"],
      ["PENDING_ACCEPTANCE", "验收并关闭工单"],
      ["CLOSED", "检查工单已关闭"]
    ]) {
      const html = renderToStaticMarkup(
        createElement(ReturnInspectionWorkOrderActions, {
          detail: detail(status).workOrder,
          busy: false,
          canManage: true,
          onSubmit: () => undefined
        })
      );
      expect(html).toContain(label);
    }
    const html = renderToStaticMarkup(
      createElement(ReturnInspectionWorkOrderActions, {
        detail: detail().workOrder,
        busy: true,
        canManage: true,
        onSubmit: () => undefined
      })
    );
    expect(html).toContain("disabled");
  });
});
function refreshAggregate(revisionId = "proposal-1", hash = `hash-${revisionId}`) {
  const value = aggregate();
  return {
    ...value,
    closureCase: { ...value.closureCase, status: "PENDING_SETTLEMENT" },
    allowedActions: ["PROPOSE_SETTLEMENT"],
    settlementRevisions: [
      {
        id: revisionId,
        stage: "PROPOSED",
        resultHash: hash,
        revisionNumber: 1,
        amountDueCents: "200",
        amountRefundableCents: "0"
      }
    ]
  };
}
const refreshBinding = { closureCaseId, settlementRevisionId: "proposal-1", canRefresh: true };
function proposal(id = "proposal-2") {
  return { id, closureCaseId, stage: "PROPOSED", resultHash: `hash-${id}` };
}
function setupRefresh(options: { onChanged?: () => Promise<void> } = {}) {
  expect(pricing).toHaveProperty("createReturnSettlementRefreshController");
  const published: unknown[] = [];
  const boundary = inspection.createReturnClosureReadback({
    orderId: "order-1",
    closureCaseId,
    permissions: new Set(["subscription_closure:settle"]),
    isCurrent: () => true,
    publish: (view) => {
      published.push(view);
    }
  });
  const controller = pricing.createReturnSettlementRefreshController({
    reloadClosure: boundary.reloadClosure,
    onChanged: async (view) => {
      await options.onChanged?.();
      boundary.onClosureReadback(view);
    },
    onState: () => undefined
  });
  controller.bind(refreshBinding);
  return { controller, published };
}

describe("return pricing proposal refresh", () => {
  it("wires the actual pricing container to the server action and blocks publication until refresh", async () => {
    const { buildAdminSubscriptionClosureView } =
      await import("../src/lib/subscription-closure-view-model");
    const render = (actions: string[], canSettle = true) => {
      const value = refreshAggregate();
      const closure = buildAdminSubscriptionClosureView(
        { ...value, allowedActions: actions },
        new Set(canSettle ? ["subscription_closure:settle"] : [])
      );
      return renderToStaticMarkup(
        createElement(pricing.ReturnPricingStage, {
          canApproveApproval: false,
          canRequestApproval: false,
          canViewAssetWorkOrder: false,
          canManageAssetWorkOrder: false,
          closure,
          currentUserId: null,
          onChanged: () => undefined,
          reloadClosure: async () => closure,
          onClosureReadback: () => undefined
        })
      );
    };
    const refreshing = render(["PROPOSE_SETTLEMENT", "FINALIZE_CONTRACT_PRICING"]);
    expect(refreshing).toContain("更新结算草案");
    expect(refreshing).toContain("正式收费已生成账单，请更新草案后重新绑定收费清单");
    expect(refreshing).toMatch(/<button[^>]*disabled[^>]*><span>发布最终结算方案/);
    const captured = render(["FINALIZE_CONTRACT_PRICING"]);
    expect(captured).not.toContain("更新结算草案");
    expect(captured).not.toMatch(/<button[^>]*disabled[^>]*><span>发布最终结算方案/);
    expect(render(["PROPOSE_SETTLEMENT"], false)).not.toContain("更新结算草案");
  });

  it.each([
    {},
    { ...proposal(), closureCaseId: "other-case" },
    { ...proposal(), stage: "FINALIZED" }
  ])(
    "does not trust a malformed proposal response %j or resend the committed request",
    async (response) => {
      const { controller } = setupRefresh();
      vi.mocked(apiFetch)
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(refreshAggregate("proposal-2"));
      await controller.refresh();
      expect(controller.getSnapshot().readback).toBe("changed");
      vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-2"));
      await controller.retry();
      expect(posts()).toHaveLength(1);
    }
  );

  it("keeps an ordinary same-binding rerender from dropping an in-flight refresh", async () => {
    const { controller } = setupRefresh();
    const post = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(post.promise);
    const request = controller.refresh();
    const pending = controller.getSnapshot().pending;
    controller.bind({ ...refreshBinding });
    expect(controller.getSnapshot().pending).toBe(pending);
    expect(controller.getSnapshot().busy).toBe(true);
    vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-2"));
    post.resolve(proposal());
    await request;
  });

  it("keeps optional explicit command bytes while preserving legacy callers", async () => {
    const command = { idempotencyKey: "operation-1", occurredAt: "2026-09-26T08:00:00.000Z" };
    await api.advanceSubscriptionClosureSettlement(closureCaseId, "propose", command);
    await api.advanceSubscriptionClosureSettlement(closureCaseId, "propose", command);
    expect(posts()[0]).toEqual(posts()[1]);
    expect(JSON.parse(posts()[0][1]!.body as string)).toEqual(command);
    await api.advanceSubscriptionClosureSettlement(closureCaseId, "finalize");
    expect(JSON.parse(posts()[2][1]!.body as string)).toMatchObject({
      idempotencyKey: expect.any(String),
      occurredAt: expect.any(String)
    });
  });

  it("runs the actual refresh action once for double clicks and publishes the matching readback", async () => {
    const { controller, published } = setupRefresh();
    const post = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(refreshAggregate("proposal-2"));
    const request = controller.refresh();
    await controller.refresh();
    expect(posts()).toHaveLength(1);
    expect(controller.getSnapshot().busy).toBe(true);
    expect(Object.isFrozen(controller.getSnapshot().pending!.command)).toBe(true);
    post.resolve(proposal());
    await request;
    expect(published).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      pending: null,
      busy: false,
      readback: "ready"
    });
  });

  it("keeps unknown same-revision retries byte-identical", async () => {
    const { controller } = setupRefresh();
    const read = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("timeout", 0))
      .mockReturnValueOnce(read.promise);
    const request = controller.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().busy).toBe(true);
    await controller.refresh();
    read.resolve(refreshAggregate());
    await request;
    expect(controller.getSnapshot().readback).toBe("unknown");
    const original = posts()[0];
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(proposal())
      .mockResolvedValueOnce(refreshAggregate("proposal-2"));
    await controller.retry();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toEqual(original);
  });

  it("does not infer success or resend after timeout when another revision appears", async () => {
    const { controller, published } = setupRefresh();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("timeout", 0))
      .mockResolvedValueOnce(refreshAggregate("proposal-other"));
    await controller.refresh();
    expect(published).toHaveLength(1);
    expect(controller.getSnapshot().readback).toBe("changed");
    vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-other"));
    await controller.retry();
    expect(posts()).toHaveLength(1);
    expect(controller.getSnapshot().readback).toBe("changed");
  });

  it.each(["closure", "publish"])(
    "only retries reads after commit and %s failure",
    async (failure) => {
      let failed = failure === "publish";
      const { controller } = setupRefresh({
        onChanged: async () => {
          if (failed) throw new Error("publish failed");
        }
      });
      vi.mocked(apiFetch).mockResolvedValueOnce(proposal());
      if (failure === "closure")
        vi.mocked(apiFetch).mockRejectedValueOnce(new Error("read failed"));
      else vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-2"));
      await controller.refresh();
      expect(controller.getSnapshot().readback).toBe("refresh-required");
      failed = false;
      vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-2"));
      await controller.retry();
      expect(posts()).toHaveLength(1);
      expect(controller.getSnapshot().pending).toBeNull();
    }
  );

  it.each(["revision", "hash"])(
    "publishes facts but refuses a mismatched response %s",
    async (mismatch) => {
      const { controller, published } = setupRefresh();
      vi.mocked(apiFetch)
        .mockResolvedValueOnce(proposal())
        .mockResolvedValueOnce(
          refreshAggregate(mismatch === "revision" ? "proposal-other" : "proposal-2", "hash-other")
        );
      await controller.refresh();
      expect(published).toHaveLength(1);
      expect(controller.getSnapshot().readback).toBe("changed");
      expect(posts()).toHaveLength(1);
    }
  );

  it.each(["case", "revision", "permission", "dispose"])(
    "invalidates an old propose after %s changes",
    async (change) => {
      const { controller, published } = setupRefresh();
      const post = deferred<unknown>();
      vi.mocked(apiFetch).mockReturnValueOnce(post.promise);
      const request = controller.refresh();
      if (change === "dispose") controller.dispose();
      else
        controller.bind({
          ...refreshBinding,
          ...(change === "case"
            ? { closureCaseId: "case-2" }
            : change === "revision"
              ? { settlementRevisionId: "proposal-2" }
              : { canRefresh: false })
        });
      post.resolve(proposal());
      await request;
      await controller.retry();
      expect(posts()).toHaveLength(1);
      expect(published).toHaveLength(0);
      expect(controller.getSnapshot().pending).toBeNull();
    }
  );

  it("never publishes a stale closure GET after a revision switch", async () => {
    const { controller, published } = setupRefresh();
    const read = deferred<unknown>();
    vi.mocked(apiFetch).mockResolvedValueOnce(proposal()).mockReturnValueOnce(read.promise);
    const request = controller.refresh();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    controller.bind({ ...refreshBinding, settlementRevisionId: "proposal-3" });
    read.resolve(refreshAggregate("proposal-2"));
    await request;
    expect(published).toHaveLength(0);
    expect(controller.getSnapshot().readback).toBe("idle");
  });

  it("accepts only the latest GET within one binding", async () => {
    const { controller, published } = setupRefresh();
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const a = controller.reload();
    const b = controller.reload();
    current.resolve(refreshAggregate("proposal-3"));
    await b;
    old.resolve(refreshAggregate("proposal-1"));
    await a;
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ settlementRevisions: [{ id: "proposal-3" }] });
  });

  it("an old finally cannot unlock a new A-to-B-to-A request", async () => {
    const { controller } = setupRefresh();
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise);
    const a = controller.refresh();
    controller.bind({ ...refreshBinding, closureCaseId: "case-2" });
    controller.bind(refreshBinding);
    vi.mocked(apiFetch).mockReturnValueOnce(current.promise);
    const b = controller.refresh();
    old.resolve(proposal());
    await a;
    expect(controller.getSnapshot().busy).toBe(true);
    vi.mocked(apiFetch).mockResolvedValueOnce(refreshAggregate("proposal-2"));
    current.resolve(proposal());
    await b;
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it("denies refresh without the current action capability", async () => {
    const { controller } = setupRefresh();
    controller.bind({ ...refreshBinding, canRefresh: false });
    await controller.refresh();
    await controller.retry();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders only the four planned proposal action modes", () => {
    expect(pricing).toHaveProperty("ReturnSettlementProposalActions");
    for (const [mode, label] of [
      ["initial", "生成结算草案"],
      ["refresh", "更新结算草案"],
      ["dispute", "生成争议调整后继结算"]
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(pricing.ReturnSettlementProposalActions, {
          mode,
          busy: true,
          onPropose: () => undefined
        })
      );
      expect(html).toContain(label);
      expect(html).toContain("disabled");
    }
    expect(
      renderToStaticMarkup(
        createElement(pricing.ReturnSettlementProposalActions, {
          mode: "hidden",
          busy: false,
          onPropose: () => undefined
        })
      )
    ).toBe("");
  });
});

const financialBinding = {
  closureCaseId,
  currentUserId: "financial-operator",
  settlementRevisionId: "final-1",
  settlementResultHash: "final-hash",
  canRequest: true,
  canApprove: true,
  canSettle: true,
  bills: [{ id: "bill-1", remainingAmount: "100" }]
};
function financialAggregate(status = "PENDING", revisionId = "final-1") {
  return {
    ...aggregate(),
    closureCase: { ...aggregate().closureCase, status: "PENDING_SETTLEMENT" },
    allowedActions: ["RECORD_RECEIVABLE_DISPOSITION"],
    settlementRevisions: [
      {
        id: revisionId,
        stage: "FINALIZED",
        resultHash: "final-hash",
        revisionNumber: 2,
        amountDueCents: "100",
        amountRefundableCents: "0"
      }
    ],
    receivableBills: [
      {
        id: "bill-1",
        remainingAmount: "100",
        amount: "100",
        paidAmount: "0",
        billNo: "B-1",
        billType: "DAMAGE",
        billStatus: "PENDING"
      }
    ],
    approvals: [
      {
        id: "approval-1",
        status,
        version: status === "PENDING" ? 0 : 1,
        requestedBy: "other-requester",
        exceptionType: "SETTLEMENT_WAIVER",
        subjectField: "settlementWaiver:bill-1",
        subjectSnapshot: { billId: "bill-1", amountCents: "100", settlementRevisionId: "final-1" }
      }
    ]
  };
}
const financialRequest = () => ({
  billId: "bill-1",
  approvalType: "WAIVER" as const,
  reason: "核销依据",
  proof: new File(["proof"], "proof.png", { type: "image/png" })
});
const financialDecision = {
  billId: "bill-1",
  approvalType: "WAIVER" as const,
  approval: { id: "approval-1", version: 0, status: "PENDING", requestedBy: "other-requester" },
  decision: "APPROVED" as const,
  comment: "独立核验"
};
function setupFinancial(
  options: { beforePublish?: () => Promise<void>; isCurrent?: () => boolean } = {}
) {
  expect(financial).toHaveProperty("createReturnFinancialApprovalController");
  const published: unknown[] = [];
  let current = true;
  const boundary = inspection.createReturnClosureReadback({
    orderId: "order-1",
    closureCaseId,
    permissions: new Set(["subscription_closure:settle"]),
    isCurrent: () => current,
    publish: (view) => published.push(view)
  });
  const controller = financial.createReturnFinancialApprovalController({
    isCurrent: options.isCurrent,
    reloadClosure: boundary.reloadClosure,
    onClosureReadback: async (view) => {
      await options.beforePublish?.();
      boundary.onClosureReadback(view);
    },
    onState: () => undefined
  });
  controller.bind(financialBinding);
  return {
    controller,
    published,
    boundary,
    invalidatePage: () => {
      current = false;
    }
  };
}
const financialUploads = () =>
  posts().filter(([path]) => path.endsWith("/financial-proofs/upload"));
const financialCommands = () =>
  posts().filter(([path]) => !path.endsWith("/financial-proofs/upload"));

describe("financial approval retry controller", () => {
  it.each(["PROPOSED", "no-action", "no-permission"])(
    "keeps the actual binding closed for %s",
    async (guard) => {
      const { buildAdminSubscriptionClosureView } =
        await import("../src/lib/subscription-closure-view-model");
      const aggregate = financialAggregate();
      if (guard === "PROPOSED") aggregate.settlementRevisions[0]!.stage = guard;
      if (guard === "no-action") aggregate.allowedActions = [];
      const closure = buildAdminSubscriptionClosureView(
        aggregate,
        new Set(guard === "no-permission" ? [] : ["subscription_closure:settle"])
      );
      const { controller } = setupFinancial();
      controller.bind(
        financial.returnFinancialApprovalBinding(
          closure,
          financialBinding.currentUserId,
          true,
          true
        )
      );
      await controller.startRequest(financialRequest());
      await controller.startDecision(financialDecision);
      expect(apiFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["FINALIZED", "request"],
    ["FINALIZED", "decision"],
    ["SETTLED", "request"],
    ["SETTLED", "decision"]
  ] as const)(
    "retains the actual %s component binding for an outstanding bill %s",
    async (stage, operation) => {
      const { buildAdminSubscriptionClosureView } =
        await import("../src/lib/subscription-closure-view-model");
      const aggregate = financialAggregate();
      aggregate.settlementRevisions[0]!.stage = stage;
      const closure = buildAdminSubscriptionClosureView(
        aggregate,
        new Set(["subscription_closure:settle"])
      );
      expect(financial).toHaveProperty("returnFinancialApprovalBinding");
      const binding = financial.returnFinancialApprovalBinding(
        closure,
        financialBinding.currentUserId,
        true,
        true
      );
      const { controller } = setupFinancial();
      controller.bind(binding);
      if (operation === "request") vi.mocked(apiFetch).mockResolvedValueOnce({ fileId: "proof-1" });
      vi.mocked(apiFetch)
        .mockResolvedValueOnce({ id: "approval-1" })
        .mockResolvedValueOnce(aggregate);
      await (operation === "request"
        ? controller.startRequest(financialRequest())
        : controller.startDecision(financialDecision));
      expect(financialCommands()).toHaveLength(1);
      expect(controller.getSnapshot()).toMatchObject({ status: "ready", pending: null });
    }
  );

  it("does not submit an upload that resolves after render binding invalidation before effect cleanup", async () => {
    let active = true;
    const { controller } = setupFinancial({ isCurrent: () => active });
    const upload = deferred<{ fileId: string }>();
    vi.mocked(apiFetch).mockReturnValueOnce(upload.promise);
    const starting = controller.startRequest(financialRequest());
    active = false;
    upload.resolve({ fileId: "old-proof" });
    await starting;
    expect(financialCommands()).toHaveLength(0);
  });

  it("keeps a successful malformed ACK committed and never resends while recovering", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(financialAggregate("APPROVED"));
    await controller.startDecision(financialDecision);
    expect(controller.getSnapshot()).toMatchObject({
      status: "refresh-required",
      pending: { committed: true }
    });
    vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate("APPROVED"));
    await controller.retry();
    expect(financialCommands()).toHaveLength(1);
  });

  it("freezes a decision version and prevents a second decision while the first response is pending", async () => {
    const { controller } = setupFinancial();
    const post = deferred<unknown>();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(post.promise)
      .mockResolvedValueOnce(financialAggregate("APPROVED"));
    const decision = { ...financialDecision, approval: { ...financialDecision.approval } };
    const first = controller.startDecision(decision);
    decision.approval.version = 8;
    decision.comment = "later edit";
    await controller.startDecision(decision);
    expect(financialCommands()).toHaveLength(1);
    expect(JSON.parse(String(financialCommands()[0]![1]!.body))).toMatchObject({
      expectedVersion: 0,
      decisionComment: "独立核验"
    });
    post.resolve({ id: "approval-1" });
    await first;
  });

  it("does not publish an old decision response after a binding switch", async () => {
    const { controller, published } = setupFinancial();
    const post = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(post.promise);
    const first = controller.startDecision(financialDecision);
    controller.bind({ ...financialBinding, currentUserId: "other-user" });
    post.resolve({ id: "approval-1" });
    await first;
    expect(published).toHaveLength(0);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ pending: null, busy: false });
  });

  it("stops retrying an unknown command when current settlement authority has changed", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("response lost", 0))
      .mockResolvedValueOnce(financialAggregate("PENDING", "final-2"));
    await controller.startDecision(financialDecision);
    expect(controller.getSnapshot().status).toBe("blocked");
    vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate("PENDING", "final-2"));
    await controller.retry();
    expect(financialCommands()).toHaveLength(1);
  });

  it("ignores a late older GET after the current GET already published", async () => {
    const { controller, published } = setupFinancial();
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = controller.reload();
    const second = controller.reload();
    next.resolve(financialAggregate("APPROVED"));
    await second;
    old.resolve(financialAggregate("PENDING"));
    await first;
    expect(published).toEqual([
      expect.objectContaining({ approvals: [expect.objectContaining({ status: "APPROVED" })] })
    ]);
  });

  it("renders upload-unknown recovery without offering a repeat upload command", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("upload unknown"));
    await controller.startRequest(financialRequest());
    expect(financial).toHaveProperty("ReturnFinancialApprovalRecovery");
    const html = renderToStaticMarkup(
      createElement(financial.ReturnFinancialApprovalRecovery, {
        snapshot: controller.getSnapshot(),
        onRetry: () => undefined,
        onReload: () => undefined,
        onNewIntent: () => undefined
      })
    );
    expect(html).toContain("上传结果未确定");
    expect(html).toContain("读取后开始新操作");
    expect(html).not.toContain("重试原审批命令");
  });

  it("freezes the upload and original command before a second click can enter", async () => {
    const { controller } = setupFinancial();
    const upload = deferred<{ fileId: string }>();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(upload.promise)
      .mockResolvedValueOnce({ id: "approval-1", status: "PENDING" })
      .mockResolvedValueOnce(financialAggregate());
    const original = financialRequest();
    const first = controller.startRequest(original);
    original.reason = "edited after starting";
    await controller.startRequest(financialRequest());
    expect(financialUploads()).toHaveLength(1);
    expect(financialCommands()).toHaveLength(0);
    upload.resolve({ fileId: "proof-1" });
    await first;
    const body = JSON.parse(String(financialCommands()[0]![1]!.body));
    expect(body).toEqual({
      approvalType: "WAIVER",
      billId: "bill-1",
      evidenceIds: ["proof-1"],
      idempotencyKey: expect.any(String),
      requestReason: "核销依据",
      settlementRevisionId: "final-1"
    });
    expect(controller.getSnapshot()).toMatchObject({ pending: null, busy: false, status: "ready" });
  });

  it("keeps an unknown upload separate and never retries upload or approval implicitly", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError("upload response lost", 0));
    await controller.startRequest(financialRequest());
    expect(controller.getSnapshot()).toMatchObject({ status: "upload-unknown", busy: false });
    vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate());
    await controller.retry();
    expect(financialUploads()).toHaveLength(1);
    expect(financialCommands()).toHaveLength(0);
    expect(controller.getSnapshot().pending).not.toBeNull();
    vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate());
    await controller.beginNewIntent();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ fileId: "proof-2" })
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce(financialAggregate());
    await controller.startRequest(financialRequest());
    expect(financialUploads()).toHaveLength(2);
    expect(financialCommands()).toHaveLength(1);
  });

  it.each(["request", "decision"] as const)(
    "retries the identical %s body after a lost response",
    async (kind) => {
      const { controller } = setupFinancial();
      if (kind === "request") vi.mocked(apiFetch).mockResolvedValueOnce({ fileId: "proof-1" });
      vi.mocked(apiFetch)
        .mockRejectedValueOnce(new ApiError("response lost", 0))
        .mockResolvedValueOnce(financialAggregate());
      await (kind === "request"
        ? controller.startRequest(financialRequest())
        : controller.startDecision(financialDecision));
      expect(controller.getSnapshot()).toMatchObject({ status: "unknown", busy: false });
      const original = financialCommands()[0];
      vi.mocked(apiFetch)
        .mockResolvedValueOnce({ id: "approval-1", status: "PENDING" })
        .mockResolvedValueOnce(financialAggregate("APPROVED"));
      await controller.retry();
      expect(financialCommands()).toEqual([original, original]);
      expect(financialUploads()).toHaveLength(kind === "request" ? 1 : 0);
      expect(controller.getSnapshot().pending).toBeNull();
    }
  );

  it.each(["read", "publish"] as const)(
    "retains a committed command after %s fails and retries only GET",
    async (failure) => {
      let fail = failure === "publish";
      const { controller } = setupFinancial({
        beforePublish: async () => {
          if (fail) throw new Error("publish failed");
        }
      });
      vi.mocked(apiFetch).mockResolvedValueOnce({ id: "approval-1" });
      if (failure === "read") vi.mocked(apiFetch).mockRejectedValueOnce(new Error("read failed"));
      else vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate("APPROVED"));
      await controller.startDecision(financialDecision);
      expect(controller.getSnapshot()).toMatchObject({
        status: "refresh-required",
        pending: { committed: true }
      });
      fail = false;
      vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate("APPROVED"));
      await controller.retry();
      expect(financialCommands()).toHaveLength(1);
      expect(controller.getSnapshot()).toMatchObject({ status: "ready", pending: null });
    }
  );

  it("does not treat a historical PENDING ACK as current approval authority", async () => {
    const { controller, published } = setupFinancial();
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ fileId: "proof-1" })
      .mockResolvedValueOnce({ id: "approval-1", status: "PENDING" })
      .mockResolvedValueOnce(financialAggregate("EXPIRED"));
    await controller.startRequest(financialRequest());
    expect(published).toEqual([
      expect.objectContaining({ approvals: [expect.objectContaining({ status: "EXPIRED" })] })
    ]);
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it.each([
    { closureCaseId: "other-case" },
    { currentUserId: "other-user" },
    { settlementRevisionId: "final-2" },
    { settlementResultHash: "changed-hash" },
    { canRequest: false },
    { canSettle: false },
    { bills: [{ id: "bill-1", remainingAmount: "99" }] }
  ])("discards old upload results when its binding changes: %j", async (change) => {
    const { controller } = setupFinancial();
    const upload = deferred<{ fileId: string }>();
    vi.mocked(apiFetch).mockReturnValueOnce(upload.promise);
    const first = controller.startRequest(financialRequest());
    controller.bind({ ...financialBinding, ...change });
    controller.bind(financialBinding);
    upload.resolve({ fileId: "old-proof" });
    await first;
    expect(financialCommands()).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ pending: null, busy: false });
  });

  it("does not let an invalidated upload finally clear a new operation busy state", async () => {
    const { controller } = setupFinancial();
    const old = deferred<{ fileId: string }>();
    const next = deferred<{ fileId: string }>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = controller.startRequest(financialRequest());
    controller.bind({ ...financialBinding, currentUserId: "other-user" });
    const second = controller.startRequest(financialRequest());
    old.resolve({ fileId: "old-proof" });
    await first;
    expect(controller.getSnapshot().busy).toBe(true);
    expect(financialCommands()).toHaveLength(0);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce(financialAggregate());
    next.resolve({ fileId: "new-proof" });
    await second;
    expect(financialCommands()).toHaveLength(1);
  });

  it("stops writes after permission loss or a definitive HTTP rejection", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError("forbidden", 403))
      .mockResolvedValueOnce(financialAggregate());
    await controller.startDecision(financialDecision);
    expect(controller.getSnapshot().status).toBe("blocked");
    vi.mocked(apiFetch).mockResolvedValueOnce(financialAggregate());
    await controller.retry();
    expect(financialCommands()).toHaveLength(1);
    controller.bind({ ...financialBinding, canApprove: false });
    await controller.startDecision(financialDecision);
    expect(financialCommands()).toHaveLength(1);
  });

  it("rejects self-approval and nonpending decisions before transport", async () => {
    const { controller } = setupFinancial();
    await controller.startDecision({
      ...financialDecision,
      approval: { ...financialDecision.approval, requestedBy: financialBinding.currentUserId }
    });
    await controller.startDecision({
      ...financialDecision,
      approval: { ...financialDecision.approval, status: "APPROVED" }
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("publishes only the latest GET and retains the busy state of that read", async () => {
    const { controller, published } = setupFinancial();
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = controller.reload();
    const second = controller.reload();
    old.resolve(financialAggregate("PENDING"));
    await first;
    expect(published).toHaveLength(0);
    expect(controller.getSnapshot().busy).toBe(true);
    next.resolve(financialAggregate("APPROVED"));
    await second;
    expect(published).toEqual([
      expect.objectContaining({ approvals: [expect.objectContaining({ status: "APPROVED" })] })
    ]);
  });

  it("does not accept another case or publish after the real page reader is invalidated", async () => {
    const { controller, published, invalidatePage } = setupFinancial();
    const read = deferred<unknown>();
    vi.mocked(apiFetch).mockReturnValueOnce(read.promise);
    const first = controller.reload();
    invalidatePage();
    read.resolve(financialAggregate());
    await first;
    expect(published).toHaveLength(0);
    expect(controller.getSnapshot().error).toBeTruthy();
    const other = setupFinancial();
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ...financialAggregate(),
      closureCase: { ...aggregate().closureCase, id: "other-case" }
    });
    await other.controller.reload();
    expect(other.published).toHaveLength(0);
  });

  it("requires a successful strict read before clearing an unresolved intent for editing", async () => {
    const { controller } = setupFinancial();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("upload unknown"));
    await controller.startRequest(financialRequest());
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("read failed"));
    await controller.beginNewIntent();
    expect(controller.getSnapshot().pending).not.toBeNull();
    await controller.startRequest(financialRequest());
    expect(financialUploads()).toHaveLength(1);
  });

  it("keeps a new setup usable after disposing the old instance without accepting its pending work", async () => {
    const old = setupFinancial();
    const upload = deferred<{ fileId: string }>();
    vi.mocked(apiFetch).mockReturnValueOnce(upload.promise);
    const starting = old.controller.startRequest(financialRequest());
    old.controller.dispose();
    const next = setupFinancial();
    upload.resolve({ fileId: "old-proof" });
    await starting;
    await old.controller.startDecision(financialDecision);
    expect(financialCommands()).toHaveLength(0);
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce(financialAggregate("APPROVED"));
    await next.controller.startDecision(financialDecision);
    expect(financialCommands()).toHaveLength(1);
    expect(next.controller.getSnapshot().status).toBe("ready");
  });
});
