"use client";

import { Alert, Button } from "antd";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";

import {
  isVehicleCapitalSectionKey,
  isVehicleListingSectionKey,
  isVehicleValuationSectionKey,
  type VehicleWorkspaceLocation,
  type VehicleWorkspaceTabKey
} from "../../lib/admin-vehicle-workspace";
import { VehicleCapitalTab } from "./vehicle-capital-tab";
import { VehicleDocumentsTab } from "./vehicle-documents-tab";
import { VehicleInsuranceBatteryTab } from "./vehicle-insurance-battery-tab";
import { VehicleListingTab } from "./vehicle-listing-tab";
import { VehicleOverviewTab } from "./vehicle-overview-tab";
import { VehicleValuationTab } from "./vehicle-valuation-tab";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface VehicleWorkspaceContentProps extends VehicleWorkspaceTabProps {
  activeTab: VehicleWorkspaceTabKey;
  onSectionChange: (section: NonNullable<VehicleWorkspaceLocation["section"]>) => void;
  section?: VehicleWorkspaceLocation["section"];
  visibleTabs: readonly VehicleWorkspaceTabKey[];
}

export function VehicleWorkspaceContent({
  activeTab,
  onSectionChange,
  onVehicleChanged,
  permissions,
  section,
  vehicle,
  visibleTabs
}: Readonly<VehicleWorkspaceContentProps>) {
  const [visitedTabs, setVisitedTabs] = useState<Set<VehicleWorkspaceTabKey>>(
    () => new Set([activeTab])
  );
  const [retryCounts, setRetryCounts] = useState<Partial<Record<VehicleWorkspaceTabKey, number>>>({});

  useEffect(() => {
    setVisitedTabs((current) => {
      if (current.has(activeTab)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeTab);
      return next;
    });
  }, [activeTab]);

  const sharedProps: VehicleWorkspaceTabProps = {
    onVehicleChanged,
    permissions,
    vehicle
  };

  function renderTab(tab: VehicleWorkspaceTabKey) {
    switch (tab) {
      case "overview":
        return <VehicleOverviewTab {...sharedProps} />;
      case "documents":
        return <VehicleDocumentsTab {...sharedProps} />;
      case "insurance-battery":
        return <VehicleInsuranceBatteryTab {...sharedProps} />;
      case "listing":
        return (
          <VehicleListingTab
            {...sharedProps}
            activeSection={isVehicleListingSectionKey(section) ? section : "overview"}
            onSectionChange={onSectionChange}
          />
        );
      case "valuation":
        return (
          <VehicleValuationTab
            {...sharedProps}
            activeSection={isVehicleValuationSectionKey(section) ? section : "overview"}
            onSectionChange={onSectionChange}
          />
        );
      case "capital":
        return (
          <VehicleCapitalTab
            {...sharedProps}
            activeSection={isVehicleCapitalSectionKey(section) ? section : "overview"}
            onSectionChange={onSectionChange}
          />
        );
    }
  }

  return visibleTabs
    .filter((tab) => visitedTabs.has(tab))
    .map((tab) => (
      <section
        aria-label={`${tab} workspace`}
        hidden={tab !== activeTab}
        key={tab}
      >
        <VehicleTabErrorBoundary
          key={`${tab}:${retryCounts[tab] ?? 0}`}
          onRetry={() =>
            setRetryCounts((current) => ({
              ...current,
              [tab]: (current[tab] ?? 0) + 1
            }))
          }
        >
          {renderTab(tab)}
        </VehicleTabErrorBoundary>
      </section>
    ));
}

class VehicleTabErrorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("vehicle workspace tab failed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <Alert
        action={<Button onClick={this.props.onRetry}>重试当前板块</Button>}
        description={this.state.error.message}
        message="当前车辆板块加载失败"
        showIcon
        type="error"
      />
    );
  }
}
