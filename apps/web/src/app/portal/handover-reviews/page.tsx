"use client";

import { ArrowLeftOutlined, CarOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Empty, Flex, List, Space, Spin, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  getPortalHandoverReviewErrorMessage,
  listPortalHandoverReviews,
  PortalHandoverReviewListItem
} from "../../../lib/portal-handover-review-api";
import { buildPortalHandoverReviewCard } from "../../../lib/portal-handover-review-view-model";
import { PortalApiError } from "../../../lib/portal-api";

export default function PortalHandoverReviewsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [reviews, setReviews] = useState<PortalHandoverReviewListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadReviews();
  }, []);

  async function loadReviews() {
    setErrorMessage(null);
    setLoading(true);
    try {
      setReviews(await listPortalHandoverReviews());
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/handover-reviews")}`);
        return;
      }
      const nextMessage = getPortalHandoverReviewErrorMessage(error);
      setErrorMessage("交接确认事项加载失败，请稍后重试");
      void message.error(nextMessage);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }} wrap="wrap">
          <div>
            <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal")} style={{ marginBottom: 12 }}>
              返回门户
            </Button>
            <Typography.Title level={2} style={{ margin: 0 }}>
              车辆交接确认
            </Typography.Title>
            <Typography.Text type="secondary">查看现场提交的车辆交接资料，并完成确认或提出异议。</Typography.Text>
          </div>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadReviews}>
            刷新
          </Button>
        </Flex>

        {loading ? (
          <section style={sectionStyle}>
            <Flex align="center" gap={12}>
              <Spin />
              <Typography.Text>正在加载交接确认事项...</Typography.Text>
            </Flex>
          </section>
        ) : null}

        {!loading && errorMessage ? (
          <Alert
            action={<Button onClick={loadReviews}>重试</Button>}
            message={errorMessage}
            showIcon
            style={{ marginBottom: 14 }}
            type="error"
          />
        ) : null}

        {!loading && !errorMessage ? (
          <List
            dataSource={reviews}
            locale={{ emptyText: <Empty description="暂无待确认的车辆交接事项" /> }}
            renderItem={(review) => {
              const card = buildPortalHandoverReviewCard(review);
              return (
                <List.Item
                  actions={[
                    <Button
                      key="detail"
                      onClick={() => router.push(`/portal/handover-reviews/${review.id}`)}
                      type="link"
                    >
                      查看交接资料
                    </Button>
                  ]}
                  style={listItemStyle}
                >
                  <List.Item.Meta
                    avatar={<CarOutlined style={{ color: "#1677ff", fontSize: 26, marginTop: 4 }} />}
                    description={
                      <Space direction="vertical" size={8}>
                        <Typography.Text type="secondary">
                          {card.vehicleText} · {card.plateText}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          预约 {card.scheduledAtText} · 地点 {card.deliveryLocationText}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          提交 {card.fieldSubmittedAtText} · {card.evidenceText}
                        </Typography.Text>
                        <Space size={[6, 6]} wrap>
                          <Tag color={card.statusTone}>{card.statusLabel}</Tag>
                          <Tag>{card.vinText}</Tag>
                        </Space>
                      </Space>
                    }
                    title={<Typography.Text strong>{card.title}</Typography.Text>}
                  />
                </List.Item>
              );
            }}
          />
        ) : null}
      </section>
    </main>
  );
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};

const listItemStyle = {
  ...sectionStyle,
  padding: 16
};
