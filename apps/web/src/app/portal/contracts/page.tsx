"use client";

import { ArrowLeftOutlined, FileTextOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  ESIGN_TASK_STATUS_LABELS,
  STATUS_LABELS,
  labelOf
} from "../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { getPortalContractDestination } from "../../../lib/portal-handover-review-view-model";
import { PortalContractListItem } from "../../../lib/portal-types";

export default function PortalContractsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [contracts, setContracts] = useState<PortalContractListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    portalApiFetch<PortalContractListItem[]>("/portal/contracts")
      .then(setContracts)
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/contracts")}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载合同列表");
      })
      .finally(() => setLoading(false));
  }, [message, router]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              我的合同
            </Typography.Title>
            <Typography.Text type="secondary">查看待签署合同和签署状态</Typography.Text>
          </div>
        </Flex>

        <List
          dataSource={contracts}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无合同" /> }}
          renderItem={(contract) => {
            const destination = getPortalContractDestination(contract);
            return (
              <List.Item
                actions={destination ? [
                <Button
                  key="detail"
                  onClick={() => router.push(destination)}
                  type="link"
                >
                  查看详情
                </Button>
                ] : []}
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                marginBottom: 12,
                padding: 16
              }}
            >
              <List.Item.Meta
                avatar={<FileTextOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      订单 {contract.orderNo} · 创建于 {formatTime(contract.createdAt)}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      <Tag color="blue">{labelOf(STATUS_LABELS, contract.contractStatus)}</Tag>
                      <Tag>{contract.signStatus ? labelOf(ESIGN_TASK_STATUS_LABELS, contract.signStatus) : "待发起签署"}</Tag>
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{contract.contractNo}</Typography.Text>}
              />
              </List.Item>
            );
          }}
        />
      </section>
    </main>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}
