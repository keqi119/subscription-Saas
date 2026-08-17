"use client";

import { FileTextOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Button, Tag } from "antd";
import dayjs from "dayjs";

import { BILL_STATUS_LABELS, BILL_TYPE_LABELS, labelOf } from "../../../constants/labels";
import type { PortalBillListItem } from "../../../lib/portal-types";
import styles from "./portal-bill-card.module.css";

export function PortalBillCard({
  bill,
  onDetails,
  onPay,
  paying
}: {
  bill: PortalBillListItem;
  onDetails: (bill: PortalBillListItem) => void;
  onPay: (bill: PortalBillListItem) => void;
  paying: boolean;
}) {
  return (
    <article className={styles.card} data-testid="portal-bill-card">
      <div className={styles.main}>
        <FileTextOutlined aria-hidden className={styles.icon} />
        <div className={styles.content}>
          <div className={styles.billNumber} data-testid="portal-bill-number">
            {bill.billNo}
          </div>
          <div className={styles.metaGrid}>
            <BillMeta label="订单">
              <span className={styles.identifier} data-testid="portal-bill-order-number">
                {bill.orderNo}
              </span>
            </BillMeta>
            <BillMeta label="到期">{formatPortalBillDate(bill.dueDate)}</BillMeta>
            <BillMeta label="应付">{formatPortalBillMoney(bill.amount)}</BillMeta>
            <BillMeta label="待付">{formatPortalBillMoney(bill.remainingAmount)}</BillMeta>
          </div>
          <div className={styles.tags}>
            <Tag color={billStatusTone(bill.billStatus)}>
              {labelOf(BILL_STATUS_LABELS, bill.billStatus)}
            </Tag>
            <Tag>{labelOf(BILL_TYPE_LABELS, bill.billType)}</Tag>
          </div>
        </div>
      </div>
      <div className={styles.actions} data-testid="portal-bill-actions">
        {bill.canPay ? (
          <Button
            className={styles.actionButton}
            icon={<PayCircleOutlined />}
            loading={paying}
            onClick={() => onPay(bill)}
            type="primary"
          >
            去支付
          </Button>
        ) : null}
        <Button className={styles.actionButton} onClick={() => onDetails(bill)}>
          查看详情
        </Button>
      </div>
    </article>
  );
}

function BillMeta({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className={styles.metaRow}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{children}</span>
    </div>
  );
}

export function formatPortalBillMoney(amount?: number | null) {
  return amount === null || amount === undefined
    ? "-"
    : `${(amount / 100).toLocaleString("zh-CN", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
      })} 元`;
}

export function formatPortalBillDate(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD") : "-";
}

function billStatusTone(status: string) {
  return (
    {
      CANCELLED: "default",
      OVERDUE: "red",
      PAID: "green",
      PARTIALLY_PAID: "gold",
      PENDING: "orange"
    }[status] ?? "blue"
  );
}
