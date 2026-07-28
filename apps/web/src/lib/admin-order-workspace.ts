export type OrderWorkspaceTabKey =
  | "overview"
  | "contract"
  | "handover"
  | "entitlement"
  | "service"
  | "finance"
  | "change";

export type OrderWorkspaceState =
  | "BLOCKED"
  | "ACTION_REQUIRED"
  | "FAILED"
  | "PROCESSING"
  | "WAITING_EXTERNAL"
  | "READY"
  | "COMPLETED"
  | "NOT_STARTED"
  | "UNAVAILABLE";

export type OrderWorkspaceActionCode =
  | "contract.generate"
  | "contract.sign"
  | "contract.retry_signing"
  | "handover.assign"
  | "handover.start_signing"
  | "handover.follow_up_signing"
  | "handover.retry_signing"
  | "entitlement.activate"
  | "entitlement.reconcile"
  | "service.resolve"
  | "finance.collect"
  | "finance.refund_deposit"
  | "finance.deduct_deposit"
  | "change.approve"
  | "change.execute"
  | "change.retry";

const ORDER_WORKSPACE_TAB_KEYS = new Set<OrderWorkspaceTabKey>([
  "overview",
  "contract",
  "handover",
  "entitlement",
  "service",
  "finance",
  "change"
]);

const ORDER_WORKSPACE_TAB_PERMISSIONS = {
  change: ["order_change:view"],
  contract: ["contract:view"],
  entitlement: ["entitlement:view"],
  finance: [
    "billing:view",
    "payment:view",
    "deposit_ledger:view",
    "collection:view"
  ],
  handover: ["delivery:view", "vehicle_return:view"],
  service: ["service_case:view"]
} as const satisfies Record<
  Exclude<OrderWorkspaceTabKey, "overview">,
  readonly string[]
>;

const ORDER_WORKSPACE_PERMISSION_TAB_ORDER = [
  "contract",
  "handover",
  "entitlement",
  "service",
  "finance",
  "change"
] as const satisfies ReadonlyArray<Exclude<OrderWorkspaceTabKey, "overview">>;

const STATE_PRESENTATIONS = {
  BLOCKED: { label: "已阻塞", color: "red" },
  ACTION_REQUIRED: { label: "待处理", color: "orange" },
  FAILED: { label: "处理失败", color: "red" },
  PROCESSING: { label: "处理中", color: "blue" },
  WAITING_EXTERNAL: { label: "等待外部处理", color: "gold" },
  READY: { label: "可继续", color: "cyan" },
  COMPLETED: { label: "已完成", color: "green" },
  NOT_STARTED: { label: "未开始", color: "default" },
  UNAVAILABLE: { label: "暂不可用", color: "default" }
} satisfies Record<OrderWorkspaceState, { color: string; label: string }>;

const ACTION_PRESENTATIONS = {
  "contract.generate": { label: "生成合同", icon: "FileAddOutlined" },
  "contract.sign": { label: "发起合同签署", icon: "FormOutlined" },
  "contract.retry_signing": { label: "重试合同签署", icon: "RedoOutlined" },
  "handover.assign": { label: "分配交接任务", icon: "UserAddOutlined" },
  "handover.start_signing": { label: "发起交接签署", icon: "FormOutlined" },
  "handover.follow_up_signing": { label: "跟进交接签署", icon: "BellOutlined" },
  "handover.retry_signing": { label: "重试交接签署", icon: "RedoOutlined" },
  "entitlement.activate": { label: "激活权益", icon: "ThunderboltOutlined" },
  "entitlement.reconcile": { label: "核对权益", icon: "SyncOutlined" },
  "service.resolve": { label: "处理服务工单", icon: "ToolOutlined" },
  "finance.collect": { label: "发起收款", icon: "PayCircleOutlined" },
  "finance.refund_deposit": { label: "退还押金", icon: "RollbackOutlined" },
  "finance.deduct_deposit": { label: "扣减押金", icon: "MinusCircleOutlined" },
  "change.approve": { label: "审批变更", icon: "AuditOutlined" },
  "change.execute": { label: "执行变更", icon: "PlayCircleOutlined" },
  "change.retry": { label: "重试变更", icon: "RedoOutlined" }
} satisfies Record<OrderWorkspaceActionCode, { icon: string; label: string }>;

export function parseOrderWorkspaceLocation(
  searchParams: URLSearchParams
): { tab: OrderWorkspaceTabKey; focus?: string } {
  const requestedTab = searchParams.get("tab");
  const tab = isOrderWorkspaceTabKey(requestedTab) ? requestedTab : "overview";
  const focus = searchParams.get("focus");

  return focus ? { focus, tab } : { tab };
}

export function buildOrderWorkspaceLocation(input: {
  createChange?: boolean;
  orderId: string;
  tab: OrderWorkspaceTabKey;
  focus?: string;
}): string {
  const searchParams = new URLSearchParams({ tab: input.tab });
  if (input.focus) {
    searchParams.set("focus", input.focus);
  }
  if (input.createChange) {
    searchParams.set("createChange", "1");
  }

  return `/orders/${encodeURIComponent(input.orderId)}?${searchParams.toString()}`;
}

export function getVisibleOrderWorkspaceTabs(
  permissions: Iterable<string>
): OrderWorkspaceTabKey[] {
  const permissionSet =
    permissions instanceof Set ? permissions : new Set(permissions);

  return [
    "overview",
    ...ORDER_WORKSPACE_PERMISSION_TAB_ORDER
      .filter((tab) =>
        ORDER_WORKSPACE_TAB_PERMISSIONS[tab].some((permission) =>
          permissionSet.has(permission)
        )
      )
      .map((tab) => tab)
  ];
}

export function getOrderWorkspaceChangeGuard(input: {
  changesLoaded: boolean;
  hasActiveChange: boolean;
  hasOrderChangeView: boolean;
}): { locked: boolean; waiting: boolean } {
  if (!input.hasOrderChangeView) {
    return { locked: false, waiting: false };
  }

  return {
    locked: input.changesLoaded && input.hasActiveChange,
    waiting: !input.changesLoaded
  };
}

export async function refreshActiveOrderWorkspaceTab(input: {
  activeTabRef: { current: OrderWorkspaceTabKey };
  refreshSummary: () => Promise<void>;
  refreshTab: (tab: OrderWorkspaceTabKey) => Promise<void>;
}): Promise<void> {
  await input.refreshSummary();
  await input.refreshTab(input.activeTabRef.current);
}

export function getOrderWorkspaceRecordIds(
  ...recordIds: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(recordIds.filter((recordId): recordId is string => Boolean(recordId)))
  );
}

export function getOrderWorkspaceFallbackRecordIds(
  targetRecordIds: readonly string[],
  resolvedRecordIds: readonly string[]
): string[] {
  const resolvedRecordIdSet = new Set(resolvedRecordIds);
  return getOrderWorkspaceRecordIds(...targetRecordIds).filter(
    (recordId) => !resolvedRecordIdSet.has(recordId)
  );
}

export function buildOrderWorkspaceRecordSelector(
  focus: string,
  escapeCssValue: (value: string) => string
): string {
  const escapedFocus = escapeCssValue(focus);
  return `[data-workspace-record="${escapedFocus}"],[data-workspace-record-alias="${escapedFocus}"]`;
}

export function getWorkspaceStatePresentation(
  state: OrderWorkspaceState
): { label: string; color: string } {
  return STATE_PRESENTATIONS[state];
}

export function getWorkspaceActionPresentation(
  actionCode: string
): { label: string; icon: string } | null {
  return isOrderWorkspaceActionCode(actionCode) ? ACTION_PRESENTATIONS[actionCode] : null;
}

function isOrderWorkspaceTabKey(value: string | null): value is OrderWorkspaceTabKey {
  return value !== null && ORDER_WORKSPACE_TAB_KEYS.has(value as OrderWorkspaceTabKey);
}

function isOrderWorkspaceActionCode(value: string): value is OrderWorkspaceActionCode {
  return Object.prototype.hasOwnProperty.call(ACTION_PRESENTATIONS, value);
}
