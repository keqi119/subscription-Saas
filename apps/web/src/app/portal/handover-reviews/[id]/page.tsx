"use client";

import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import { Alert, App, Button, Checkbox, Descriptions, Empty, Flex, Input, List, Space, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildPortalHandoverReviewFileUrl,
  confirmPortalHandoverReview,
  getPortalHandoverESign,
  getPortalHandoverESignErrorMessage,
  getPortalHandoverReview,
  getPortalHandoverReviewErrorMessage,
  objectPortalHandoverReview,
  PortalHandoverReviewDetail,
  Stage2PortalESignView,
  startPortalHandoverSigning
} from "../../../../lib/portal-handover-review-api";
import {
  buildPortalHandoverESignView,
  validatePortalHandoverSigningRedirect
} from "../../../../lib/portal-handover-esign-view-model";
import {
  buildPortalHandoverReviewDetailView,
  buildPortalHandoverWorkflowView,
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
  const [esignView, setESignView] = useState<Stage2PortalESignView>();
  const [esignLoading, setESignLoading] = useState(true);
  const [esignErrorMessage, setESignErrorMessage] = useState<string | null>(null);
  const [startingSigning, setStartingSigning] = useState(false);
  const signingStartInFlight = useRef(false);

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

  const loadESignStatus = useCallback(async () => {
    if (!params.id) {
      return;
    }
    setESignErrorMessage(null);
    setESignLoading(true);
    try {
      setESignView(await getPortalHandoverESign(params.id));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`);
        return;
      }
      setESignErrorMessage(getPortalHandoverESignErrorMessage(error));
    } finally {
      setESignLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void loadReview();
    void loadESignStatus();
  }, [loadESignStatus, loadReview]);

  const refreshWorkflowProjection = useCallback(async () => {
    if (!params.id) {
      return;
    }
    try {
      const [nextReview, nextESignView] = await Promise.all([
        getPortalHandoverReview(params.id),
        getPortalHandoverESign(params.id)
      ]);
      setReview(nextReview);
      setESignView(nextESignView);
      setESignErrorMessage(null);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`);
        return;
      }
      setESignErrorMessage(getPortalHandoverESignErrorMessage(error));
    }
  }, [params.id, router]);

  const workflowDisplay = review
    ? buildPortalHandoverWorkflowView(review, esignView)
    : null;

  useEffect(() => {
    if (!workflowDisplay?.shouldPoll) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshWorkflowProjection();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refreshWorkflowProjection, workflowDisplay?.shouldPoll]);

  const refreshPage = useCallback(async () => {
    await refreshWorkflowProjection();
  }, [refreshWorkflowProjection]);

  async function confirmNoObjection() {
    const manifestHash = review?.evidencePackage?.manifestHash;
    if (!review || !acknowledged || !manifestHash) {
      return;
    }
    try {
      setConfirming(true);
      const nextReview = await confirmPortalHandoverReview(review.id, acknowledged, manifestHash);
      setReview(nextReview);
      setAcknowledged(false);
      void message.success("已确认无异议");
      await refreshWorkflowProjection();
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
      await refreshWorkflowProjection();
    } catch (error) {
      void message.error(getPortalHandoverReviewErrorMessage(error));
    } finally {
      setObjecting(false);
    }
  }

  async function startSigning() {
    if (
      !esignView ||
      !workflowDisplay?.canStartSigning ||
      review?.handover?.status !== "PENDING_CUSTOMER_SIGNATURE" ||
      signingStartInFlight.current ||
      startingSigning
    ) {
      return;
    }

    signingStartInFlight.current = true;
    setStartingSigning(true);
    try {
      const result = await startPortalHandoverSigning(params.id);
      if ("alreadySigned" in result) {
        setESignView(result.eSign);
        void message.success("签署状态已更新");
        await refreshWorkflowProjection();
        return;
      }
      window.location.assign(validatePortalHandoverSigningRedirect(result.signUrl));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/handover-reviews/${params.id}`)}`);
        return;
      }
      const nextMessage =
        error instanceof Error && error.message === "签署链接无效，请稍后重试"
          ? error.message
          : getPortalHandoverESignErrorMessage(error);
      void message.error(nextMessage);
      await loadESignStatus();
    } finally {
      signingStartInFlight.current = false;
      setStartingSigning(false);
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
  const esignDisplay = esignView
    ? buildPortalHandoverESignView(esignView)
    : null;

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/handover-reviews")}>
            返回交接确认
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={loading || esignLoading}
            onClick={refreshPage}
          >
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
          {review.evidencePackage ? (
            <Descriptions
              column={1}
              items={[
                {
                  children: `${review.evidencePackage.fileCount ?? 0}（照片 ${review.evidencePackage.photoCount ?? 0} / 视频 ${review.evidencePackage.videoCount ?? 0}）`,
                  label: "证据包文件"
                },
                {
                  children: review.evidencePackage.manifestHash
                    ? <Typography.Text copyable>{review.evidencePackage.manifestHash}</Typography.Text>
                    : <Typography.Text type="warning">证据文件仍在处理，暂不能确认</Typography.Text>,
                  label: "证据包哈希"
                }
              ]}
              size="small"
              style={{ marginTop: 12 }}
            />
          ) : null}
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
            canConfirmEvidencePackage={Boolean(
              review.evidencePackage?.ready && review.evidencePackage.manifestHash
            )}
            confirming={confirming}
            decision={view.decision}
            evidenceConfirmationText={
              review.evidencePackage?.confirmationText ??
              "本人已查看本次交接证据包所列全部照片和视频，并确认其反映的车辆交接状态。"
            }
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

        <section style={esignSectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            车辆交接确认单签署
          </Typography.Title>
          {workflowDisplay ? (
            <Tag color={workflowDisplay.statusTone} style={{ marginBottom: 12 }}>
              {workflowDisplay.statusLabel}
            </Tag>
          ) : null}
          {esignLoading ? (
            <Flex align="center" gap={12}>
              <Spin size="small" />
              <Typography.Text type="secondary">
                正在加载签署状态...
              </Typography.Text>
            </Flex>
          ) : esignErrorMessage ? (
            <Alert
              action={
                <Button
                  icon={<ReloadOutlined />}
                  onClick={loadESignStatus}
                  size="small"
                >
                  重试
                </Button>
              }
              message="签署状态加载失败"
              description={esignErrorMessage}
              showIcon
              type="warning"
            />
          ) : esignView && esignDisplay ? (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Typography.Text type="secondary">
                {esignDisplay.description}
              </Typography.Text>
              {esignDisplay.blockers.map((blocker) => (
                <Alert key={blocker} message={blocker} showIcon type="info" />
              ))}
              {workflowDisplay?.canStartSigning ? (
                <Button
                  block
                  disabled={!workflowDisplay.canStartSigning || startingSigning}
                  icon={<EditOutlined />}
                  loading={startingSigning}
                  onClick={startSigning}
                  size="large"
                  type="primary"
                >
                  去签署
                </Button>
              ) : null}
            </Space>
          ) : (
            <Alert message="签署状态暂不可用，请稍后刷新" showIcon type="info" />
          )}
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
  canConfirmEvidencePackage,
  confirming,
  decision,
  evidenceConfirmationText,
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
  canConfirmEvidencePackage: boolean;
  confirming: boolean;
  decision: ReturnType<typeof buildPortalHandoverReviewDetailView>["decision"];
  evidenceConfirmationText: string;
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
        <Checkbox
          checked={acknowledged}
          disabled={!canConfirmEvidencePackage}
          onChange={(event) => onAcknowledgeChange(event.target.checked)}
        >
          {evidenceConfirmationText}
        </Checkbox>
        <Button
          block
          disabled={!acknowledged || !canConfirmEvidencePackage}
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

const esignSectionStyle = {
  marginBottom: 14,
  padding: "18px 0"
};
