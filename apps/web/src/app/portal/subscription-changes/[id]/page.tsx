"use client";

import { ArrowLeftOutlined, CheckOutlined, FilePdfOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, Descriptions, Empty, Flex, Form, Input, Modal, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  confirmPortalRenewalQuote,
  getPortalSubscriptionChange,
  PortalApiError,
  rejectPortalRenewalQuote
} from "../../../../lib/portal-api";
import type { PortalSubscriptionChange } from "../../../../lib/portal-types";

interface RejectFormValues {
  reason: string;
}

export default function PortalSubscriptionChangeDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [rejectForm] = Form.useForm<RejectFormValues>();
  const [change, setChange] = useState<PortalSubscriptionChange>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const loadChange = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    setErrorMessage(undefined);
    try {
      setChange(await getPortalSubscriptionChange(params.id));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/subscription-changes/${params.id}`)}`);
        return;
      }
      setErrorMessage(error instanceof PortalApiError ? error.message : "无法加载续期变更");
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void loadChange();
  }, [loadChange]);

  async function confirmQuote() {
    if (!change?.currentQuote || submitting) return;
    const currentQuote = change.currentQuote;
    modal.confirm({
      content: `您将确认报价 ${currentQuote.quoteNo}（revision ${currentQuote.revision}），月租 ${formatMoney(currentQuote.monthlyFeeAmount)}。`,
      okText: "确认当前报价",
      onOk: async () => {
        setSubmitting(true);
        try {
          await confirmPortalRenewalQuote(change.id, {
            quoteId: currentQuote.id,
            revision: currentQuote.revision,
            version: change.version
          });
          void message.success("续期报价已确认");
          await loadChange();
        } catch (error) {
          if (error instanceof PortalApiError && error.status === 409) {
            void message.warning("报价已更新或状态已变化，页面将刷新最新 revision");
            await loadChange();
            return;
          }
          void message.error(error instanceof PortalApiError ? error.message : "无法确认续期报价");
        } finally {
          setSubmitting(false);
        }
      },
      title: "确认续期报价"
    });
  }

  async function rejectQuote() {
    if (!change?.currentQuote || submitting) return;
    const { reason } = await rejectForm.validateFields();
    const currentQuote = change.currentQuote;
    setSubmitting(true);
    try {
      await rejectPortalRenewalQuote(change.id, {
        quoteId: currentQuote.id,
        reason: reason.trim(),
        revision: currentQuote.revision,
        version: change.version
      });
      setRejectOpen(false);
      rejectForm.resetFields();
      void message.success("已拒绝当前报价，运营将看到拒绝原因");
      await loadChange();
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 409) {
        setRejectOpen(false);
        void message.warning("报价已更新或状态已变化，页面将刷新最新 revision");
        await loadChange();
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法拒绝续期报价");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !change) {
    return <PageShell><Flex justify="center" style={{ padding: 64 }}><Spin /></Flex></PageShell>;
  }

  if (!change) {
    return (
      <PageShell>
        <Empty description={errorMessage ?? "续期变更不存在"}>
          <Button icon={<ReloadOutlined />} onClick={() => void loadChange()}>重试</Button>
        </Empty>
      </PageShell>
    );
  }

  const currentQuote = change.currentQuote;
  const quoteActionable = change.status === "QUOTED" && currentQuote?.status === "FORMAL";
  return (
    <PageShell>
      <Modal
        confirmLoading={submitting}
        okButtonProps={{ danger: true }}
        okText="确认拒绝"
        onCancel={() => setRejectOpen(false)}
        onOk={rejectQuote}
        open={rejectOpen}
        title="拒绝当前续期报价"
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item label="拒绝原因" name="reason" rules={[{ message: "请填写拒绝原因", required: true }]}>
            <Input.TextArea maxLength={2_000} rows={4} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Flex align="center" justify="space-between" style={{ marginBottom: 18 }} wrap="wrap">
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/renewals")}>返回续订安排</Button>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadChange()}>刷新</Button>
      </Flex>

      <Card style={{ marginBottom: 14 }}>
        <Flex align="flex-start" gap={16} justify="space-between" wrap="wrap">
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>续期协议进度</Typography.Title>
            <Typography.Text type="secondary">订单 {change.orderNo}</Typography.Text>
          </div>
          <Tag color={change.status === "COMPLETED" ? "green" : change.status === "CANCELLED" ? "default" : "blue"}>
            {change.status}
          </Tag>
        </Flex>
        {change.status === "CANCELLED" && change.cancelReason ? (
          <Alert description={formatCancelReason(change.cancelReason)} message="当前续期变更已取消" showIcon style={{ marginTop: 16 }} type="warning" />
        ) : change.status === "SCHEDULED" || change.status === "EXECUTING" ? (
          <Alert message="补充协议已归档，等待续期生效" showIcon style={{ marginTop: 16 }} type="success" />
        ) : change.status === "SIGNING_OR_PAYMENT" ? (
          <Alert message="等待签署归档" description="请查看补充协议并完成电子签署。" showIcon style={{ marginTop: 16 }} type="warning" />
        ) : null}
      </Card>

      <Card style={{ marginBottom: 14 }} title="续期合同期限">
        <Descriptions
          column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
          items={[
            { label: "原合同到期日", children: formatDate(change.sourceSegment.endDate) },
            { label: "续期开始日", children: formatDate(change.targetStartDate) },
            { label: "拟续期至", children: formatDate(change.targetEndDate) },
            { label: "续期完成期限", children: dayjs(change.completionDeadlineAt).format("YYYY-MM-DD HH:mm") }
          ]}
          size="small"
        />
      </Card>

      <Card style={{ marginBottom: 14 }} title="续期报价">
        {currentQuote ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Descriptions
              column={{ lg: 2, md: 2, sm: 1, xs: 1 }}
              items={[
                { label: "报价编号", children: currentQuote.quoteNo },
                { label: "精确版本", children: `revision ${currentQuote.revision}` },
                { label: "续期月租", children: formatMoney(currentQuote.monthlyFeeAmount) },
                { label: "有效期至", children: dayjs(currentQuote.validUntil).format("YYYY-MM-DD HH:mm") },
                { label: "月里程额度", children: currentQuote.mileageLimitKm ? `${currentQuote.mileageLimitKm} km` : "-" },
                { label: "超里程单价", children: currentQuote.overMileageFeeAmount ? formatMoney(currentQuote.overMileageFeeAmount) : "-" }
              ]}
              size="small"
            />
            {quoteActionable ? (
              <Space wrap>
                <Button icon={<CheckOutlined />} loading={submitting} onClick={() => void confirmQuote()} type="primary">
                  确认 revision {currentQuote.revision}
                </Button>
                <Button danger icon={<StopOutlined />} onClick={() => setRejectOpen(true)}>拒绝当前报价</Button>
              </Space>
            ) : null}
          </Space>
        ) : <Empty description="运营正在准备正式报价" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>

      <Card title="续期补充协议">
        {change.contractId ? (
          <Flex align="center" gap={16} justify="space-between" wrap="wrap">
            <Space align="start">
              <FilePdfOutlined style={{ color: "#cf1322", fontSize: 26 }} />
              <div>
                <Typography.Text strong>补充协议已生成</Typography.Text>
                <br />
                <Typography.Text type="secondary">可查看待签 PDF、电子签状态和已签文件。</Typography.Text>
              </div>
            </Space>
            <Button onClick={() => router.push(`/portal/contracts/${change.contractId}`)} type="primary">
              查看补充协议 / 去签署
            </Button>
          </Flex>
        ) : <Empty description="补充协议尚未生成" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>
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

function formatCancelReason(value: string) {
  const prefix = "CUSTOMER_QUOTE_REJECTED:";
  return value.startsWith(prefix) ? `拒绝原因：${value.slice(prefix.length).trim()}` : value;
}
