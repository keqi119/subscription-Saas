import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ApiError, apiFetch } from "../src/lib/api";
import * as api from "../src/lib/subscription-closure-api";
import * as inspection from "../src/components/subscription-closure/return-inspection-work-order";

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
