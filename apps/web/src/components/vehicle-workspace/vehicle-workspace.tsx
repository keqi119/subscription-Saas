import { Breadcrumb, Space, Tabs } from "antd";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  VEHICLE_WORKSPACE_TAB_LABELS,
  type VehicleWorkspaceTabKey
} from "../../lib/admin-vehicle-workspace";
import { VehicleWorkspaceHeader } from "./vehicle-workspace-header";
import type { VehicleWorkspaceVehicle } from "./vehicle-workspace-types";

export interface VehicleWorkspaceProps {
  actions?: ReactNode;
  activeTab: VehicleWorkspaceTabKey;
  children?: ReactNode;
  onTabChange: (tab: VehicleWorkspaceTabKey) => void;
  vehicle: VehicleWorkspaceVehicle;
  visibleTabs: readonly VehicleWorkspaceTabKey[];
}

export function VehicleWorkspace({
  actions,
  activeTab,
  children,
  onTabChange,
  vehicle,
  visibleTabs
}: Readonly<VehicleWorkspaceProps>) {
  const tabs = visibleTabs.map((key) => ({
    key,
    label: VEHICLE_WORKSPACE_TAB_LABELS[key]
  }));
  const resolvedActiveTab = visibleTabs.includes(activeTab)
    ? activeTab
    : (visibleTabs[0] ?? activeTab);

  return (
    <Space data-vehicle-workspace="true" direction="vertical" size={16} style={{ display: "flex" }}>
      <Breadcrumb
        items={[
          { title: <Link href="/vehicles">返回车辆列表</Link> },
          { title: vehicle.vehicleNo }
        ]}
      />
      <VehicleWorkspaceHeader actions={actions} vehicle={vehicle} />
      <Tabs
        activeKey={resolvedActiveTab}
        animated={false}
        items={tabs}
        onChange={(key) => onTabChange(key as VehicleWorkspaceTabKey)}
        renderTabBar={(tabBarProps, DefaultTabBar) => (
          <div data-vehicle-workspace-tab-scroll="true" style={{ overflowX: "auto" }}>
            <DefaultTabBar {...tabBarProps} />
          </div>
        )}
      />
      <section
        aria-label={`${VEHICLE_WORKSPACE_TAB_LABELS[resolvedActiveTab]}内容`}
        data-vehicle-workspace-active-content={resolvedActiveTab}
      >
        {children}
      </section>
    </Space>
  );
}
