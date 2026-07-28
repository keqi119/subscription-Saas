import { Badge, Tabs } from "antd";
import type { ReactNode } from "react";

import type { OrderWorkspaceTabKey } from "../../lib/admin-order-workspace";

export type OrderWorkspaceSlots = Partial<Record<OrderWorkspaceTabKey, ReactNode>>;

export interface OrderWorkspaceTabBadge {
  attentionCount: number;
  count: number;
  tab: OrderWorkspaceTabKey;
}

export interface OrderWorkspaceProps {
  activeTab: OrderWorkspaceTabKey;
  onTabChange: (tab: OrderWorkspaceTabKey) => void;
  slots: OrderWorkspaceSlots;
  tabBadges?: readonly OrderWorkspaceTabBadge[];
  visibleTabs?: readonly OrderWorkspaceTabKey[];
}

const TAB_DEFINITIONS = [
  { key: "overview", label: "订单基本信息" },
  { key: "contract", label: "主合同及订阅套餐" },
  { key: "handover", label: "车辆交接" },
  { key: "entitlement", label: "订阅权益" },
  { key: "service", label: "用车中事务" },
  { key: "finance", label: "财务/收款核销" },
  { key: "change", label: "变更/历史快照" }
] as const satisfies ReadonlyArray<{ key: OrderWorkspaceTabKey; label: string }>;

export function OrderWorkspace({
  activeTab,
  onTabChange,
  slots,
  tabBadges = [],
  visibleTabs
}: Readonly<OrderWorkspaceProps>) {
  const visibleTabSet = visibleTabs ? new Set(visibleTabs) : null;
  const badgesByTab = new Map(tabBadges.map((badge) => [badge.tab, badge]));
  const tabs = TAB_DEFINITIONS.filter(({ key }) => visibleTabSet?.has(key) ?? true);
  const resolvedActiveTab = tabs.some(({ key }) => key === activeTab)
    ? activeTab
    : (tabs.find(({ key }) => key === "overview")?.key ?? tabs[0]?.key);

  return (
    <div data-order-workspace="true">
      <Tabs
        activeKey={resolvedActiveTab}
        animated={false}
        destroyOnHidden
        id="order-workspace-tabs"
        items={tabs.map(({ key, label }) => ({
          children:
            key === resolvedActiveTab ? (
              <section
                aria-label={`${label}内容`}
                data-workspace-active-content={key}
                style={{ minHeight: 240, paddingTop: 12 }}
              >
                {slots[key] ?? null}
              </section>
            ) : undefined,
          key,
          label: <TabLabel badge={badgesByTab.get(key)} label={label} />
        }))}
        onChange={(key) => onTabChange(key as OrderWorkspaceTabKey)}
        renderTabBar={(tabBarProps, DefaultTabBar) => (
          <div
            data-workspace-tab-scroll="true"
            style={{ overflowX: "auto", scrollbarGutter: "stable" }}
          >
            <DefaultTabBar {...tabBarProps} />
          </div>
        )}
        size="small"
        tabBarGutter={24}
      />
    </div>
  );
}

function TabLabel({
  badge,
  label
}: Readonly<{ badge?: OrderWorkspaceTabBadge; label: string }>) {
  const displayCount = badge?.attentionCount || badge?.count || 0;

  return (
    <span style={{ display: "inline-flex", gap: 6, whiteSpace: "nowrap" }}>
      <span>{label}</span>
      {displayCount > 0 ? (
        <Badge
          color={badge && badge.attentionCount > 0 ? "#fa8c16" : "#8c8c8c"}
          count={displayCount}
          overflowCount={99}
          size="small"
        />
      ) : null}
    </span>
  );
}
