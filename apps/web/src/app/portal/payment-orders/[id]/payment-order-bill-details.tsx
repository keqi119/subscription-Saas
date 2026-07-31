"use client";

import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";

import {
  BILL_STATUS_LABELS,
  BILL_TYPE_LABELS,
  labelOf
} from "../../../../constants/labels";
import type { PortalPaymentOrderItem } from "../../../../lib/portal-types";
import styles from "./payment-order-bill-details.module.css";

const columns: ColumnsType<PortalPaymentOrderItem> = [
  { dataIndex: "billNo", title: "账单编号", width: 210 },
  {
    dataIndex: "billType",
    render: (value: string) => labelOf(BILL_TYPE_LABELS, value),
    title: "类型",
    width: 110
  },
  {
    dataIndex: "billStatus",
    render: (value: string) => labelOf(BILL_STATUS_LABELS, value),
    title: "状态",
    width: 100
  },
  { dataIndex: "amount", render: formatPortalMoney, title: "应付", width: 100 },
  { dataIndex: "remainingAmount", render: formatPortalMoney, title: "待付", width: 100 },
  { dataIndex: "dueDate", render: formatPortalTime, title: "到期日", width: 150 }
];

export function PaymentOrderBillDetails({ items }: { items: PortalPaymentOrderItem[] }) {
  return (
    <>
      <div className={styles.desktop} data-testid="payment-order-bills-desktop">
        <Table
          columns={columns}
          dataSource={items}
          pagination={false}
          rowKey="id"
          scroll={{ x: 770 }}
          size="small"
        />
      </div>
      <div className={styles.mobile} data-testid="payment-order-bills-mobile">
        {items.map((item) => (
          <article className={styles.card} key={item.id}>
            <BillRow label="账单编号" value={item.billNo} wrap />
            <BillRow label="类型" value={labelOf(BILL_TYPE_LABELS, item.billType)} />
            <BillRow label="状态" value={labelOf(BILL_STATUS_LABELS, item.billStatus)} />
            <BillRow label="应付" value={formatPortalMoney(item.amount)} />
            <BillRow label="待付" value={formatPortalMoney(item.remainingAmount)} />
            <BillRow label="到期日" value={formatPortalTime(item.dueDate)} />
          </article>
        ))}
      </div>
    </>
  );
}

function BillRow({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={wrap ? styles.wrappingValue : styles.value}>{value}</span>
    </div>
  );
}

export function formatPortalMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
      })} 元`;
}

export function formatPortalTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
