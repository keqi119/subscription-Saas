"use client";

import { Empty, Progress, Tabs, Tag } from "antd";

import {
  ENTITLEMENT_GRANT_SOURCE_LABELS,
  ENTITLEMENT_GRANT_STATUS_LABELS,
  ENTITLEMENT_TYPE_LABELS,
  ENTITLEMENT_UNIT_LABELS,
  labelOf
} from "../../../constants/labels";
import type { PortalEntitlementGrant, PortalEntitlementUsage } from "../../../lib/portal-types";
import { PortalEntitlementUsageRecords } from "./entitlement-records";
import {
  entitlementPeriodBucket,
  entitlementProgress,
  groupEntitlementGrants,
  isTextEntitlement,
  isUnavailableEntitlement,
  PORTAL_ENTITLEMENT_TYPES,
  type PortalEntitlementType,
  selectDefaultEntitlementType,
  shanghaiBusinessDateKey,
  sortEntitlementGrants
} from "./entitlement-view-model";
import styles from "./entitlement-overview.module.css";

export interface PortalEntitlementOverviewProps {
  grants: PortalEntitlementGrant[];
  todayKey?: string;
  usages: PortalEntitlementUsage[];
}

export interface PortalEntitlementTypePanelProps {
  grants: PortalEntitlementGrant[];
  todayKey: string;
  type: PortalEntitlementType;
  usages: PortalEntitlementUsage[];
}

const PERIOD_LABELS = {
  CURRENT: "当前期次",
  FUTURE: "未来期次",
  HISTORICAL: "历史期次"
} as const;

export function PortalEntitlementOverview({
  grants,
  todayKey = shanghaiBusinessDateKey(),
  usages
}: PortalEntitlementOverviewProps) {
  const groups = groupEntitlementGrants(grants, todayKey);
  const defaultType = selectDefaultEntitlementType(groups, todayKey);

  return (
    <Tabs
      className={styles.tabs}
      defaultActiveKey={defaultType}
      items={PORTAL_ENTITLEMENT_TYPES.map((type) => ({
        key: type,
        label: (
          <span className={styles.tabLabel}>
            {labelOf(ENTITLEMENT_TYPE_LABELS, type)}
            <span className={styles.tabCount} data-testid={`entitlement-tab-count-${type}`}>
              {groups[type].length}
            </span>
          </span>
        ),
        children: (
          <PortalEntitlementTypePanel
            grants={groups[type]}
            todayKey={todayKey}
            type={type}
            usages={usages}
          />
        )
      }))}
    />
  );
}

export function PortalEntitlementTypePanel({
  grants,
  todayKey,
  type,
  usages
}: PortalEntitlementTypePanelProps) {
  const typedGrants = sortEntitlementGrants(
    grants.filter((grant) => grant.entitlementType === type),
    todayKey
  );
  const typedUsages = usages.filter((usage) => usage.entitlementType === type);

  return (
    <div className={styles.typePanel}>
      {typedGrants.length === 0 ? (
        <Empty description={`暂无${labelOf(ENTITLEMENT_TYPE_LABELS, type)}`} />
      ) : (
        <div className={styles.cardGrid}>
          {typedGrants.map((grant) => (
            <EntitlementCard grant={grant} key={grant.grantId} todayKey={todayKey} />
          ))}
        </div>
      )}

      <section className={styles.usageSection}>
        <div className={styles.sectionHeading}>
          <h3>核销记录</h3>
          <span>仅显示当前权益类型</span>
        </div>
        <PortalEntitlementUsageRecords loading={false} rows={typedUsages} />
      </section>
    </div>
  );
}

function EntitlementCard({ grant, todayKey }: { grant: PortalEntitlementGrant; todayKey: string }) {
  const period = entitlementPeriodBucket(grant, todayKey);
  const progress = entitlementProgress(grant);
  const textEntitlement = isTextEntitlement(grant);
  const unavailable = isUnavailableEntitlement(grant);

  return (
    <article
      className={`${styles.entitlementCard} ${unavailable ? styles.unavailableCard : ""}`}
      data-period={period}
      data-progress={progress ?? undefined}
      data-status={grant.status}
      data-testid="portal-entitlement-card"
    >
      <header className={styles.cardHeader}>
        <div>
          <div className={styles.cardTags}>
            <Tag color={period === "CURRENT" ? "blue" : undefined}>{PERIOD_LABELS[period]}</Tag>
            <Tag>{labelOf(ENTITLEMENT_GRANT_STATUS_LABELS, grant.status)}</Tag>
          </div>
          <h3>{grant.name}</h3>
          <span className={styles.grantNo}>{grant.grantNo}</span>
        </div>
      </header>

      <div className={styles.availableAllowance}>
        <span>当前可用额度</span>
        <strong>
          {textEntitlement
            ? grant.status === "ACTIVE"
              ? "可使用"
              : "不可用"
            : formatEntitlementAmount(grant.remainingAmount, grant.unit)}
        </strong>
      </div>

      <dl className={styles.allowanceBreakdown}>
        <div>
          <dt>当期初始额度</dt>
          <dd>
            {textEntitlement ? "已发放" : formatEntitlementAmount(grant.totalAmount, grant.unit)}
          </dd>
        </div>
        <div>
          <dt>已核销额度</dt>
          <dd>
            {textEntitlement ? "不适用" : formatEntitlementAmount(grant.usedAmount, grant.unit)}
          </dd>
        </div>
      </dl>

      {progress !== null ? (
        <div className={styles.progressBlock}>
          <div>
            <span>核销进度</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress percent={progress} showInfo={false} size="small" />
        </div>
      ) : null}

      <footer className={styles.cardFooter}>
        <span>{`${grant.validFrom ?? "-"} 至 ${grant.validTo ?? "-"}`}</span>
        <span>{labelOf(ENTITLEMENT_GRANT_SOURCE_LABELS, grant.source)}</span>
      </footer>
    </article>
  );
}

function formatEntitlementAmount(value: number | null, unit: string): string {
  if (value === null) {
    return "-";
  }

  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: 2
  })} ${labelOf(ENTITLEMENT_UNIT_LABELS, unit)}`;
}
