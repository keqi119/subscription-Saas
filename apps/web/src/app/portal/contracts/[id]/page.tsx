"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, DownloadOutlined, FileTextOutlined, PayCircleOutlined, ReloadOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Form, Input, Modal, Space, Spin, Tag, Typography } from "antd";
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
import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  getFadadaBlockingMessage,
  getFadadaNextActionLabel,
  getFadadaReadinessAvailability,
  getFadadaReadinessTone,
  isApplyCertReadiness
} from "../../../../lib/fadada-onboarding-ui";
import { getPortalContractDestination } from "../../../../lib/portal-handover-review-view-model";
import {
  PortalContractDetail,
  PortalFadadaOnboardingStatus,
  PortalPayableBill,
  PortalPaymentOrder,
  PortalSigningStartResponse
} from "../../../../lib/portal-types";

interface RealNameFormValues {
  idCardNo: string;
  mobile: string;
  name: string;
}

export default function PortalContractDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [realNameForm] = Form.useForm<RealNameFormValues>();
  const [contract, setContract] = useState<PortalContractDetail>();
  const [onboardingStatus, setOnboardingStatus] = useState<PortalFadadaOnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [realNameModalOpen, setRealNameModalOpen] = useState(false);
  const [refreshingOnboarding, setRefreshingOnboarding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startingRealName, setStartingRealName] = useState(false);

  const loadContract = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      const nextContract = await portalApiFetch<PortalContractDetail>(`/portal/contracts/${params.id}`);
      const stage2Destination = getPortalContractDestination(nextContract);
      if (stage2Destination !== `/portal/contracts/${encodeURIComponent(nextContract.id)}`) {
        router.replace(stage2Destination);
        return;
      }
      setContract(nextContract);
      const nextOnboardingStatus = await portalApiFetch<PortalFadadaOnboardingStatus>(
        "/portal/esign-onboarding/status"
      ).catch((error) => {
        void message.warning(error instanceof PortalApiError ? error.message : "无法加载法大大认证状态");
        return null;
      });
      setOnboardingStatus(nextOnboardingStatus);
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
    const stage2Destination = getPortalContractDestination(contract);
    if (stage2Destination !== `/portal/contracts/${encodeURIComponent(contract.id)}`) {
      router.push(stage2Destination);
      return;
    }
    const availability = getFadadaReadinessAvailability(onboardingStatus);
    if (!availability.allowed) {
      void message.warning(availability.reason ?? getFadadaBlockingMessage(onboardingStatus));
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

  function openRealNameModal() {
    const mobile = contract?.customer.mobile;
    realNameForm.setFieldsValue({
      mobile: mobile && !mobile.includes("*") ? mobile : undefined,
      name: contract?.customer.name
    });
    setRealNameModalOpen(true);
  }

  async function startRealNameVerification() {
    const values = await realNameForm.validateFields();
    try {
      setStartingRealName(true);
      const result = await portalApiFetch<PortalFadadaOnboardingStatus>("/portal/esign-onboarding/real-name", {
        body: JSON.stringify(values),
        method: "POST"
      });
      setOnboardingStatus(result);
      setRealNameModalOpen(false);
      if (result.realNameUrl) {
        window.location.assign(result.realNameUrl);
        return;
      }
      void message.info("实名认证流程已发起，请稍后刷新认证状态");
    } catch (error) {
      if (
        error instanceof PortalApiError &&
        error.message.includes("FADADA_REALNAME_ALREADY_VERIFIED")
      ) {
        setRealNameModalOpen(false);
        void message.warning("实名已完成，请刷新并绑定法大大实名证书");
        await refreshOnboardingStatus();
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法发起法大大实名认证");
    } finally {
      setStartingRealName(false);
    }
  }

  async function refreshOnboardingStatus() {
    try {
      setRefreshingOnboarding(true);
      const result = await portalApiFetch<PortalFadadaOnboardingStatus>("/portal/esign-onboarding/refresh", {
        method: "POST"
      });
      setOnboardingStatus(result);
      void message.success("认证状态已刷新");
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法刷新认证状态");
    } finally {
      setRefreshingOnboarding(false);
    }
  }

  function openSignedContract() {
    if (!contract) {
      return;
    }
    window.open(
      `${PORTAL_API_BASE_URL}/portal/contracts/${encodeURIComponent(contract.id)}/signed-document/preview`,
      "_blank",
      "noopener,noreferrer"
    );
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
          billIds: bills.map((bill) => bill.billId)
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
      <Modal
        confirmLoading={startingRealName}
        okText="提交并前往认证"
        onCancel={() => setRealNameModalOpen(false)}
        onOk={startRealNameVerification}
        open={realNameModalOpen}
        title="法大大实名认证"
      >
        <Form form={realNameForm} layout="vertical">
          <Form.Item label="姓名" name="name" rules={[{ message: "请输入姓名", required: true }]}>
            <Input autoComplete="name" />
          </Form.Item>
          <Form.Item label="手机号" name="mobile" rules={[{ message: "请输入实名手机号", required: true }]}>
            <Input autoComplete="tel" />
          </Form.Item>
          <Form.Item label="身份证号" name="idCardNo" rules={[{ message: "请输入身份证号", required: true }]}>
            <Input.Password autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
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
              disabled={!contract.canSign || !getFadadaReadinessAvailability(onboardingStatus).allowed}
              icon={contract.contractStatus === "SIGNED" ? <CheckCircleOutlined /> : <FileTextOutlined />}
              loading={starting}
              onClick={startSigning}
              type="primary"
            >
              去签署
            </Button>
          </Flex>

          <Alert
            message={getFadadaBlockingMessage(onboardingStatus)}
            description={onboardingStatus?.blockingCode ? `状态码：${onboardingStatus.blockingCode}` : undefined}
            showIcon
            style={{ marginTop: 16 }}
            type={getFadadaReadinessTone(onboardingStatus)}
          />
          {!getFadadaReadinessAvailability(onboardingStatus).allowed ? (
            <Space size={8} style={{ marginTop: 12 }} wrap>
              <Button
                icon={isApplyCertReadiness(onboardingStatus) ? <ReloadOutlined /> : <SafetyCertificateOutlined />}
                loading={isApplyCertReadiness(onboardingStatus) ? refreshingOnboarding : false}
                onClick={isApplyCertReadiness(onboardingStatus) ? refreshOnboardingStatus : openRealNameModal}
                type="primary"
              >
                {getFadadaNextActionLabel(onboardingStatus)}
              </Button>
              <Button icon={<ReloadOutlined />} loading={refreshingOnboarding} onClick={refreshOnboardingStatus}>
                刷新认证状态
              </Button>
            </Space>
          ) : (
            <Button icon={<ReloadOutlined />} loading={refreshingOnboarding} onClick={refreshOnboardingStatus} style={{ marginTop: 12 }}>
              刷新认证状态
            </Button>
          )}

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

        {contract.contractStatus === "SIGNED" ? (
          <section style={sectionStyle}>
            <Flex align="center" justify="space-between" gap={12} wrap="wrap">
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  已签合同
                </Typography.Title>
                <Typography.Text type="secondary">
                  {contract.signTask?.hasSignedDocument ? "已签署文件已生成，可下载查看。" : "已签署文件生成中，请稍后查看。"}
                </Typography.Text>
              </div>
              <Button
                disabled={!contract.signTask?.hasSignedDocument}
                icon={<DownloadOutlined />}
                onClick={openSignedContract}
                type="primary"
              >
                下载已签合同
              </Button>
            </Flex>
            {!contract.signTask?.hasSignedDocument ? (
              <Alert message="已签署文件生成中，请稍后查看" showIcon style={{ marginTop: 16 }} type="info" />
            ) : null}
          </section>
        ) : null}

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
