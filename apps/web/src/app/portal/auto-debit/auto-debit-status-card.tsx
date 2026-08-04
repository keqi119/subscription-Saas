"use client";

import { Alert, Button, Tag, Typography } from "antd";
import dayjs from "dayjs";

import type { PortalAutoDebitView } from "../../../lib/portal-auto-debit-view-model";
import styles from "./auto-debit.module.css";

export function PortalAutoDebitStatusCard({
  enrollLoading = false,
  model,
  onEnroll,
  onPay,
  onRevoke,
  revokeLoading = false
}: {
  enrollLoading?: boolean;
  model: PortalAutoDebitView;
  onEnroll?: () => void;
  onPay?: () => void;
  onRevoke?: () => void;
  revokeLoading?: boolean;
}) {
  return (
    <section className={styles.card} data-testid="portal-auto-debit-status">
      <div className={styles.statusHeader}>
        <div className={styles.titleGroup}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {model.title}
          </Typography.Title>
        </div>
        <Tag color={toneColor(model.tone)}>{stateLabel(model.state)}</Tag>
      </div>
      <Typography.Paragraph className={styles.description} style={{ margin: "12px 0 0" }}>
        {model.description}
      </Typography.Paragraph>
      {model.nextActionAt ? (
        <div className={styles.nextAction}>
          <Typography.Text type="secondary">下一次计划处理</Typography.Text>
          <div>
            <Typography.Text strong>
              {dayjs(model.nextActionAt).format("YYYY-MM-DD HH:mm")}
            </Typography.Text>
          </div>
        </div>
      ) : null}
      <Alert className={styles.helper} message={model.helper} showIcon type={model.tone} />
      <div className={styles.actions}>
        {model.canEnroll && onEnroll ? (
          <Button loading={enrollLoading} onClick={onEnroll} type="primary">
            开通自动扣款
          </Button>
        ) : null}
        {model.canPay && onPay ? <Button onClick={onPay}>立即支付</Button> : null}
        {model.canRevoke && onRevoke ? (
          <Button danger loading={revokeLoading} onClick={onRevoke}>
            关闭自动扣款
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function toneColor(tone: PortalAutoDebitView["tone"]) {
  return { error: "red", info: "blue", success: "green", warning: "orange" }[tone];
}

function stateLabel(state: PortalAutoDebitView["state"]) {
  return {
    ACTIVE: "已开通",
    DISABLED: "暂未开放",
    ENDED: "未生效",
    FAILED_FINAL: "需主动支付",
    NOT_ENROLLED: "未开通",
    PROCESSING: "处理中",
    RETRY_SCHEDULED: "待重试"
  }[state];
}
