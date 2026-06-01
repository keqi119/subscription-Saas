"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch, ApiError } from "../../../lib/api";

interface ContractDetail {
  archivedAt?: string | null;
  contractNo: string;
  contractSnapshot?: unknown;
  contractTitle: string;
  createdAt: string;
  customer: { name: string; mobile: string };
  id: string;
  order: { orderNo: string; id: string };
  signedAt?: string | null;
  status: string;
  version?: { versionNo: string } | null;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function ContractDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const loadContract = useCallback(async () => {
    setLoading(true);
    try {
      setContract(await apiFetch<ContractDetail>(`/contracts/${params.id}`));
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message, params.id]);

  useEffect(() => {
    void loadContract();
  }, [loadContract]);

  async function transition(action: "sign" | "archive" | "cancel") {
    if (!contract) {
      return;
    }
    try {
      await apiFetch(`/contracts/${contract.id}/${action}`, {
        body: action === "archive" ? JSON.stringify({}) : undefined,
        method: "POST"
      });
      void message.success(action === "sign" ? "合同已签署" : action === "archive" ? "合同已归档" : "合同已取消");
      await loadContract();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  return (
    <ProtectedShell>
      <Space direction="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回合同列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/contracts")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {contract?.contractNo ?? "合同详情"}
            </Typography.Title>
            {contract ? <Tag>{labelOf(STATUS_LABELS, contract.status)}</Tag> : null}
          </Space>
          {contract ? (
            <Space>
              {["GENERATED", "SIGNING"].includes(contract.status) ? (
                <Button onClick={() => transition("sign")} type="primary">
                  签署
                </Button>
              ) : null}
              {contract.status === "SIGNED" ? <Button onClick={() => transition("archive")}>归档</Button> : null}
              {["GENERATED", "SIGNING"].includes(contract.status) ? (
                <Button danger onClick={() => transition("cancel")}>
                  取消
                </Button>
              ) : null}
            </Space>
          ) : null}
        </Space>

        <Descriptions
          bordered
          column={3}
          items={
            contract && !loading
              ? [
                  { label: "合同编号", children: contract.contractNo },
                  { label: "合同标题", children: contract.contractTitle },
                  {
                    label: "订单编号",
                    children: <Link href={`/orders/${contract.order.id}`}>{contract.order.orderNo}</Link>
                  },
                  { label: "客户信息", children: `${contract.customer.name} / ${contract.customer.mobile}` },
                  { label: "合同状态", children: <Tag>{labelOf(STATUS_LABELS, contract.status)}</Tag> },
                  { label: "合同版本", children: contract.version?.versionNo ?? "-" },
                  { label: "签署时间", children: formatTime(contract.signedAt) },
                  { label: "归档时间", children: formatTime(contract.archivedAt) },
                  { label: "创建时间", children: formatTime(contract.createdAt) }
                ]
              : []
          }
        />

        <Typography.Title level={5} style={{ margin: 0 }}>
          合同快照
        </Typography.Title>
        <pre style={{ background: "#f6f7f9", margin: 0, overflow: "auto", padding: 16 }}>
          {contract?.contractSnapshot ? JSON.stringify(contract.contractSnapshot, null, 2) : "-"}
        </pre>
      </Space>
    </ProtectedShell>
  );
}
