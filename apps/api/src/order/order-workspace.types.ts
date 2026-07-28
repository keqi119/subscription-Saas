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

export type OrderWorkspaceGuideCategory = Exclude<OrderWorkspaceTabKey, "overview">;

export type OrderWorkspaceTarget = {
  actionCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
};

export type OrderWorkspaceGuideItem = {
  category: OrderWorkspaceGuideCategory;
  state: OrderWorkspaceState;
  priority: number;
  actionCode: string | null;
  reasonCode: string;
  targetTab: OrderWorkspaceGuideCategory;
  targetRecordId: string | null;
  blocking: boolean;
  updatedAt: string | null;
  additionalCount: number;
};

export type OrderWorkspaceSummary = {
  asOf: string;
  header: {
    orderId: string;
    orderNo: string;
    orderStatus: string;
    customerLabel: string;
    currentVehicleLabel: string | null;
    ownerLabel: string | null;
  };
  guidance: OrderWorkspaceGuideItem[];
  primaryAction: OrderWorkspaceTarget | null;
  tabBadges: Array<{
    tab: OrderWorkspaceTabKey;
    count: number;
    attentionCount: number;
  }>;
  recentActivity: Array<{
    id: string;
    category: OrderWorkspaceGuideCategory | "order";
    title: string;
    occurredAt: string;
    targetTab: OrderWorkspaceTabKey;
    targetRecordId: string | null;
  }>;
};
