import { describe, expect, it } from "vitest";

import {
  buildOrderWorkspaceLocation,
  getWorkspaceActionPresentation,
  getWorkspaceStatePresentation,
  parseOrderWorkspaceLocation
} from "../src/lib/admin-order-workspace";

const TAB_KEYS = [
  "overview",
  "contract",
  "handover",
  "entitlement",
  "service",
  "finance",
  "change"
] as const;

describe("admin order workspace navigation model", () => {
  it.each(TAB_KEYS)("parses the %s workspace tab", (tab) => {
    expect(
      parseOrderWorkspaceLocation(
        new URLSearchParams({
          focus: "record-1",
          tab
        })
      )
    ).toEqual({
      focus: "record-1",
      tab
    });
  });

  it.each([new URLSearchParams(), new URLSearchParams({ tab: "unknown" })])(
    "falls back to overview for a missing or invalid tab",
    (searchParams) => {
      expect(parseOrderWorkspaceLocation(searchParams)).toEqual({ tab: "overview" });
    }
  );

  it("encodes focus through URLSearchParams and parses it back", () => {
    const focus = "work order/交接?step=1&ready=true";
    const location = buildOrderWorkspaceLocation({
      focus,
      orderId: "order-1",
      tab: "handover"
    });

    expect(location).toBe(
      "/orders/order-1?tab=handover&focus=work+order%2F%E4%BA%A4%E6%8E%A5%3Fstep%3D1%26ready%3Dtrue"
    );
    expect(parseOrderWorkspaceLocation(new URL(location, "https://workspace.test").searchParams)).toEqual({
      focus,
      tab: "handover"
    });
  });

  it("omits focus when navigation has no focused record", () => {
    expect(
      buildOrderWorkspaceLocation({
        orderId: "order-1",
        tab: "overview"
      })
    ).toBe("/orders/order-1?tab=overview");
    expect(
      buildOrderWorkspaceLocation({
        focus: "",
        orderId: "order-1",
        tab: "overview"
      })
    ).toBe("/orders/order-1?tab=overview");
    expect(parseOrderWorkspaceLocation(new URLSearchParams({ focus: "", tab: "overview" }))).toEqual({
      tab: "overview"
    });
  });

  it("uses one URL builder shape for guidance actions and tab clicks", () => {
    expect(
      buildOrderWorkspaceLocation({
        focus: "handover-1",
        orderId: "order-1",
        tab: "handover"
      })
    ).toBe("/orders/order-1?tab=handover&focus=handover-1");
    expect(
      buildOrderWorkspaceLocation({
        orderId: "order-1",
        tab: "finance"
      })
    ).toBe("/orders/order-1?tab=finance");
  });

  it.each([
    ["BLOCKED", { label: "已阻塞", color: "red" }],
    ["ACTION_REQUIRED", { label: "待处理", color: "orange" }],
    ["FAILED", { label: "处理失败", color: "red" }],
    ["PROCESSING", { label: "处理中", color: "blue" }],
    ["WAITING_EXTERNAL", { label: "等待外部处理", color: "gold" }],
    ["READY", { label: "可继续", color: "cyan" }],
    ["COMPLETED", { label: "已完成", color: "green" }],
    ["NOT_STARTED", { label: "未开始", color: "default" }],
    ["UNAVAILABLE", { label: "暂不可用", color: "default" }]
  ] as const)("presents the %s state in Chinese", (state, presentation) => {
    expect(getWorkspaceStatePresentation(state)).toEqual(presentation);
  });

  it.each([
    ["contract.generate", { label: "生成合同", icon: "FileAddOutlined" }],
    ["contract.sign", { label: "发起合同签署", icon: "FormOutlined" }],
    ["contract.retry_signing", { label: "重试合同签署", icon: "RedoOutlined" }],
    ["handover.assign", { label: "分配交接任务", icon: "UserAddOutlined" }],
    ["handover.start_signing", { label: "发起交接签署", icon: "FormOutlined" }],
    ["handover.follow_up_signing", { label: "跟进交接签署", icon: "BellOutlined" }],
    ["handover.retry_signing", { label: "重试交接签署", icon: "RedoOutlined" }],
    ["entitlement.activate", { label: "激活权益", icon: "ThunderboltOutlined" }],
    ["entitlement.reconcile", { label: "核对权益", icon: "SyncOutlined" }],
    ["service.resolve", { label: "处理服务工单", icon: "ToolOutlined" }],
    ["finance.collect", { label: "发起收款", icon: "PayCircleOutlined" }],
    ["finance.refund_deposit", { label: "退还押金", icon: "RollbackOutlined" }],
    ["finance.deduct_deposit", { label: "扣减押金", icon: "MinusCircleOutlined" }],
    ["change.approve", { label: "审批变更", icon: "AuditOutlined" }],
    ["change.execute", { label: "执行变更", icon: "PlayCircleOutlined" }],
    ["change.retry", { label: "重试变更", icon: "RedoOutlined" }]
  ] as const)("presents the known %s action", (actionCode, presentation) => {
    expect(getWorkspaceActionPresentation(actionCode)).toEqual(presentation);
  });

  it("fails closed for an unknown action code", () => {
    expect(getWorkspaceActionPresentation("contract.delete")).toBeNull();
    expect(getWorkspaceActionPresentation("finance.reconcile")).toBeNull();
    expect(getWorkspaceActionPresentation("finance.collection_follow_up")).toBeNull();
    expect(getWorkspaceActionPresentation("")).toBeNull();
  });
});
