"use client";

import { ArrowLeftOutlined, CalendarOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Empty, Flex, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  getPortalSubscriptionChange,
  listPortalRenewals,
  PortalApiError
} from "../../../lib/portal-api";
import {
  getPortalRenewalNextAction,
  toPortalRenewalDetail
} from "../../../lib/portal-renewal-view-model";
import type { PortalRenewalDetail } from "../../../lib/portal-types";

export default function PortalRenewalsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [renewals, setRenewals] = useState<PortalRenewalDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(undefined);
    try {
      const rows = await listPortalRenewals();
      setRenewals(await Promise.all(rows.map(async (renewal) =>
        toPortalRenewalDetail(
          renewal,
          renewal.changeOrderId
            ? await getPortalSubscriptionChange(renewal.changeOrderId).catch(() => null)
            : null
        )
      )));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/renewals")}`);
        return;
      }
      const text = error instanceof PortalApiError ? error.message : "无法加载续订安排";
      setErrorMessage(text);
      void message.error(text);
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 920 }}>
        <Flex align="center" gap={12} justify="space-between" style={{ marginBottom: 20 }} wrap="wrap">
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/applications")} style={{ marginBottom: 12 }}>
              返回我的申请
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>续订与到期安排</Typography.Title>
            <Typography.Text type="secondary">查看当前合同期限、报价、签署及退车进度</Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Flex>

        {errorMessage ? (
          <Alert
            action={<Button onClick={() => void load()}>重试</Button>}
            description={errorMessage}
            message="加载失败"
            showIcon
            style={{ marginBottom: 16 }}
            type="error"
          />
        ) : null}

        {loading && renewals.length === 0 ? (
          <Flex justify="center" style={{ padding: 48 }}><Spin /></Flex>
        ) : renewals.length === 0 ? (
          <Empty description="暂无续订或到期安排" />
        ) : (
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            {renewals.map((renewal) => {
              const action = getPortalRenewalNextAction(renewal);
              return (
                <Card key={renewal.id} size="small">
                  <Flex align="flex-start" gap={18} justify="space-between" wrap="wrap">
                    <Space align="start">
                      <CalendarOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />
                      <Space orientation="vertical" size={5}>
                        <Space wrap>
                          <Typography.Text strong>{renewal.order.orderNo}</Typography.Text>
                          <Tag color={action.step === "EXTENDED" ? "green" : action.step === "RETURN" ? "orange" : "blue"}>
                            {action.title}
                          </Tag>
                        </Space>
                        <Typography.Text type="secondary">
                          {renewal.order.plateMasked ?? "车牌待补充"} · 当前合同到期日 {formatDate(renewal.segment.endDate)}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          续订完成期限 {dayjs(renewal.completionDeadlineAt).format("YYYY-MM-DD HH:mm")}
                        </Typography.Text>
                        <Typography.Text>{action.helper}</Typography.Text>
                      </Space>
                    </Space>
                    <Button
                      onClick={() => router.push(action.href ?? `/portal/renewals/${renewal.id}`)}
                      type="primary"
                    >
                      查看详情
                    </Button>
                  </Flex>
                </Card>
              );
            })}
          </Space>
        )}
      </section>
    </main>
  );
}

function formatDate(value: string) {
  return dayjs(value).format("YYYY-MM-DD");
}
