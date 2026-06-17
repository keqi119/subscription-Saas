"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, FileTextOutlined, PayCircleOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Space, Spin, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  ESIGN_PROVIDER_LABELS,
  ESIGN_SIGNER_STATUS_LABELS,
  ESIGN_TASK_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  PortalContractDetail,
  PortalPayableBill,
  PortalPaymentOrder,
  PortalSigningStartResponse
} from "../../../../lib/portal-types";

export default function PortalContractDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [contract, setContract] = useState<PortalContractDetail>();
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [starting, setStarting] = useState(false);

  const loadContract = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      setContract(await portalApiFetch<PortalContractDetail>(`/portal/contracts/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/contracts/${params.id}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载合同详情");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadContract();
  }, [loadContract]);

  async function startSigning() {
    if (!contract) {
      return;
    }

    try {
      setStarting(true);
      const result = await portalApiFetch<PortalSigningStartResponse>(
        `/portal/contracts/${contract.id}/signing/start`,
        { method: "POST" }
      );
      if (result.mock) {
        router.push(`/portal/contracts/${contract.id}/sign?taskId=${encodeURIComponent(result.taskId)}`);
        return;
      }
      window.location.assign(result.signUrl);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法发起签署");
    } finally {
      setStarting(false);
    }
  }

  async function createPaymentOrder() {
    if (!contract) {
      return;
    }

    setPaying(true);
    try {
      const bills = await portalApiFetch<PortalPayableBill[]>(
        `/portal/payment/payable-bills?orderId=${encodeURIComponent(contract.order.id)}`
      );
      if (!bills.length) {
        void message.info("当前订单暂无待支付账单");
        return;
      }
      const result = await portalApiFetch<PortalPaymentOrder>("/portal/payment-orders", {
        body: JSON.stringify({
          billIds: bills.map((bill) => bill.billId),
          paymentChannel: "MOCK"
        }),
        method: "POST"
      });
      router.push(`/portal/payment-orders/${result.id}`);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法创建支付单");
    } finally {
      setPaying(false);
    }
  }

  if (loading) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Flex justify="center">
          <Spin />
        </Flex>
      </main>
    );
  }

  if (!contract) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="合同不存在" />
      </main>
    );
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/contracts")}>
            返回合同列表
          </Button>
          <Button onClick={() => router.push("/portal")}>返回门户</Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {contract.contractNo}
              </Typography.Title>
              <Typography.Text type="secondary">订单 {contract.orderNo}</Typography.Text>
            </div>
            <Space size={[6, 6]} wrap>
              <Tag color="blue">{labelOf(STATUS_LABELS, contract.contractStatus)}</Tag>
              <Tag>{contract.signStatus ? labelOf(ESIGN_TASK_STATUS_LABELS, contract.signStatus) : "待发起签署"}</Tag>
            </Space>
          </Flex>
          {contract.contractStatus === "SIGNED" ? (
            <Alert message="合同已签署完成，后续将进入付款流程。" showIcon style={{ marginTop: 16 }} type="success" />
          ) : contract.canSign ? (
            <Alert message="合同待签署，请核对合同摘要后进入电子签署。" showIcon style={{ marginTop: 16 }} type="warning" />
          ) : (
            <Alert message="合同尚未发起电子签，请等待平台处理。" showIcon style={{ marginTop: 16 }} type="info" />
          )}
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            合同摘要
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "合同编号", children: contract.contractNo },
              { label: "合同状态", children: labelOf(STATUS_LABELS, contract.contractStatus) },
              { label: "订单编号", children: contract.order.orderNo },
              { label: "订单状态", children: labelOf(ORDER_STATUS_LABELS, contract.order.orderStatus) },
              { label: "客户", children: `${contract.customer.name} / ${contract.customer.mobile}` },
              { label: "创建时间", children: formatTime(contract.createdAt) },
              { label: "签署时间", children: formatTime(contract.signedAt) }
            ]}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            车辆摘要
          </Typography.Title>
          {contract.vehicle ? (
            <Descriptions
              column={1}
              items={[
                { label: "车辆", children: contract.vehicle.displayName || "-" },
                { label: "城市", children: contract.vehicle.city ?? "-" },
                { label: "当前里程", children: contract.vehicle.currentMileageKm === null ? "-" : `${contract.vehicle.currentMileageKm.toLocaleString("zh-CN")} km` },
                { label: "电池容量", children: contract.vehicle.batteryCapacityKwh === null ? "-" : `${contract.vehicle.batteryCapacityKwh.toLocaleString("zh-CN")} kWh` }
              ]}
            />
          ) : (
            <Empty description="暂无车辆信息" />
          )}
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" gap={12} wrap="wrap">
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                签署任务
              </Typography.Title>
              <Typography.Text type="secondary">
                {contract.signTask ? labelOf(ESIGN_PROVIDER_LABELS, contract.signTask.provider) : "平台尚未发起电子签任务"}
              </Typography.Text>
            </div>
            <Button
              disabled={!contract.canSign}
              icon={contract.contractStatus === "SIGNED" ? <CheckCircleOutlined /> : <FileTextOutlined />}
              loading={starting}
              onClick={startSigning}
              type="primary"
            >
              去签署
            </Button>
          </Flex>

          {contract.signTask ? (
            <Space direction="vertical" size={12} style={{ marginTop: 16, width: "100%" }}>
              <Descriptions
                column={1}
                items={[
                  { label: "任务编号", children: contract.signTask.taskNo },
                  { label: "签署状态", children: labelOf(ESIGN_TASK_STATUS_LABELS, contract.signTask.taskStatus) },
                  { label: "签署链接有效期", children: formatTime(contract.signTask.signUrlExpiresAt) },
                  { label: "完成时间", children: formatTime(contract.signTask.completedAt) }
                ]}
              />
              {contract.signTask.signers.map((signer) => (
                <Alert
                  key={`${signer.signerType}-${signer.signerPhone ?? signer.signerName ?? "signer"}`}
                  message={`${signer.signerName ?? "签署人"} / ${signer.signerPhone ?? "-"}`}
                  description={labelOf(ESIGN_SIGNER_STATUS_LABELS, signer.signerStatus)}
                  showIcon
                  type={signer.signerStatus === "SIGNED" ? "success" : "info"}
                />
              ))}
            </Space>
          ) : null}
        </section>

        {contract.contractStatus === "SIGNED" && contract.order.orderStatus === "PENDING_PAYMENT" ? (
          <section style={sectionStyle}>
            <Flex align="center" justify="space-between" gap={12} wrap="wrap">
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  待支付账单
                </Typography.Title>
                <Typography.Text type="secondary">
                  合同已签署，请完成押金、首期月租或其他待付账单支付。
                </Typography.Text>
              </div>
              <Button icon={<PayCircleOutlined />} loading={paying} onClick={createPaymentOrder} type="primary">
                去支付
              </Button>
            </Flex>
          </section>
        ) : null}
      </section>
    </main>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};
