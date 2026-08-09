"use client";

import { Empty, Spin, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";

import {
  ENTITLEMENT_TYPE_LABELS,
  ENTITLEMENT_UNIT_LABELS,
  ENTITLEMENT_USAGE_SOURCE_LABELS,
  ENTITLEMENT_USAGE_STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import type { PortalEntitlementUsage } from "../../../lib/portal-types";
import styles from "./entitlement-records.module.css";

interface PortalEntitlementUsageRecordsProps {
  loading: boolean;
  rows: PortalEntitlementUsage[];
}

export function PortalEntitlementUsageRecords({
  loading,
  rows
}: PortalEntitlementUsageRecordsProps) {
  return (
    <>
      <div className={styles.desktopTable}>
        <Table
          columns={usageColumns}
          dataSource={rows}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无使用记录" /> }}
          pagination={false}
          rowKey="usageId"
          size="small"
        />
      </div>
      <div className={styles.mobileCards}>
        <Spin spinning={loading}>
          {rows.length === 0 ? (
            <Empty description="暂无使用记录" />
          ) : (
            <div className={styles.cardList}>
              {rows.map((row) => (
                <article
                  className={styles.card}
                  data-testid="portal-entitlement-usage-card"
                  key={row.usageId}
                >
                  <div className={styles.cardHeader}>
                    <strong>{row.grantName}</strong>
                    <Tag>{labelOf(ENTITLEMENT_USAGE_STATUS_LABELS, row.status)}</Tag>
                  </div>
                  <div className={styles.primaryValue}>
                    {formatEntitlementAmount(row.amount, row.unit)}
                    <span>本次使用</span>
                  </div>
                  <RecordRow
                    label="类型"
                    value={labelOf(ENTITLEMENT_TYPE_LABELS, row.entitlementType)}
                  />
                  <RecordRow
                    label="来源"
                    value={labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, row.source)}
                  />
                  <RecordRow label="发生时间" value={formatTime(row.occurredAt)} />
                  <RecordRow label="使用编号" machine value={row.usageNo} />
                </article>
              ))}
            </div>
          )}
        </Spin>
      </div>
    </>
  );
}

function RecordRow({
  label,
  machine = false,
  value
}: {
  label: string;
  machine?: boolean;
  value: string;
}) {
  return (
    <div className={styles.recordRow}>
      <span className={styles.recordLabel}>{label}</span>
      <span className={machine ? styles.machineValue : styles.recordValue}>{value}</span>
    </div>
  );
}

const usageColumns: ColumnsType<PortalEntitlementUsage> = [
  { dataIndex: "grantName", title: "权益" },
  {
    dataIndex: "amount",
    render: (_value: number, row) => formatEntitlementAmount(row.amount, row.unit),
    title: "使用量"
  },
  {
    dataIndex: "status",
    render: (value: string) => labelOf(ENTITLEMENT_USAGE_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "source",
    render: (value: string) => labelOf(ENTITLEMENT_USAGE_SOURCE_LABELS, value),
    title: "来源"
  },
  {
    dataIndex: "occurredAt",
    render: (value: string | null) => formatTime(value),
    title: "发生时间"
  }
];

function formatEntitlementAmount(value: number | null, unit: string) {
  if (unit === "TEXT") {
    return labelOf(ENTITLEMENT_UNIT_LABELS, unit);
  }
  if (value === null) {
    return "-";
  }
  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: 2
  })} ${labelOf(ENTITLEMENT_UNIT_LABELS, unit)}`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
