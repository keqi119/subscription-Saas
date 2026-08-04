"use client";

import { ArrowLeftOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, Modal, Spin, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildPortalAutoDebitView,
  type PortalAutoDebitView
} from "../../../lib/portal-auto-debit-view-model";
import {
  createPortalPaymentMandate,
  getPortalAutoDebitAvailability,
  getPortalDebitAttempts,
  getPortalPaymentMandates,
  PortalApiError,
  portalApiFetch,
  revokePortalPaymentMandate
} from "../../../lib/portal-api";
import type {
  PortalAutoDebitAvailability,
  PortalBillListItem,
  PortalDebitAttempt,
  PortalOrderListItem,
  PortalPagedResponse,
  PortalPaymentMandate
} from "../../../lib/portal-types";
import { PortalAutoDebitStatusCard } from "./auto-debit-status-card";
import styles from "./auto-debit.module.css";

interface OrderAutoDebitItem {
  attempt: PortalDebitAttempt | null;
  bill: PortalBillListItem | null;
  mandate: PortalPaymentMandate | null;
  order: PortalOrderListItem;
  view: PortalAutoDebitView;
}

export default function PortalAutoDebitPage() {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [availability, setAvailability] = useState<PortalAutoDebitAvailability>();
  const [orders, setOrders] = useState<PortalOrderListItem[]>([]);
  const [bills, setBills] = useState<PortalBillListItem[]>([]);
  const [mandates, setMandates] = useState<PortalPaymentMandate[]>([]);
  const [attempts, setAttempts] = useState<PortalDebitAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOrderId, setActingOrderId] = useState<string>();
  const [revokingMandateId, setRevokingMandateId] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextAvailability, orderResult, billResult, nextMandates, nextAttempts] =
        await Promise.all([
          getPortalAutoDebitAvailability(),
          portalApiFetch<PortalPagedResponse<PortalOrderListItem>>("/portal/orders?pageSize=100"),
          portalApiFetch<PortalPagedResponse<PortalBillListItem>>("/portal/bills?pageSize=100"),
          getPortalPaymentMandates(),
          getPortalDebitAttempts()
        ]);
      setAvailability(nextAvailability);
      setOrders(orderResult.items.filter((order) => order.orderStatus === "ACTIVE"));
      setBills(billResult.items);
      setMandates(nextMandates);
      setAttempts(nextAttempts);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/auto-debit")}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载自动扣款信息");
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo<OrderAutoDebitItem[]>(() => {
    if (!availability) {
      return [];
    }
    return orders.map((order) => {
      const mandate = mandates.find((item) => item.orderId === order.id) ?? null;
      const bill = selectPayableBill(bills.filter((item) => item.orderId === order.id));
      const attempt =
        attempts.find((item) => item.billId === bill?.billId) ??
        attempts.find((item) => item.orderId === order.id) ??
        null;
      return {
        attempt,
        bill,
        mandate,
        order,
        view: buildPortalAutoDebitView({ attempt, availability, bill, mandate })
      };
    });
  }, [attempts, availability, bills, mandates, orders]);

  function confirmEnrollment(item: OrderAutoDebitItem) {
    modal.confirm({
      content: (
        <div>
          <Typography.Paragraph>
            授权范围：仅用于订单 {item.order.orderNo} 的订阅月租及约定应收账单。
          </Typography.Paragraph>
          <Typography.Paragraph>
            系统将在账单到期日及约定重试日发起扣款。扣款失败时，您仍可主动支付。
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            点击“同意并开通”表示您确认授权范围；真实微信协议条款以商户能力开通后的签约页为准。
          </Typography.Text>
        </div>
      ),
      okText: "同意并开通",
      onOk: () => enroll(item.order.id),
      title: "确认自动扣款授权",
      cancelText: "暂不开通"
    });
  }

  async function enroll(orderId: string) {
    setActingOrderId(orderId);
    try {
      await createPortalPaymentMandate(orderId);
      void message.success("自动扣款授权已提交");
      await load();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法开通自动扣款");
      throw error;
    } finally {
      setActingOrderId(undefined);
    }
  }

  function confirmRevoke(mandate: PortalPaymentMandate) {
    Modal.confirm({
      cancelText: "取消",
      content: "关闭后，后续账单不会再自动扣款，您需要在我的账单中主动支付。",
      okButtonProps: { danger: true },
      okText: "确认关闭",
      onOk: () => revoke(mandate.id),
      title: "关闭自动扣款？"
    });
  }

  async function revoke(mandateId: string) {
    setRevokingMandateId(mandateId);
    try {
      await revokePortalPaymentMandate(mandateId);
      void message.success("自动扣款已关闭");
      await load();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法关闭自动扣款");
      throw error;
    } finally {
      setRevokingMandateId(undefined);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.container}>
        <div className={styles.pageHeader} style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: "12px 0 0" }}>
              自动扣款
            </Typography.Title>
            <Typography.Text type="secondary">管理订阅账单的自动扣款授权与扣款进度</Typography.Text>
          </div>
          <SafetyCertificateOutlined style={{ color: "#1677ff", fontSize: 32 }} />
        </div>

        {availability?.mode === "SIMULATION" ? (
          <Alert
            message="STAGING MOCK，不会发生真实扣款"
            showIcon
            style={{ marginBottom: 14 }}
            type="warning"
          />
        ) : null}

        {loading ? (
          <Flex justify="center" style={{ padding: 48 }}>
            <Spin />
          </Flex>
        ) : !availability ? (
          <Empty description="自动扣款信息暂不可用" />
        ) : items.length ? (
          <div className={styles.orderGrid}>
            {items.map((item) => (
              <div key={item.order.id}>
                <section className={styles.card}>
                  <Typography.Text type="secondary">订阅订单</Typography.Text>
                  <div className={styles.identifier}>
                    <Typography.Text strong>{item.order.orderNo}</Typography.Text>
                  </div>
                  <Typography.Text type="secondary">
                    {item.order.vehicleSummary?.displayName ?? "车辆待确认"}
                  </Typography.Text>
                  <div style={{ marginTop: 12 }}>
                    <Button
                      onClick={() => router.push(`/portal/auto-debit/${item.order.id}`)}
                      type="link"
                    >
                      查看授权与扣款记录
                    </Button>
                  </div>
                </section>
                <PortalAutoDebitStatusCard
                  enrollLoading={actingOrderId === item.order.id}
                  model={item.view}
                  onEnroll={() => confirmEnrollment(item)}
                  onPay={() =>
                    router.push(
                      item.bill
                        ? `/portal/bills/${item.bill.billId}`
                        : `/portal/bills?orderId=${encodeURIComponent(item.order.id)}`
                    )
                  }
                  onRevoke={item.mandate ? () => confirmRevoke(item.mandate!) : undefined}
                  revokeLoading={revokingMandateId === item.mandate?.id}
                />
              </div>
            ))}
          </div>
        ) : (
          <Empty description="暂无可管理自动扣款的生效订单" />
        )}
      </section>
    </main>
  );
}

function selectPayableBill(bills: PortalBillListItem[]) {
  return (
    bills
      .filter((bill) => bill.canPay)
      .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? ""))[0] ??
    bills[0] ??
    null
  );
}
