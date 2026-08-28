"use client";

import { ArrowLeftOutlined, CheckOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getPortalRenewal,
  getPortalSubscriptionChange,
  PortalApiError,
  submitPortalRenewalDecision
} from "../../../../lib/portal-api";
import {
  getPortalRenewalNextAction,
  toPortalRenewalDetail
} from "../../../../lib/portal-renewal-view-model";
import type { PortalRenewalDetail } from "../../../../lib/portal-types";

export default function PortalRenewalDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [detail, setDetail] = useState<PortalRenewalDetail>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const decisionKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    setErrorMessage(undefined);
    try {
      const renewal = await getPortalRenewal(params.id);
      const change = renewal.changeOrderId
        ? await getPortalSubscriptionChange(renewal.changeOrderId).catch(() => null)
        : null;
      setDetail(toPortalRenewalDetail(renewal, change));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(
          `/portal/login?redirect=${encodeURIComponent(`/portal/renewals/${params.id}`)}`
        );
        return;
      }
      setErrorMessage(error instanceof PortalApiError ? error.message : "无法加载续订详情");
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  function decide(decision: "RENEW" | "EXPIRE") {
    if (!detail || detail.decision || submitting || !detail.allowedActions.includes(decision))
      return;
    modal.confirm({
      content:
        decision === "RENEW"
          ? "提交后平台将准备正式续期报价，后续仍需确认报价并签署补充协议。"
          : "提交后将按原合同到期结束并进入退车准备，不能再选择续订。",
      okButtonProps: { danger: decision === "EXPIRE" },
      okText: decision === "RENEW" ? "确认申请续订" : "确认到期结束",
      onOk: async () => {
        setSubmitting(true);
        try {
          const commandIdentity = `${detail.id}:${decision}:${detail.version}`;
          const idempotencyKey = decisionKeys.current.get(commandIdentity) ?? crypto.randomUUID();
          decisionKeys.current.set(commandIdentity, idempotencyKey);
          await submitPortalRenewalDecision(
            detail.id,
            { decision, version: detail.version },
            idempotencyKey
          );
          void message.success(decision === "RENEW" ? "续订申请已提交" : "到期结束决定已提交");
          await load();
        } catch (error) {
          if (error instanceof PortalApiError && error.status === 409) {
            void message.warning("续订状态已更新，页面将刷新最新结果");
            await load();
            return;
          }
          void message.error(error instanceof PortalApiError ? error.message : "无法提交到期决定");
        } finally {
          setSubmitting(false);
        }
      },
      title: decision === "RENEW" ? "申请续订" : "到期结束"
    });
  }

  if (loading && !detail) {
    return (
      <PageShell>
        <Flex justify="center" style={{ padding: 64 }}>
          <Spin />
        </Flex>
      </PageShell>
    );
  }

  if (!detail) {
    return (
      <PageShell>
        <Empty description={errorMessage ?? "续订安排不存在"}>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            重试
          </Button>
        </Empty>
      </PageShell>
    );
  }

  const action = getPortalRenewalNextAction(detail);
  return (
    <PageShell>
      <Flex align="center" justify="space-between" style={{ marginBottom: 18 }} wrap="wrap">
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/renewals")}>
          返回续订列表
        </Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </Flex>

      <Card style={{ marginBottom: 14 }}>
        <Flex align="flex-start" gap={16} justify="space-between" wrap="wrap">
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>
              {action.title}
            </Typography.Title>
            <Typography.Text type="secondary">
              订单 {detail.order.orderNo} · {detail.order.plateMasked ?? "车牌待补充"}
            </Typography.Text>
          </div>
          <Tag
            color={
              action.step === "EXTENDED" ? "green" : action.step === "RETURN" ? "orange" : "blue"
            }
          >
            {detail.status}
          </Tag>
        </Flex>
        <Alert
          description={action.helper}
          message="当前进度"
          showIcon
          style={{ marginTop: 16 }}
          type={
            action.step === "RETURN" ? "warning" : action.step === "EXTENDED" ? "success" : "info"
          }
        />
      </Card>

      <Card style={{ marginBottom: 14 }} title="合同期限">
        <Descriptions
          column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
          items={[
            { label: "当前合同开始日", children: formatDate(detail.segment.startDate) },
            { label: "当前合同到期日", children: formatDate(detail.segment.endDate) },
            {
              label: "续订完成期限",
              children: dayjs(detail.completionDeadlineAt).format("YYYY-MM-DD HH:mm")
            },
            { label: "当前月租", children: formatMoney(detail.segment.monthlyFeeAmount) }
          ]}
          size="small"
        />
      </Card>

      {!detail.decision ? (
        <Card style={{ marginBottom: 14 }} title="请选择到期安排">
          {!detail.featureAvailability.enabled ? (
            <Alert
              description="当前环境暂未开放续期申请；您仍可选择按原合同到期结束。"
              message="续期功能暂未开放"
              showIcon
              style={{ marginBottom: 12 }}
              type="warning"
            />
          ) : null}
          <Typography.Paragraph type="secondary">
            两个选择互斥且提交后不可切换。申请续订还需要完成报价确认、补充协议签署和归档。
          </Typography.Paragraph>
          <Space size={12} wrap>
            <Button
              disabled={!detail.allowedActions.includes("RENEW")}
              icon={<CheckOutlined />}
              loading={submitting}
              onClick={() => decide("RENEW")}
              type="primary"
            >
              申请续订
            </Button>
            <Button
              danger
              disabled={!detail.allowedActions.includes("EXPIRE")}
              icon={<StopOutlined />}
              loading={submitting}
              onClick={() => decide("EXPIRE")}
            >
              到期结束
            </Button>
          </Space>
        </Card>
      ) : null}

      <Card title="提醒记录">
        {detail.reminders.length ? (
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            {detail.reminders.map((reminder) => (
              <Flex key={reminder.slot} justify="space-between" wrap="wrap">
                <Typography.Text>
                  {reminder.slot} · {dayjs(reminder.scheduledAt).format("YYYY-MM-DD HH:mm")}
                </Typography.Text>
                <Tag>{reminder.status}</Tag>
              </Flex>
            ))}
          </Space>
        ) : (
          <Empty description="暂无提醒记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      {action.href && action.href !== `/portal/renewals/${detail.id}` ? (
        <Flex justify="flex-end" style={{ marginTop: 16 }}>
          <Button onClick={() => router.push(action.href!)} type="primary">
            继续处理
          </Button>
        </Flex>
      ) : null}
    </PageShell>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 920 }}>{children}</section>
    </main>
  );
}

function formatDate(value: string) {
  return dayjs(value).format("YYYY-MM-DD");
}

function formatMoney(value: string) {
  const cents = BigInt(value);
  return `¥${(cents / 100n).toLocaleString("zh-CN")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
