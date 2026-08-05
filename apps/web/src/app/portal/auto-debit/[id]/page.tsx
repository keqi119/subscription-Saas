"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Empty, Flex, Modal, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildPortalAutoDebitView } from "../../../../lib/portal-auto-debit-view-model";
import {
  createPortalPaymentMandate,
  getPortalAutoDebitAvailability,
  getPortalDebitAttempts,
  getPortalPaymentMandates,
  PortalApiError,
  portalApiFetch,
  revokePortalPaymentMandate
} from "../../../../lib/portal-api";
import type {
  PortalAutoDebitAvailability,
  PortalBillListItem,
  PortalDebitAttempt,
  PortalOrderListItem,
  PortalPagedResponse,
  PortalPaymentMandate
} from "../../../../lib/portal-types";
import { PortalAutoDebitStatusCard } from "../auto-debit-status-card";
import styles from "../auto-debit.module.css";

export default function PortalAutoDebitDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [availability, setAvailability] = useState<PortalAutoDebitAvailability>();
  const [order, setOrder] = useState<PortalOrderListItem>();
  const [bills, setBills] = useState<PortalBillListItem[]>([]);
  const [mandates, setMandates] = useState<PortalPaymentMandate[]>([]);
  const [attempts, setAttempts] = useState<PortalDebitAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) {
      return;
    }
    setLoading(true);
    try {
      const [nextAvailability, orderResult, billResult, nextMandates, nextAttempts] =
        await Promise.all([
          getPortalAutoDebitAvailability(),
          portalApiFetch<PortalPagedResponse<PortalOrderListItem>>("/portal/orders?pageSize=100"),
          portalApiFetch<PortalPagedResponse<PortalBillListItem>>(
            `/portal/bills?orderId=${encodeURIComponent(params.id)}&pageSize=100`
          ),
          getPortalPaymentMandates(params.id),
          getPortalDebitAttempts({ orderId: params.id })
        ]);
      setAvailability(nextAvailability);
      setOrder(orderResult.items.find((item) => item.id === params.id));
      setBills(billResult.items);
      setMandates(nextMandates);
      setAttempts(nextAttempts);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(
          `/portal/login?redirect=${encodeURIComponent(`/portal/auto-debit/${params.id}`)}`
        );
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载自动扣款详情");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const mandate = mandates[0] ?? null;
  const bill = useMemo(() => bills.find((item) => item.canPay) ?? bills[0] ?? null, [bills]);
  const latestAttempt =
    attempts.find((item) => item.billId === bill?.billId) ?? attempts[0] ?? null;
  const model = availability
    ? buildPortalAutoDebitView({ attempt: latestAttempt, availability, bill, mandate })
    : null;

  async function enroll() {
    if (!order) {
      return;
    }
    setActing(true);
    try {
      await createPortalPaymentMandate(order.id);
      void message.success("自动扣款授权已提交");
      await load();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法开通自动扣款");
    } finally {
      setActing(false);
    }
  }

  function confirmEnroll() {
    Modal.confirm({
      cancelText: "暂不开通",
      content: "授权仅用于本订阅订单约定应收账单；主动支付始终可用。",
      okText: "同意并开通",
      onOk: enroll,
      title: "确认自动扣款授权"
    });
  }

  function confirmRevoke() {
    if (!mandate) {
      return;
    }
    Modal.confirm({
      cancelText: "取消",
      content: "关闭后，后续账单需在我的账单中主动支付。",
      okButtonProps: { danger: true },
      okText: "确认关闭",
      onOk: async () => {
        setActing(true);
        try {
          await revokePortalPaymentMandate(mandate.id);
          void message.success("自动扣款已关闭");
          await load();
        } finally {
          setActing(false);
        }
      },
      title: "关闭自动扣款？"
    });
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin />
        </Flex>
      </main>
    );
  }

  if (!order || !model) {
    return (
      <main className={styles.page}>
        <Empty description="自动扣款详情不存在" />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.container}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/auto-debit")}>
          返回自动扣款
        </Button>
        <Typography.Title level={2} style={{ marginBottom: 4 }}>
          授权详情
        </Typography.Title>
        <Typography.Text className={styles.identifier} type="secondary">
          订单 {order.orderNo}
        </Typography.Text>

        <div style={{ marginTop: 16 }}>
          <PortalAutoDebitStatusCard
            enrollLoading={acting}
            model={model}
            onEnroll={confirmEnroll}
            onPay={() =>
              router.push(
                bill ? `/portal/bills/${bill.billId}` : `/portal/bills?orderId=${order.id}`
              )
            }
            onRevoke={mandate ? confirmRevoke : undefined}
            revokeLoading={acting}
          />
        </div>

        <section className={styles.card}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            授权范围
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "所属订单", children: order.orderNo },
              { label: "扣款范围", children: "本订阅订单约定的月租及应收账单" },
              {
                label: "授权状态",
                children: mandate ? mandateStatusLabel(mandate.status) : "未授权"
              },
              { label: "签约时间", children: formatTime(mandate?.signedAt) },
              { label: "生效时间", children: formatTime(mandate?.effectiveAt) },
              { label: "到期时间", children: formatTime(mandate?.expiresAt) }
            ]}
          />
        </section>

        <section className={styles.card}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            扣款记录
          </Typography.Title>
          {attempts.length ? (
            <div className={styles.attemptList}>
              {attempts.map((attempt) => (
                <div className={styles.attemptItem} key={attempt.id}>
                  <Flex align="center" gap={8} justify="space-between" wrap="wrap">
                    <Typography.Text strong>{formatMoney(attempt.requestedAmount)}</Typography.Text>
                    <Tag color={attemptTone(attempt.status)}>{attemptLabel(attempt.status)}</Tag>
                  </Flex>
                  <Typography.Text type="secondary">
                    {retrySlotLabel(attempt.retrySlot)} · {formatTime(attempt.createdAt)}
                  </Typography.Text>
                </div>
              ))}
            </div>
          ) : (
            <Empty description="暂无扣款记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </section>
      </section>
    </main>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function formatMoney(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${(amount / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })} 元`
    : "-";
}

function mandateStatusLabel(status: PortalPaymentMandate["status"]) {
  return {
    ACTIVE: "已开通",
    EXPIRED: "已过期",
    FAILED: "未生效",
    PENDING: "确认中",
    REVOKED: "已关闭",
    SUSPENDED: "已暂停"
  }[status];
}

function attemptLabel(status: PortalDebitAttempt["status"]) {
  return {
    CANCELLED: "已取消",
    CREATED: "待提交",
    FAILED_FINAL: "扣款失败",
    FAILED_RETRYABLE: "待重试",
    PROCESSING: "处理中",
    SUBMITTING: "提交中",
    SUCCEEDED: "扣款成功",
    UNKNOWN: "结果确认中"
  }[status];
}

function attemptTone(status: PortalDebitAttempt["status"]) {
  if (status === "SUCCEEDED") return "green";
  if (status === "FAILED_FINAL") return "red";
  if (status === "FAILED_RETRYABLE") return "orange";
  return "blue";
}

function retrySlotLabel(slot: PortalDebitAttempt["retrySlot"]) {
  return { D1: "D+1 重试", D3: "D+3 最后重试", DUE: "到期日扣款", MANUAL: "人工发起" }[slot];
}
