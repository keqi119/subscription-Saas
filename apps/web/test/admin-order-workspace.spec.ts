import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrderTransactionGuide } from "../src/components/order-workspace/order-transaction-guide";
import { OrderWorkspaceHeader } from "../src/components/order-workspace/order-workspace-header";
import { OrderWorkspace } from "../src/components/order-workspace/order-workspace";
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

const TAB_LABELS = [
  "订单基本信息",
  "主合同及订阅套餐",
  "车辆交接",
  "订阅权益",
  "用车中事务",
  "财务/收款核销",
  "变更/历史快照"
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

describe("admin order workspace shell", () => {
  it("renders the exact seven tab labels and only the active typed slot", () => {
    const markup = renderToStaticMarkup(
      createElement(OrderWorkspace, {
        activeTab: "handover",
        onTabChange: () => undefined,
        slots: {
          change: createElement("p", null, "变更内容不应挂载"),
          contract: createElement("p", null, "合同内容不应挂载"),
          entitlement: createElement("p", null, "权益内容不应挂载"),
          finance: createElement("p", null, "财务内容不应挂载"),
          handover: createElement("p", null, "当前车辆交接内容"),
          overview: createElement("p", null, "基本信息不应挂载"),
          service: createElement("p", null, "事务内容不应挂载")
        }
      })
    );

    for (const label of TAB_LABELS) {
      expect(markup).toContain(label);
    }
    expect(markup.match(/data-workspace-active-content=/g)).toHaveLength(1);
    expect(markup).toContain("当前车辆交接内容");
    expect(markup).not.toContain("合同内容不应挂载");
    expect(markup).not.toContain("变更内容不应挂载");
  });

  it("renders a compact order header without Stage 1 contract actions", () => {
    const markup = renderToStaticMarkup(
      createElement(OrderWorkspaceHeader, {
        header: {
          currentVehicleLabel: "沪A·12345 / VIN0001",
          customerLabel: "张三",
          orderNo: "SO-20260729-001",
          orderStatus: "ACTIVE",
          orderStatusLabel: "履约中",
          ownerLabel: "李销售"
        },
        onBack: () => undefined,
        onRefresh: () => undefined,
        overflowActions: [
          {
            key: "cancel",
            label: "取消订单",
            onClick: () => undefined
          }
        ]
      })
    );

    expect(markup).toContain('data-workspace-header="true"');
    expect(markup).toContain("SO-20260729-001");
    expect(markup).toContain("履约中");
    expect(markup).toContain("张三");
    expect(markup).toContain("沪A·12345 / VIN0001");
    expect(markup).toContain("李销售");
    expect(markup).toContain('aria-label="返回订单列表"');
    expect(markup).toContain('aria-label="刷新订单工作台"');
    expect(markup).toContain('aria-label="订单级更多操作"');
    expect(markup).not.toContain("生成合同");
    expect(markup).not.toContain("查看合同");
  });

  it("renders six compact guidance items with one primary and preserved secondary actions", () => {
    const summary = {
      asOf: "2026-07-29T01:10:00.000Z",
      guidance: [
        guidanceItem("contract", "ACTION_REQUIRED", "contract.generate", 2),
        guidanceItem("handover", "READY", "handover.assign"),
        guidanceItem("entitlement", "READY", "entitlement.activate"),
        guidanceItem("service", "ACTION_REQUIRED", "service.resolve"),
        guidanceItem("finance", "ACTION_REQUIRED", "finance.collect"),
        guidanceItem("change", "READY", "change.approve")
      ],
      primaryAction: {
        actionCode: "contract.generate",
        targetRecordId: "contract-1",
        targetTab: "contract" as const
      }
    };
    const markup = renderToStaticMarkup(
      createElement(OrderTransactionGuide, {
        onNavigate: () => undefined,
        summary
      })
    );

    expect(markup.match(/data-workspace-guide-category=/g)).toHaveLength(6);
    expect(markup.match(/data-workspace-action-kind="primary"/g)).toHaveLength(1);
    expect(markup.match(/data-workspace-action-kind="secondary"/g)).toHaveLength(5);
    expect(markup).toContain('data-workspace-additional-count="2"');
    expect(markup).toContain("2026-07-29");
    for (const categoryLabel of TAB_LABELS.slice(1)) {
      expect(markup).toContain(categoryLabel);
    }
    for (const actionLabel of [
      "生成合同",
      "分配交接任务",
      "激活权益",
      "处理服务工单",
      "发起收款",
      "审批变更"
    ]) {
      expect(markup).toContain(actionLabel);
    }
  });

  it("fails closed for an unknown guide action while retaining tab navigation", () => {
    const markup = renderToStaticMarkup(
      createElement(OrderTransactionGuide, {
        onNavigate: () => undefined,
        summary: {
          asOf: "2026-07-29T01:10:00.000Z",
          guidance: [guidanceItem("finance", "ACTION_REQUIRED", "finance.future_action")],
          primaryAction: {
            actionCode: "finance.future_action",
            targetRecordId: "bill-1",
            targetTab: "finance"
          }
        }
      })
    );

    expect(markup).toContain('data-workspace-action-code="finance.future_action"');
    expect(markup).toContain('data-workspace-action-kind="unavailable"');
    expect(markup).toContain("动作不可用");
    expect(markup).toContain("disabled");
    expect(markup).toContain('data-workspace-navigation="finance"');
  });
});

function guidanceItem(
  category: (typeof TAB_KEYS)[number] extends infer Tab
    ? Exclude<Tab, "overview">
    : never,
  state: Parameters<typeof getWorkspaceStatePresentation>[0],
  actionCode: string,
  additionalCount = 0
) {
  return {
    actionCode,
    additionalCount,
    blocking: state === "BLOCKED",
    category,
    priority: 10,
    reasonCode: `${category.toUpperCase()}_TEST`,
    state,
    targetRecordId: `${category}-1`,
    targetTab: category,
    updatedAt: "2026-07-29T01:00:00.000Z"
  };
}
