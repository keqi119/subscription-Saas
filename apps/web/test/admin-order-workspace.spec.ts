import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OrderTransactionGuide } from "../src/components/order-workspace/order-transaction-guide";
import { OrderWorkspaceHeader } from "../src/components/order-workspace/order-workspace-header";
import { OrderWorkspace } from "../src/components/order-workspace/order-workspace";
import {
  ORDER_WORKSPACE_TAB_KEYS,
  buildOrderWorkspaceRecordSelector,
  buildOrderWorkspaceLocation,
  createOrderWorkspaceConfirmScope,
  getOrderWorkspaceChangeGuard,
  getOrderWorkspaceCustomerPresentation,
  getOrderWorkspaceFallbackRecordIds,
  getOrderWorkspaceFinanceLinks,
  getOrderWorkspaceFocusAttemptKey,
  getOrderWorkspaceRecordIds,
  getVehicleReturnWorkspaceState,
  getVisibleOrderWorkspaceTabs,
  getWorkspaceActionPresentation,
  getWorkspaceStatePresentation,
  mergeOrderWorkspaceFocusedServiceCase,
  parseOrderWorkspaceLocation,
  refreshActiveOrderWorkspaceTab,
  shouldLoadOrderWorkspaceFocusedServiceCase
} from "../src/lib/admin-order-workspace";

const TAB_KEYS = ORDER_WORKSPACE_TAB_KEYS;

const TAB_LABELS = [
  "订单基本信息",
  "主合同及订阅套餐",
  "车辆交接",
  "订阅权益",
  "用车中事务",
  "财务/收款核销",
  "变更/历史快照"
] as const;

const repoRoot = join(__dirname, "..", "..", "..");
const orderPagePath = join(repoRoot, "apps/web/src/app/orders/[id]/page.tsx");
const globalStylesPath = join(repoRoot, "apps/web/src/app/globals.css");

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

  it("preserves the legacy create-change intent during the same-order tab transition", () => {
    expect(
      buildOrderWorkspaceLocation({
        createChange: true,
        orderId: "order-1",
        tab: "change"
      })
    ).toBe("/orders/order-1?tab=change&createChange=1");
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
    ["handover.prepare", { label: "推进车辆交接", icon: "CarOutlined" }],
    ["handover.start_signing", { label: "发起交接签署", icon: "FormOutlined" }],
    ["handover.follow_up_signing", { label: "跟进交接签署", icon: "BellOutlined" }],
    ["handover.retry_signing", { label: "重试交接签署", icon: "RedoOutlined" }],
    ["entitlement.activate", { label: "激活权益", icon: "ThunderboltOutlined" }],
    ["entitlement.reconcile", { label: "核对权益", icon: "SyncOutlined" }],
    ["service.resolve", { label: "处理服务工单", icon: "ToolOutlined" }],
    ["finance.generate_initial_bills", { label: "生成初始账单", icon: "FileAddOutlined" }],
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

describe("admin order workspace permission contract", () => {
  it.each([
    ["contract:view", ["overview", "contract"]],
    ["order_change:view", ["overview", "change"]],
    ["subscription_change:view", ["overview", "change"]],
    ["delivery:view", ["overview", "handover"]],
    ["vehicle_return:view", ["overview", "handover"]],
    ["entitlement:view", ["overview", "entitlement"]],
    ["service_case:view", ["overview", "service"]],
    ["billing:view", ["overview", "finance"]],
    ["auto_debit:view", ["overview", "finance"]],
    ["payment:view", ["overview", "finance"]],
    ["deposit_ledger:view", ["overview", "finance"]],
    ["collection:view", ["overview", "finance"]],
    ["order:view", ["overview"]],
    ["unknown:view", ["overview"]]
  ])("maps singleton %s permission fail-closed", (permission, expectedTabs) => {
    expect(getVisibleOrderWorkspaceTabs([permission])).toEqual(expectedTabs);
  });

  it("returns all seven tabs in stable order for the exhaustive permission union", () => {
    expect(
      getVisibleOrderWorkspaceTabs([
        "collection:view",
        "service_case:view",
        "vehicle_return:view",
        "order_change:view",
        "contract:view",
        "entitlement:view"
      ])
    ).toEqual(TAB_KEYS);
  });

  it("does not expose handover for deposit access alone", () => {
    expect(getVisibleOrderWorkspaceTabs(["deposit_ledger:view"])).toEqual([
      "overview",
      "finance"
    ]);
  });

  it.each([
    [["payment:view"], []],
    [["billing:view"], []],
    [
      ["billing:generate"],
      [{ href: "/billing/monthly-rent", label: "月租账单模块" }]
    ],
    [
      ["auto_debit:view"],
      [{ href: "/billing/monthly-rent", label: "月租账单与自动扣款" }]
    ],
    [
      ["collection:view"],
      [{ href: "/billing/collections", label: "逾期催收模块" }]
    ],
    [
      ["collection:view", "billing:generate"],
      [
        { href: "/billing/monthly-rent", label: "月租账单模块" },
        { href: "/billing/collections", label: "逾期催收模块" }
      ]
    ]
  ])("builds live finance links for %j", (permissions, expected) => {
    expect(getOrderWorkspaceFinanceLinks(permissions)).toEqual(expected);
  });

  it.each([
    [
      { changesLoaded: false, hasActiveChange: true, hasOrderChangeView: false },
      { locked: false, waiting: false }
    ],
    [
      { changesLoaded: false, hasActiveChange: false, hasOrderChangeView: true },
      { locked: false, waiting: true }
    ],
    [
      { changesLoaded: true, hasActiveChange: true, hasOrderChangeView: true },
      { locked: true, waiting: false }
    ],
    [
      { changesLoaded: true, hasActiveChange: false, hasOrderChangeView: true },
      { locked: false, waiting: false }
    ]
  ])("resolves change guard %j", (input, expected) => {
    expect(getOrderWorkspaceChangeGuard(input)).toEqual(expected);
  });
});

describe("admin order vehicle return workspace state", () => {
  it.each([
    [
      {
        actualDeliveryAt: null,
        actualReturnAt: null,
        deliveryAlreadyDelivered: false,
        deliveryStatus: "READY",
        hasReturnRecord: false,
        returnStatus: null
      },
      "HIDDEN"
    ],
    [
      {
        actualDeliveryAt: "2026-07-29T08:00:00.000Z",
        actualReturnAt: null,
        deliveryAlreadyDelivered: true,
        deliveryStatus: "DELIVERED",
        hasReturnRecord: false,
        returnStatus: null
      },
      "ENTRY"
    ],
    [
      {
        actualDeliveryAt: "2026-07-29T08:00:00.000Z",
        actualReturnAt: null,
        deliveryAlreadyDelivered: true,
        deliveryStatus: "DELIVERED",
        hasReturnRecord: true,
        returnStatus: "READY"
      },
      "WORKFLOW"
    ],
    [
      {
        actualDeliveryAt: "2026-07-29T08:00:00.000Z",
        actualReturnAt: "2026-08-29T08:00:00.000Z",
        deliveryAlreadyDelivered: true,
        deliveryStatus: "DELIVERED",
        hasReturnRecord: true,
        returnStatus: "CONFIRMED"
      },
      "COMPLETED"
    ]
  ] as const)("resolves %j to %s", (input, expected) => {
    expect(getVehicleReturnWorkspaceState(input)).toBe(expected);
  });
});

describe("admin order workspace refresh and focus helpers", () => {
  it("reads the active tab only after the summary refresh settles", async () => {
    const activeTabRef = { current: "contract" as (typeof TAB_KEYS)[number] };
    const calls: string[] = [];

    await refreshActiveOrderWorkspaceTab({
      activeTabRef,
      refreshSummary: async () => {
        calls.push("summary");
        activeTabRef.current = "handover";
      },
      refreshTab: async (tab) => {
        calls.push(`tab:${tab}`);
      }
    });

    expect(calls).toEqual(["summary", "tab:handover"]);
  });

  it("deduplicates primary records and real aliases without inventing targets", () => {
    const targetMatrix = {
      change: getOrderWorkspaceRecordIds("change-1"),
      contract: getOrderWorkspaceRecordIds("contract-1"),
      entitlement: getOrderWorkspaceRecordIds("account-1"),
      finance: getOrderWorkspaceRecordIds(
        "bill-1",
        "ledger-1",
        "payment-1",
        "collection-1"
      ),
      handover: getOrderWorkspaceRecordIds(
        "work-order-1",
        "handover-1",
        "handover-1"
      ),
      service: getOrderWorkspaceRecordIds("service-1")
    };

    expect(targetMatrix).toEqual({
      change: ["change-1"],
      contract: ["contract-1"],
      entitlement: ["account-1"],
      finance: ["bill-1", "ledger-1", "payment-1", "collection-1"],
      handover: ["work-order-1", "handover-1"],
      service: ["service-1"]
    });
    expect(
      getOrderWorkspaceFallbackRecordIds(targetMatrix.finance, [
        "bill-1",
        "ledger-1"
      ])
    ).toEqual(["payment-1", "collection-1"]);
  });

  it("builds a safely escaped selector for primary records and aliases", () => {
    const escaped: string[] = [];

    expect(
      buildOrderWorkspaceRecordSelector('handover"] [data-secret="raw', (value) => {
        escaped.push(value);
        return "escaped-focus";
      })
    ).toBe(
      '[data-workspace-record="escaped-focus"],[data-workspace-record-alias="escaped-focus"]'
    );
    expect(escaped).toEqual(['handover"] [data-secret="raw']);
  });

  it("retries focus when summary becomes available after the active domain loaded", () => {
    const failedSummaryAttempt = getOrderWorkspaceFocusAttemptKey({
      activeTab: "handover",
      domainLoaded: true,
      domainLoading: false,
      focus: "return-work-order-1",
      summaryAsOf: null
    });
    const successfulSummaryAttempt = getOrderWorkspaceFocusAttemptKey({
      activeTab: "handover",
      domainLoaded: true,
      domainLoading: false,
      focus: "return-work-order-1",
      summaryAsOf: "2026-07-29T08:00:00.000Z"
    });

    expect(failedSummaryAttempt).toBe(
      '["handover","return-work-order-1",null]'
    );
    expect(successfulSummaryAttempt).toBe(
      '["handover","return-work-order-1","2026-07-29T08:00:00.000Z"]'
    );
    expect(successfulSummaryAttempt).not.toBe(failedSummaryAttempt);
    expect(
      getOrderWorkspaceFocusAttemptKey({
        activeTab: "handover",
        domainLoaded: true,
        domainLoading: true,
        focus: "return-work-order-1",
        summaryAsOf: "2026-07-29T08:00:00.000Z"
      })
    ).toBeNull();
  });

  it("merges a real focused service case only for the current order", () => {
    const pageItems = Array.from({ length: 20 }, (_, index) => ({
      id: `recent-${index}`,
      order: { id: "order-1" }
    }));
    const focused = {
      id: "service-action-target",
      order: { id: "order-1" }
    };

    expect(
      mergeOrderWorkspaceFocusedServiceCase({
        focus: "service-action-target",
        focused,
        items: pageItems,
        orderId: "order-1"
      })
    ).toEqual([focused, ...pageItems]);
    expect(() =>
      mergeOrderWorkspaceFocusedServiceCase({
        focus: "service-action-target",
        focused: {
          id: "service-action-target",
          order: { id: "another-order" }
        },
        items: pageItems,
        orderId: "order-1"
      })
    ).toThrow("Focused service case does not belong to this order.");
  });

  it("reloads a cached service tab only until its focused record is present", () => {
    const cachedServiceCaseIds = ["recent-1", "recent-2"];

    expect(
      shouldLoadOrderWorkspaceFocusedServiceCase({
        activeTab: "overview",
        domainLoaded: true,
        focus: "service-action-target",
        serviceCaseIds: cachedServiceCaseIds
      })
    ).toBe(false);
    expect(
      shouldLoadOrderWorkspaceFocusedServiceCase({
        activeTab: "service",
        domainLoaded: true,
        focus: "service-action-target",
        serviceCaseIds: cachedServiceCaseIds
      })
    ).toBe(true);
    expect(
      shouldLoadOrderWorkspaceFocusedServiceCase({
        activeTab: "service",
        domainLoaded: true,
        focus: "service-action-target",
        serviceCaseIds: ["service-action-target", ...cachedServiceCaseIds]
      })
    ).toBe(false);
  });

  it("uses the summary label instead of raw customer data without customer view", () => {
    const customer = {
      mobile: "13800000000",
      name: "Raw Customer Sentinel"
    };

    expect(
      getOrderWorkspaceCustomerPresentation({
        canViewCustomer: false,
        customer,
        summaryLabel: "Safe Summary Customer"
      })
    ).toEqual({ label: "Safe Summary Customer" });
    expect(
      getOrderWorkspaceCustomerPresentation({
        canViewCustomer: true,
        customer,
        summaryLabel: "Safe Summary Customer"
      })
    ).toEqual({
      label: "Raw Customer Sentinel",
      mobile: "13800000000"
    });
  });

  it("destroys every scoped confirm handle on disposal and rejects late handles", () => {
    const destroyed: string[] = [];
    const scope = createOrderWorkspaceConfirmScope(
      ({ id }: { id: string }) => ({
        destroy: () => {
          destroyed.push(id);
        }
      })
    );

    scope.confirm({ id: "first" });
    scope.confirm({ id: "second" });
    scope.destroy();
    scope.destroy();
    scope.confirm({ id: "late" });

    expect(destroyed).toEqual(["first", "second", "late"]);
  });
});

describe("admin order detail workspace migration", () => {
  it("loads auth and workspace summary before dispatching only the active tab domain", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const activeTabLoader = sourceBetween(
      source,
      "const loadActiveWorkspaceTab = useCallback",
      "const loadWorkspaceShell = useCallback"
    );

    expect(source).toMatch(
      /apiFetch<OrderWorkspaceSummary>\(\s*`\/orders\/\$\{orderId\}\/workspace\/summary`/
    );
    expect(source).toContain('apiFetch<AuthMeResponse>("/auth/me")');
    expect(source).toContain("void loadWorkspaceShell()");
    expect(activeTabLoader).toContain("switch (activeTab)");
    expect(activeTabLoader).toContain('case "handover":');
    expect(activeTabLoader).toContain('case "entitlement":');
    expect(activeTabLoader).toContain('case "service":');
    expect(activeTabLoader).toContain('case "finance":');
    expect(activeTabLoader).toContain('case "change":');
    expect(source).not.toContain(
      "apiFetch<OrderDetail>(`/orders/${orderId}`),\n        apiFetch<OrderChangeRow[]>"
    );
  });

  it("loads a missing focused service record and validates it before merging", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const serviceLoader = sourceBetween(
      source,
      "const loadServiceDomain = useCallback",
      "const loadActiveWorkspaceTab = useCallback"
    );

    expect(serviceLoader).toContain(
      "apiFetch<PortalPagedResponse<PortalServiceCase>>"
    );
    expect(serviceLoader).toContain(
      "`/service-cases?${query.toString()}`"
    );
    expect(serviceLoader).toContain(
      "`/orders/${encodeURIComponent(orderId)}/workspace/service-cases/${encodeURIComponent(focus)}`"
    );
    expect(serviceLoader).not.toContain(
      "apiFetch<PortalServiceCase>(`/service-cases/${encodeURIComponent(focus)}`)"
    );
    expect(serviceLoader).toContain(
      "mergeOrderWorkspaceFocusedServiceCase"
    );
    expect(source).toContain(
      "shouldLoadOrderWorkspaceFocusedServiceCase({"
    );
    expect(source).toContain(
      'void loadActiveWorkspaceTab("service", true)'
    );
  });

  it("loads the permission-filtered workspace detail and keeps contract data out of overview", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const detailType = sourceBetween(
      source,
      "interface OrderDetail",
      "interface FinanceSummary"
    );
    const detailLoader = sourceBetween(
      source,
      "const loadOrderDetail = useCallback",
      "const loadWorkspaceResource = useCallback"
    );
    const overviewSections = sourceBetween(
      source,
      "function OrderInfoSections",
      "function EntitlementPanel"
    );
    const renderer = sourceBetween(
      source,
      "function renderActiveWorkspaceTab()",
      "const stage2FallbackPdfDownloadUrl"
    );
    const contractSlot = sourceBetween(
      renderer,
      'case "contract":',
      'case "handover":'
    );

    expect(detailLoader).toContain(
      "`/orders/${orderId}/workspace/detail`"
    );
    expect(detailLoader).not.toContain("`/orders/${orderId}`");
    expect(detailType).toContain("customerId?: string;");
    expect(detailType).not.toContain("customerId: string;");
    expect(overviewSections).not.toContain('title="合同信息"');
    expect(contractSlot).toContain("产品匹配审核");
    expect(contractSlot).toContain("<QuoteSnapshotSection");
  });

  it("uses parsed URL state and one replace-based builder consumer for tabs and guidance", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const navigation = sourceBetween(
      source,
      "const navigateWorkspace = useCallback",
      "const loadOrderDetail"
    );

    expect(source).toContain("parseOrderWorkspaceLocation(searchParams)");
    expect(navigation).toContain("buildOrderWorkspaceLocation({");
    expect(navigation).toContain("router.replace(location, { scroll: false })");
    expect(source).toContain("onTabChange={(tab) => navigateWorkspace({ tab })}");
    expect(source).toContain("onNavigate={navigateWorkspace}");
  });

  it("maps Stage 1 actions only to contract and Stage 2 only to handover", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const renderer = sourceBetween(
      source,
      "function renderActiveWorkspaceTab()",
      "const stage2FallbackPdfDownloadUrl"
    );
    const contractSlot = sourceBetween(
      renderer,
      'case "contract":',
      'case "handover":'
    );
    const handoverSlot = sourceBetween(
      renderer,
      'case "handover":',
      'case "entitlement":'
    );
    const pageHeader = sourceBetween(
      source,
      "<OrderWorkspaceHeader",
      "<OrderTransactionGuide"
    );
    const overviewSlot = sourceBetween(
      renderer,
      'case "overview":',
      'case "contract":'
    );

    expect(contractSlot).toContain("generateContractAvailability");
    expect(contractSlot).toContain("generateContract");
    expect(contractSlot).toContain("<QuoteSnapshotSection");
    expect(contractSlot).not.toContain("<ReviewPanel");
    expect(contractSlot).not.toContain("<Stage2HandoverReviewPanel");
    expect(overviewSlot).toContain("<ReviewPanel");
    expect(handoverSlot).toContain("<DeliveryPanel");
    expect(handoverSlot).toContain("<Stage2HandoverReviewPanel");
    expect(handoverSlot).toContain("<ReturnPanel");
    expect(handoverSlot).toContain("<HandoverProgressRecords");
    expect(handoverSlot).not.toContain("<DepositSettlementPanel");
    expect(handoverSlot).not.toContain("generateContract");
    expect(pageHeader).not.toContain("生成合同");
    expect(pageHeader).not.toContain("查看合同");
  });

  it("keeps repeated handover blocker messages as distinct React list entries", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source).not.toContain("<li key={reason}>");
    expect(
      source.match(/blockingReasons\.map\(\(reason, index\) =>/g)
    ).toHaveLength(2);
    expect(source.match(/key=\{`\$\{reason\}-\$\{index\}`\}/g)).toHaveLength(2);
  });

  it("loads authoritative delivery defaults and shows manual adjustment state", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const openModal = sourceBetween(
      source,
      "async function openConfirmDeliveryModal()",
      "function closeConfirmDeliveryModal()"
    );

    expect(source).toContain("confirmationDefaults?: DeliveryConfirmationDefaults | null;");
    expect(openModal).toContain("apiFetch<DeliveryCheck>(`/orders/${order.id}/delivery-check`)");
    expect(openModal).toContain("nextDeliveryCheck.confirmationDefaults");
    expect(source).toContain("getDeliveryConfirmationAdjustmentState");
    expect(source).toContain("deliveryConfirmationSourceHints.deliveredAt");
    expect(source).toContain("deliveryConfirmationSourceHints.handoverMileageKm");
    expect(source).toContain("已人工调整");
  });

  it("maps all seven active bodies without mounting inactive domain content", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const renderer = sourceBetween(
      source,
      "function renderActiveWorkspaceTab()",
      "const stage2FallbackPdfDownloadUrl"
    );

    expect(renderer).toContain('case "overview":');
    expect(renderer).toContain("<OrderInfoSections");
    expect(renderer).toContain('case "contract":');
    expect(renderer).toContain('case "handover":');
    expect(renderer).toContain('case "entitlement":');
    expect(renderer).toContain("<EntitlementPanel");
    expect(renderer).toContain('case "service":');
    expect(renderer).toContain("<ServiceCasesPanel");
    expect(renderer).toContain('case "finance":');
    expect(renderer).toContain("<FinancePanel");
    expect(renderer).toContain("<OrderAutoDebitTracePanel");
    expect(source).toContain("/billing/automation/mandates?page=1&pageSize=100&orderNo=");
    expect(source).toContain("/billing/automation/attempts?page=1&pageSize=100&orderId=");
    expect(renderer).toContain('case "change":');
    expect(renderer).toContain("changes={changes}");
    expect(source).toContain("slots={{ [activeTab]: renderActiveWorkspaceTab() }}");
  });

  it("waits for active data then focuses a safely escaped workspace record", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source).toContain("buildOrderWorkspaceRecordSelector(focus, CSS.escape)");
    expect(source).toContain("record.scrollIntoView");
    expect(source).toContain("data-workspace-focus-highlight");
    expect(source).toContain('"data-workspace-record": workOrder.id');
  });

  it("keys the complete stateful page boundary by route order id", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const routeBoundary = sourceBetween(
      source,
      "function OrderDetailPageRoute()",
      "export default function OrderDetailPage()"
    );

    expect(source).toContain(
      "function OrderDetailPageContent({ orderId }: { orderId: string })"
    );
    expect(routeBoundary).toContain("const { id: orderId } = useParams");
    expect(routeBoundary).toContain(
      "<OrderDetailPageContent key={orderId} orderId={orderId} />"
    );
  });

  it("re-arms legacy createChange intent from search params for back and forward", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const legacyChangeEffect = sourceBetween(
      source,
      "const createChangeRequested",
      "function closeChangeModal()"
    );

    expect(legacyChangeEffect).toContain(
      "autoOpenChangeRequestedRef.current = createChangeRequested"
    );
    expect(legacyChangeEffect).toContain("setAutoOpenChangeModalDone(false)");
    expect(legacyChangeEffect).toContain("createChange: true");
    expect(legacyChangeEffect).toContain(
      '!visibleTabs.includes("change")'
    );
    expect(legacyChangeEffect).toContain(
      "autoOpenChangeRequestedRef.current = false"
    );
    expect(legacyChangeEffect).toMatch(
      /\[\s*activeTab,[\s\S]*createChangeRequested,[\s\S]*visibleTabs\s*\]/
    );
  });

  it("keeps summary and active-domain failures local and independently retryable", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source).toContain("summaryError");
    expect(source).toContain("activeDomainError");
    expect(source).toContain("retryWorkspaceSummary");
    expect(source).toContain("retryActiveWorkspaceTab");
    expect(source).toMatch(/summary\?\.tabBadges|summary\.tabBadges/);
    expect(source).toMatch(/summary\?\.recentActivity|summary\.recentActivity/);
  });

  it("consumes permission and refresh helpers at the page boundary", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const handoverLoader = sourceBetween(
      source,
      "const loadHandoverDomain = useCallback",
      "const loadEntitlementDomain = useCallback"
    );
    const activeLoader = sourceBetween(
      source,
      "const loadActiveWorkspaceTab = useCallback",
      "const loadWorkspaceSummary = useCallback"
    );
    const mutationRefresh = sourceBetween(
      source,
      "const loadOrder = useCallback",
      "useEffect(() =>"
    );

    expect(source).toContain("getVisibleOrderWorkspaceTabs(permissions)");
    expect(source).toContain(
      "getOrderWorkspaceChangeGuard({"
    );
    expect(handoverLoader).toContain("hasOrderChangeView");
    expect(handoverLoader).toContain(
      'vehicleReturnWorkspaceState !== "HIDDEN"'
    );
    expect(handoverLoader.indexOf('vehicleReturnWorkspaceState !== "HIDDEN"'))
      .toBeLessThan(handoverLoader.indexOf("/return-check"));
    expect(handoverLoader).not.toContain("loadDepositSettlementDomain");
    expect(activeLoader).toContain(
      'case "contract":'
    );
    expect(activeLoader).toContain("hasOrderChangeView");
    expect(mutationRefresh).toContain("refreshActiveOrderWorkspaceTab({");
    expect(mutationRefresh).toContain("activeTabRef");
  });

  it("renders the return entry only after delivery and expands only for a return record", () => {
    const source = readFileSync(orderPagePath, "utf8");
    const renderedWorkspace = source.slice(source.indexOf("let content: ReactNode;"));
    const handoverTab = sourceBetween(
      renderedWorkspace,
      'case "handover":',
      'case "entitlement":'
    );

    expect(source).toContain(
      "const vehicleReturnWorkspaceState = getVehicleReturnWorkspaceState({"
    );
    expect(handoverTab).toContain(
      'vehicleReturnWorkspaceState === "ENTRY"'
    );
    expect(handoverTab).toContain("<VehicleReturnEntry");
    expect(handoverTab).toMatch(
      /vehicleReturnWorkspaceState === "WORKFLOW"[\s\S]*vehicleReturnWorkspaceState === "COMPLETED"[\s\S]*<ReturnPanel/
    );
    expect(source).toContain("alreadyReturned ? null :");
  });

  it("wires focus markers to every real backend target kind", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source).toContain("order.contract.id");
    expect(source).toContain("esignStatuses[workOrder.id]?.handoverId");
    expect(source).toContain('"data-workspace-record-alias"');
    expect(source).toContain("entitlements.account?.id");
    expect(source).toContain('"data-workspace-record": bill.id');
    expect(source).toContain('"data-workspace-record": ledger.id');
    expect(source).toContain('"data-workspace-record": serviceCase.id');
    expect(source).toContain('"data-workspace-record": change.id');
    expect(source).toContain("当前财务推进记录");
    expect(source).toContain("当前交接推进记录");
    expect(source).not.toContain("providerPayload");
  });

  it("routes all confirm dialogs through the order-scoped disposer", () => {
    const source = readFileSync(orderPagePath, "utf8");

    expect(source.match(/scopedConfirm\.confirm\(/g)).toHaveLength(3);
    expect(source).not.toContain("modal.confirm(");
    expect(source).toContain("createOrderWorkspaceConfirmScope");
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
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("当前车辆交接内容");
    expect(markup).not.toContain("合同内容不应挂载");
    expect(markup).not.toContain("变更内容不应挂载");
  });

  it("falls back to overview without mounting a hidden active tab slot", () => {
    const markup = renderToStaticMarkup(
      createElement(OrderWorkspace, {
        activeTab: "finance",
        onTabChange: () => undefined,
        slots: {
          contract: createElement("p", null, "可见合同内容"),
          finance: createElement("p", null, "隐藏财务敏感内容"),
          overview: createElement("p", null, "安全基本信息内容")
        },
        visibleTabs: ["contract", "overview"]
      })
    );

    expect(markup).toContain('data-workspace-active-content="overview"');
    expect(markup).toContain("安全基本信息内容");
    expect(markup).not.toContain("隐藏财务敏感内容");
    expect(markup).toContain('role="tabpanel"');
  });

  it("keeps only the tab bar horizontally scrollable on narrow screens", () => {
    const markup = renderToStaticMarkup(
      createElement(OrderWorkspace, {
        activeTab: "overview",
        onTabChange: () => undefined,
        slots: {
          overview: createElement(
            "div",
            { "data-mobile-content": "true" },
            "移动端内容"
          )
        }
      })
    );

    expect(markup).toContain('data-workspace-tab-scroll="true"');
    expect(markup).toContain('data-mobile-content="true"');
    expect(markup).not.toContain("min-width:1040");
  });

  it("stacks workspace description entries on narrow screens", () => {
    const styles = readFileSync(globalStylesPath, "utf8");

    expect(styles).toContain("@media (max-width: 575px)");
    expect(styles).toContain(
      '[data-workspace-active-content] .ant-descriptions-row'
    );
    expect(styles).toContain(
      "grid-template-columns: minmax(88px, 34%) minmax(0, 1fr)"
    );
    expect(styles).toContain("overflow-wrap: anywhere");
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

  it("keeps the ACTIVE-order contract-change entry distinct from pre-delivery redesign", () => {
    const orderPage = readFileSync(orderPagePath, "utf8");

    expect(orderPage).toContain('key: "create-subscription-change"');
    expect(orderPage).toContain('label: "发起合同变更"');
    expect(orderPage).toContain('key: "return-to-plan"');
    expect(orderPage).toContain('label: "交付前退回重做方案"');
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
    expect(markup.match(/data-workspace-action-code="contract.generate"/g)).toHaveLength(1);
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

  it("renders and clicks an independent primary action using its own target", () => {
    const navigations: Array<{ focus?: string; tab: string }> = [];
    const props = {
      onNavigate: (target: { focus?: string; tab: string }) => {
        navigations.push(target);
      },
      summary: {
        asOf: "2026-07-29T01:10:00.000Z",
        guidance: [
          guidanceItem("contract", "READY", "contract.generate"),
          guidanceItem("handover", "READY", "handover.assign"),
          guidanceItem("entitlement", "READY", "entitlement.activate"),
          guidanceItem("service", "READY", "service.resolve"),
          {
            ...guidanceItem("finance", "ACTION_REQUIRED", null),
            reasonCode: "FINANCE_COLLECTION_ACTION_DUE",
            targetRecordId: "collection-1"
          },
          guidanceItem("change", "READY", "change.approve")
        ],
        primaryAction: {
          actionCode: "finance.collect",
          targetRecordId: "bill-1",
          targetTab: "finance" as const
        }
      }
    };
    const rendered = OrderTransactionGuide(props);
    const markup = renderToStaticMarkup(rendered);

    expect(markup.match(/data-workspace-action-kind="primary"/g)).toHaveLength(1);
    expect(markup.match(/data-workspace-action-kind="secondary"/g)).toHaveLength(5);
    expect(markup).toContain('data-workspace-action-code="finance.collect"');
    expect(markup).toContain("发起收款");
    expect(markup).toContain("anticon-pay-circle");

    const primaryAction = findWorkspaceAction(rendered, "primary");
    primaryAction.props.onClick?.();

    expect(navigations).toEqual([{ focus: "bill-1", tab: "finance" }]);
  });

  it("navigates handover preparation to the existing handover workspace", () => {
    const navigations: Array<{ focus?: string; tab: string }> = [];
    const rendered = OrderTransactionGuide({
      onNavigate: (target) => navigations.push(target),
      summary: {
        asOf: "2026-08-01T06:00:00.000Z",
        guidance: [
          {
            ...guidanceItem("handover", "ACTION_REQUIRED", "handover.prepare"),
            targetRecordId: null
          }
        ],
        primaryAction: {
          actionCode: "handover.prepare",
          targetRecordId: null,
          targetTab: "handover"
        }
      }
    });
    const markup = renderToStaticMarkup(rendered);

    expect(markup).toContain('data-workspace-action-code="handover.prepare"');
    expect(markup).toContain("推进车辆交接");
    expect(markup).toContain("anticon-car");
    findWorkspaceAction(rendered, "primary").props.onClick?.();
    expect(navigations).toEqual([{ tab: "handover" }]);
  });

  it("fails closed for an unknown guide action while retaining tab navigation", () => {
    const rendered = OrderTransactionGuide({
      onNavigate: () => undefined,
      summary: {
        asOf: "2026-07-29T01:10:00.000Z",
        guidance: [guidanceItem("finance", "ACTION_REQUIRED", null)],
        primaryAction: {
          actionCode: "finance.future_action",
          targetRecordId: "bill-1",
          targetTab: "finance"
        }
      }
    });
    const markup = renderToStaticMarkup(rendered);

    expect(markup).toContain('data-workspace-action-code="finance.future_action"');
    expect(markup).toContain('data-workspace-action-kind="unavailable"');
    expect(markup).not.toContain('data-workspace-action-kind="primary"');
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
  actionCode: string | null,
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

type WorkspaceActionElement = ReactElement<{
  "data-workspace-action-kind"?: string;
  children?: ReactNode;
  onClick?: () => void;
}>;

function findWorkspaceAction(node: ReactNode, kind: string): WorkspaceActionElement {
  let match: WorkspaceActionElement | null = null;

  function visit(current: ReactNode) {
    Children.forEach(current, (child) => {
      if (match || !isValidElement<WorkspaceActionElement["props"]>(child)) {
        return;
      }

      if (child.props["data-workspace-action-kind"] === kind) {
        match = child;
        return;
      }

      visit(child.props.children);
      if (
        !match &&
        typeof child.type === "function" &&
        child.type.name === "GuideItem"
      ) {
        visit(child.type(child.props));
      }
    });
  }

  visit(node);
  expect(match, `expected a ${kind} workspace action`).not.toBeNull();
  return match as WorkspaceActionElement;
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
