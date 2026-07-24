"use client";

import { ArrowLeftOutlined, CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Checkbox, Descriptions, Empty, Flex, Input, List, Space, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  confirmPortalHandoverReview,
  buildPortalHandoverReviewFileUrl,
  getPortalHandoverReview,
  getPortalHandoverReviewErrorMessage,
  objectPortalHandoverReview,
  PortalHandoverReviewDetail
} from "../../../../lib/portal-handover-review-api";
import {
  buildPortalHandoverReviewDetailView,
  validatePortalHandoverObjectionReason
} from "../../../../lib/portal-handover-review-view-model";
import { PortalApiError } from "../../../../lib/portal-api";

export default function PortalHandoverReviewDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [review, setReview] = useState<PortalHandoverReviewDetail>();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [objecting, setObjecting] = useState(false);
  const [objectionReason, setObjectionReason] = useState("");
  const [objectionDetails, setObjectionDetails] = useState("");

  const loadReview = useCallback(async () => {
    if (!params.id) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);
    try {
      setReview(await getPortalHandoverReview(params.id));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`);
        return;
      }
      const nextMessage = getPortalHandoverReviewErrorMessage(error);
      setErrorMessage(nextMessage);
      void message.error(nextMessage);
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  async function confirmNoObjection() {
    if (!review || !acknowledged) {
      return;
    }
    try {
      setConfirming(true);
      const nextReview = await confirmPortalHandoverReview(review.id, acknowledged);
      setReview(nextReview);
      setAcknowledged(false);
      void message.success("已确认无异议");
      await loadReview();
    } catch (error) {
      void message.error(getPortalHandoverReviewErrorMessage(error));
    } finally {
      setConfirming(false);
    }
  }

  async function submitObjection() {
    if (!review) {
      return;
    }
    const validationError = validatePortalHandoverObjectionReason(objectionReason);
    if (validationError) {
      void message.warning(validationError);
      return;
    }
    try {
      setObjecting(true);
      const nextReview = await objectPortalHandoverReview(review.id, {
        details: objectionDetails.trim() || undefined,
        reason: objectionReason.trim()
      });
      setReview(nextReview);
      setObjectionDetails("");
      setObjectionReason("");
      void message.success("已提交异议，工作人员将联系您处理");
      await loadReview();
    } catch (error) {
      void message.error(getPortalHandoverReviewErrorMessage(error));
    } finally {
      setObjecting(false);
    }
  }

  if (loading) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
        <section style={{ margin: "0 auto", maxWidth: 860 }}>
          <section style={sectionStyle}>
            <Flex align="center" gap={12}>
              <Spin />
              <Typography.Text>正在加载交接资料...</Typography.Text>
            </Flex>
          </section>
        </section>
      </main>
    );
  }

  if (errorMessage || !review) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
        <section style={{ margin: "0 auto", maxWidth: 860 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => router.push("/portal/handover-reviews")}
            style={{ marginBottom: 12 }}
          >
            返回交接确认
          </Button>
          <section style={sectionStyle}>
            <Empty description={errorMessage ?? "交接确认事项不存在或已关闭"} />
          </section>
        </section>
      </main>
    );
  }

  const view = buildPortalHandoverReviewDetailView(review);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/handover-reviews")}>
            返回交接确认
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadReview}>
            刷新
          </Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={12} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                车辆交接资料确认
              </Typography.Title>
              <Typography.Text type="secondary">{view.readinessText}</Typography.Text>
            </div>
            <Tag color={view.statusTone}>{view.statusLabel}</Tag>
          </Flex>
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            基础信息
          </Typography.Title>
          <Descriptions column={1} items={view.summaryRows.map((row) => ({
            children: row.value,
            label: row.label
          }))} />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            现场交接信息
          </Typography.Title>
          <Descriptions column={1} items={view.fieldFactRows.map((row) => ({
            children: row.value,
            label: row.label
          }))} />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            资料清单
          </Typography.Title>
          <Typography.Text type="secondary">{view.evidenceSummaryText}</Typography.Text>
          <List
            dataSource={view.evidenceItems}
            locale={{ emptyText: <Empty description="暂无资料清单" /> }}
            renderItem={(item) => (
              <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
                <List.Item.Meta
                  description={
                    <Space direction="vertical" size={6}>
                      <Space size={[6, 6]} wrap>
                        <Tag>{item.requiredText}</Tag>
                        <Tag>{item.fileCountText}</Tag>
                        <Tag color={item.statusLabel === "已通过" ? "green" : "blue"}>{item.statusLabel}</Tag>
                      </Space>
                      {item.rejectionReason ? (
                        <Typography.Text type="danger">驳回原因：{item.rejectionReason}</Typography.Text>
                      ) : null}
                      {item.files.length > 0 ? (
                        <Space size={[8, 6]} wrap>
                          {item.files.map((file) => (
                            <Space key={file.id || file.displayName} size={4} wrap>
                              <Typography.Text type="secondary">
                                {file.displayName} / {file.sizeText}
                              </Typography.Text>
                              {file.previewAvailable && file.previewUrl ? (
                                <Typography.Link
                                  href={buildPortalHandoverReviewFileUrl(file.previewUrl) ?? undefined}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  预览
                                </Typography.Link>
                              ) : null}
                              {file.downloadUrl ? (
                                <Typography.Link
                                  href={buildPortalHandoverReviewFileUrl(file.downloadUrl) ?? undefined}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  下载/打开
                                </Typography.Link>
                              ) : null}
                            </Space>
                          ))}
                        </Space>
                      ) : null}
                    </Space>
                  }
                  title={<Typography.Text strong>{item.title}</Typography.Text>}
                />
              </List.Item>
            )}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            复核历史
          </Typography.Title>
          <List
            dataSource={review.reviewHistory ?? []}
            locale={{ emptyText: "暂无复核历史" }}
            renderItem={(attempt) => (
              <List.Item>
                <List.Item.Meta
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text type="secondary">
                        现场提交：{formatReviewTime(attempt.fieldSubmittedAt)}
                      </Typography.Text>
                      {attempt.customerObjectionReason ? (
                        <Typography.Text type="danger">
                          异议：{attempt.customerObjectionReason}
                          {attempt.customerObjectionDetails ? ` / ${attempt.customerObjectionDetails}` : ""}
                        </Typography.Text>
                      ) : null}
                      {attempt.customerConfirmedAt ? (
                        <Typography.Text type="success">
                          客户确认：{formatReviewTime(attempt.customerConfirmedAt)}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                  title={`第 ${attempt.attemptNo ?? "-"} 轮 / ${formatReviewAttemptStatus(attempt.status)}`}
                />
              </List.Item>
            )}
          />
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            客户确认
          </Typography.Title>
          <DecisionArea
            acknowledged={acknowledged}
            confirming={confirming}
            decision={view.decision}
            objecting={objecting}
            objectionDetails={objectionDetails}
            objectionReason={objectionReason}
            onAcknowledgeChange={setAcknowledged}
            onConfirm={confirmNoObjection}
            onObjectionDetailsChange={setObjectionDetails}
            onObjectionReasonChange={setObjectionReason}
            onObject={submitObjection}
          />
        </section>
      </section>
    </main>
  );
}

function formatReviewAttemptStatus(value?: string | null) {
  const labels: Record<string, string> = {
    CUSTOMER_CONFIRMED: "已确认无异议",
    CUSTOMER_OBJECTED: "已提交异议",
    CUSTOMER_REVIEWING: "待客户复核",
    RESUBMISSION_REQUESTED: "现场复检中",
    RESUBMITTED_PENDING_ADMIN: "现场已重提",
    SENT_BACK_TO_CUSTOMER_REVIEW: "已送回客户复核"
  };
  return value ? labels[value] ?? value : "-";
}

function formatReviewTime(value?: string | null) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

function DecisionArea({
  acknowledged,
  confirming,
  decision,
  objecting,
  objectionDetails,
  objectionReason,
  onAcknowledgeChange,
  onConfirm,
  onObjectionDetailsChange,
  onObjectionReasonChange,
  onObject
}: Readonly<{
  acknowledged: boolean;
  confirming: boolean;
  decision: ReturnType<typeof buildPortalHandoverReviewDetailView>["decision"];
  objecting: boolean;
  objectionDetails: string;
  objectionReason: string;
  onAcknowledgeChange: (value: boolean) => void;
  onConfirm: () => void;
  onObjectionDetailsChange: (value: string) => void;
  onObjectionReasonChange: (value: string) => void;
  onObject: () => void;
}>) {
  if (decision.mode === "ACTIONABLE") {
    return (
      <Space direction="vertical" size={14} style={{ width: "100%" }}>
        <Alert message={decision.message} showIcon type="info" />
        <Checkbox checked={acknowledged} onChange={(event) => onAcknowledgeChange(event.target.checked)}>
          我已查看车辆交接资料，并确认无异议
        </Checkbox>
        <Button
          block
          disabled={!acknowledged}
          icon={<CheckCircleOutlined />}
          loading={confirming}
          onClick={onConfirm}
          size="large"
          type="primary"
        >
          确认无异议
        </Button>

        <section style={inlinePanelStyle}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            提出异议
          </Typography.Title>
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Input.TextArea
              autoSize={{ maxRows: 4, minRows: 3 }}
              onChange={(event) => onObjectionReasonChange(event.target.value)}
              placeholder="请填写异议原因"
              value={objectionReason}
            />
            <Input.TextArea
              autoSize={{ maxRows: 4, minRows: 2 }}
              onChange={(event) => onObjectionDetailsChange(event.target.value)}
              placeholder="补充说明，可选"
              value={objectionDetails}
            />
            <Button
              block
              danger
              icon={<ExclamationCircleOutlined />}
              loading={objecting}
              onClick={onObject}
              size="large"
            >
              提交异议
            </Button>
          </Space>
        </section>
      </Space>
    );
  }

  if (decision.mode === "CONFIRMED") {
    return <Alert message={decision.message} showIcon type="success" />;
  }

  if (decision.mode === "OBJECTED") {
    return (
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Alert message={decision.message} showIcon type="warning" />
        <Descriptions
          column={1}
          items={[
            { label: "异议原因", children: decision.reason },
            { label: "补充说明", children: decision.details || "-" }
          ]}
        />
      </Space>
    );
  }

  return <Alert message={decision.message} showIcon type="info" />;
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 14,
  padding: 18
};

const inlinePanelStyle = {
  background: "#f8fafc",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  padding: 14
};
