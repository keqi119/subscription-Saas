"use client";

import { Empty, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";

import {
  PAYMENT_CHANNEL_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_ORDER_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  labelOf
} from "../../../../constants/labels";
import type { PortalBillDetail } from "../../../../lib/portal-types";
import styles from "./bill-records.module.css";

type PaymentOrderRow = PortalBillDetail["paymentOrders"][number];
type WriteOffRow = PortalBillDetail["writeOffs"][number];

export function PortalPaymentOrderRecords({ rows }: { rows: PaymentOrderRow[] }) {
  return (
    <>
      <div className={styles.desktopTable}>
        <Table
          columns={paymentOrderColumns}
          dataSource={rows}
          locale={{ emptyText: <Empty description="暂无支付单" /> }}
          pagination={false}
          rowKey="paymentOrderId"
          size="small"
        />
      </div>
      <div className={styles.mobileCards}>
        {rows.length === 0 ? (
          <Empty description="暂无支付单" />
        ) : (
          <div className={styles.cardList}>
            {rows.map((row) => (
              <article
                className={styles.card}
                data-testid="portal-payment-order-card"
                key={row.paymentOrderId}
              >
                <div className={styles.cardHeader}>
                  <strong className={styles.machineValue}>{row.paymentOrderNo}</strong>
                  <Tag>{labelOf(PAYMENT_ORDER_STATUS_LABELS, row.paymentStatus)}</Tag>
                </div>
                <div className={styles.primaryValue}>
                  {formatMoney(row.paidAmount)}
                  <span>已付金额</span>
                </div>
                <RecordRow
                  label="支付渠道"
                  value={labelOf(PAYMENT_CHANNEL_LABELS, row.paymentChannel)}
                />
                <RecordRow label="支付时间" value={formatTime(row.paidAt)} />
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function PortalWriteOffRecords({ rows }: { rows: WriteOffRow[] }) {
  return (
    <>
      <div className={styles.desktopTable}>
        <Table
          columns={writeOffColumns}
          dataSource={rows}
          locale={{ emptyText: <Empty description="暂无核销记录" /> }}
          pagination={false}
          rowKey="writeOffId"
          size="small"
        />
      </div>
      <div className={styles.mobileCards}>
        {rows.length === 0 ? (
          <Empty description="暂无核销记录" />
        ) : (
          <div className={styles.cardList}>
            {rows.map((row) => (
              <article
                className={styles.card}
                data-testid="portal-write-off-card"
                key={row.writeOffId}
              >
                <div className={styles.cardHeader}>
                  <strong className={styles.machineValue}>{row.paymentNo}</strong>
                  <Tag>{labelOf(PAYMENT_STATUS_LABELS, row.paymentStatus)}</Tag>
                </div>
                <div className={styles.primaryValue}>
                  {formatMoney(row.writeOffAmount)}
                  <span>核销金额</span>
                </div>
                <RecordRow
                  label="收款方式"
                  value={labelOf(PAYMENT_METHOD_LABELS, row.paymentMethod)}
                />
                <RecordRow label="核销时间" value={formatTime(row.writeOffAt)} />
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RecordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.recordRow}>
      <span className={styles.recordLabel}>{label}</span>
      <span className={styles.recordValue}>{value}</span>
    </div>
  );
}

const paymentOrderColumns: ColumnsType<PaymentOrderRow> = [
  { dataIndex: "paymentOrderNo", title: "支付单号" },
  {
    dataIndex: "paymentChannel",
    render: (value: string) => labelOf(PAYMENT_CHANNEL_LABELS, value),
    title: "渠道"
  },
  {
    dataIndex: "paymentStatus",
    render: (value: string) => labelOf(PAYMENT_ORDER_STATUS_LABELS, value),
    title: "状态"
  },
  {
    dataIndex: "paidAmount",
    render: (value: number) => formatMoney(value),
    title: "已付"
  },
  {
    dataIndex: "paidAt",
    render: (value: string | null) => formatTime(value),
    title: "支付时间"
  }
];

const writeOffColumns: ColumnsType<WriteOffRow> = [
  { dataIndex: "paymentNo", title: "收款编号" },
  {
    dataIndex: "paymentMethod",
    render: (value: string) => labelOf(PAYMENT_METHOD_LABELS, value),
    title: "收款方式"
  },
  {
    dataIndex: "writeOffAmount",
    render: (value: number) => formatMoney(value),
    title: "核销金额"
  },
  {
    dataIndex: "writeOffAt",
    render: (value: string | null) => formatTime(value),
    title: "核销时间"
  }
];

function formatMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
      })} 元`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
