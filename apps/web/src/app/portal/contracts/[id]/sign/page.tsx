"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, FileProtectOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Spin, Typography } from "antd";
import dayjs from "dayjs";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import {
  ESIGN_SIGNER_STATUS_LABELS,
  ESIGN_TASK_STATUS_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../../lib/portal-api";
import { PortalContractDetail } from "../../../../../lib/portal-types";

export default function PortalMockSignPage() {
  return (
    <Suspense fallback={null}>
      <PortalMockSignPageContent />
    </Suspense>
  );
}

function PortalMockSignPageContent() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { message } = App.useApp();
  const [contract, setContract] = useState<PortalContractDetail>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const taskId = searchParams.get("taskId");

  const loadContract = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      setContract(await portalApiFetch<PortalContractDetail>(`/portal/contracts/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/contracts/${params.id}/sign?taskId=${taskId ?? ""}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载合同签署页");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router, taskId]);

  useEffect(() => {
    void loadContract();
  }, [loadContract]);

  async function mockSign() {
    if (!taskId) {
      void message.error("缺少电子签任务 ID");
      return;
    }

    try {
      setSubmitting(true);
      await portalApiFetch(`/portal/esign-tasks/${taskId}/mock-sign`, { method: "POST" });
      void message.success("签署完成");
      router.replace(`/portal/contracts/${params.id}`);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "签署失败");
    } finally {
      setSubmitting(false);
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

  const signer = contract.signTask?.signers.find((item) => item.signerType === "CUSTOMER");

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 720 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/portal/contracts/${contract.id}`)} style={{ marginBottom: 16 }}>
          返回合同详情
        </Button>

        <section style={sectionStyle}>
          <Flex align="center" gap={12} style={{ marginBottom: 12 }}>
            <FileProtectOutlined style={{ color: "#1677ff", fontSize: 28 }} />
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                模拟电子签署
              </Typography.Title>
              <Typography.Text type="secondary">{contract.contractNo}</Typography.Text>
            </div>
          </Flex>
          <Alert
            message="当前为 Mock 电子签署，仅用于测试；真实电子签供应商接入后将跳转第三方签署页。"
            showIcon
            type="warning"
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            签署确认
          </Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "合同编号", children: contract.contractNo },
              { label: "合同状态", children: labelOf(STATUS_LABELS, contract.contractStatus) },
              { label: "任务状态", children: contract.signTask ? labelOf(ESIGN_TASK_STATUS_LABELS, contract.signTask.taskStatus) : "-" },
              { label: "签署人", children: `${signer?.signerName ?? contract.customer.name} / ${signer?.signerPhone ?? contract.customer.mobile}` },
              { label: "签署人状态", children: signer ? labelOf(ESIGN_SIGNER_STATUS_LABELS, signer.signerStatus) : "-" },
              { label: "链接有效期", children: formatTime(contract.signTask?.signUrlExpiresAt) }
            ]}
          />
          <Button
            disabled={!taskId || contract.contractStatus === "SIGNED"}
            icon={<CheckCircleOutlined />}
            loading={submitting}
            onClick={mockSign}
            style={{ marginTop: 18, width: "100%" }}
            type="primary"
          >
            确认签署
          </Button>
        </section>
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
