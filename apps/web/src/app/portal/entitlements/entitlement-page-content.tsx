"use client";

import { Alert, Button, Skeleton } from "antd";

import type { PortalEntitlementGrant, PortalEntitlementUsage } from "../../../lib/portal-types";
import { PortalEntitlementOverview } from "./entitlement-overview";
import styles from "./entitlement-page-content.module.css";

export interface PortalEntitlementPageContentProps {
  error: string | null;
  grants: PortalEntitlementGrant[];
  loading: boolean;
  onRetry: () => void;
  todayKey?: string;
  usages: PortalEntitlementUsage[];
}

export function PortalEntitlementPageContent({
  error,
  grants,
  loading,
  onRetry,
  todayKey,
  usages
}: PortalEntitlementPageContentProps) {
  if (loading) {
    return (
      <section className={styles.statePanel}>
        <span className={styles.stateLabel}>正在加载权益</span>
        <Skeleton active paragraph={{ rows: 5 }} title />
      </section>
    );
  }

  if (error) {
    return (
      <Alert
        action={
          <Button onClick={onRetry} size="small" type="primary">
            重新加载
          </Button>
        }
        description={error}
        message="权益信息加载失败"
        showIcon
        type="error"
      />
    );
  }

  return (
    <section className={styles.overviewPanel}>
      <PortalEntitlementOverview grants={grants} todayKey={todayKey} usages={usages} />
    </section>
  );
}
