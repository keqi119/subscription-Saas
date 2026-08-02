"use client";

import {
  ArrowLeftOutlined,
  CameraOutlined,
  DeleteOutlined,
  EyeOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Empty,
  Flex,
  InputNumber,
  List,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  buildMileageReviewSettlementView,
  getMileageReviewActions,
  getMileageReviewPresentation,
  getPortalMileageReviewGuidance,
  isMileageReviewOverdue,
  validateMileageReviewSubmission,
  type MileageReviewView
} from "../../../../lib/mileage-review-view-model";

export default function PortalMileageReviewDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [review, setReview] = useState<MileageReviewView>();
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState<string>();
  const [mileage, setMileage] = useState<number | null>(null);
  const [readingAt, setReadingAt] = useState<Dayjs | null>(null);
  const inFlight = useRef(false);

  const applyReview = useCallback((next: MileageReviewView) => {
    setReview(next);
    setMileage(next.submittedMileageKm);
    setReadingAt(next.readingAt ? dayjs(next.readingAt) : dayjs());
  }, []);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    try {
      applyReview(await portalApiFetch<MileageReviewView>(`/portal/mileage-reviews/${params.id}`));
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/mileage-reviews/${params.id}`)}`);
        return;
      }
      void message.error(error instanceof Error ? error.message : "里程复核详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [applyReview, message, params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft() {
    if (!review || mileage === null || !readingAt || inFlight.current) return;
    inFlight.current = true;
    setMutation("draft");
    try {
      const next = await portalApiFetch<MileageReviewView>(`/portal/mileage-reviews/${params.id}/draft`, {
        body: JSON.stringify({
          lockVersion: review.lockVersion,
          readingAt: readingAt.toISOString(),
          submittedMileageKm: mileage
        }),
        method: "PUT"
      });
      applyReview(next);
      void message.success("里程草稿已保存");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "草稿保存失败");
    } finally {
      inFlight.current = false;
      setMutation(undefined);
    }
  }

  async function uploadEvidence(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!review || !file || inFlight.current) return;
    if (!file.type.startsWith("image/")) {
      void message.warning("请选择仪表盘照片");
      input.value = "";
      return;
    }
    const formData = new FormData();
    formData.append("files", file);
    formData.append("lockVersion", String(review.lockVersion));
    formData.append("capturedAt", new Date(file.lastModified || Date.now()).toISOString());
    formData.append("metadata", JSON.stringify({ captureSource: "PORTAL_INPUT", purpose: "ODOMETER_DASHBOARD" }));
    inFlight.current = true;
    setMutation("upload");
    try {
      applyReview(await portalApiFetch<MileageReviewView>(`/portal/mileage-reviews/${params.id}/evidence`, {
        body: formData,
        method: "POST"
      }));
      void message.success("仪表盘照片已上传");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "照片上传失败，请重试");
    } finally {
      input.value = "";
      inFlight.current = false;
      setMutation(undefined);
    }
  }

  async function removeEvidence(evidenceId: string) {
    if (!review || inFlight.current) return;
    inFlight.current = true;
    setMutation(`remove:${evidenceId}`);
    try {
      applyReview(await portalApiFetch<MileageReviewView>(
        `/portal/mileage-reviews/${params.id}/evidence/${evidenceId}`,
        { body: JSON.stringify({ lockVersion: review.lockVersion }), method: "DELETE" }
      ));
      void message.success("照片已移除");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "照片移除失败");
    } finally {
      inFlight.current = false;
      setMutation(undefined);
    }
  }

  async function submitReview() {
    if (!review || mileage === null || !readingAt || inFlight.current) return;
    const errors = validateMileageReviewSubmission({
      baselineMileageKm: review.baselineMileageKm,
      evidenceCount: review.evidence.length,
      readingAt: readingAt.toISOString(),
      submittedMileageKm: mileage
    });
    if (errors.length) {
      void message.warning(errors.join("；"));
      return;
    }
    inFlight.current = true;
    setMutation("submit");
    try {
      let currentReview = review;
      if (
        currentReview.submittedMileageKm !== mileage ||
        !currentReview.readingAt ||
        dayjs(currentReview.readingAt).valueOf() !== readingAt.valueOf()
      ) {
        currentReview = await portalApiFetch<MileageReviewView>(`/portal/mileage-reviews/${params.id}/draft`, {
          body: JSON.stringify({
            lockVersion: currentReview.lockVersion,
            readingAt: readingAt.toISOString(),
            submittedMileageKm: mileage
          }),
          method: "PUT"
        });
      }
      applyReview(await portalApiFetch<MileageReviewView>(`/portal/mileage-reviews/${params.id}/submit`, {
        body: JSON.stringify({ lockVersion: currentReview.lockVersion }),
        method: "POST"
      }));
      void message.success("里程资料已提交，等待后台复核");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "提交失败，请重试");
    } finally {
      inFlight.current = false;
      setMutation(undefined);
    }
  }

  if (loading) {
    return <PortalFrame><Flex justify="center" style={{ padding: 48 }}><Spin /></Flex></PortalFrame>;
  }
  if (!review) {
    return <PortalFrame><Empty description="里程复核不存在或无权访问" /></PortalFrame>;
  }

  const actions = getMileageReviewActions(review, "PORTAL");
  const guidance = getPortalMileageReviewGuidance(review);
  const presentation = getMileageReviewPresentation(review.status, isMileageReviewOverdue(review));
  const settlement = buildMileageReviewSettlementView(review);
  const readOnly = !actions.canEdit;

  return (
    <PortalFrame>
      <Flex justify="space-between" style={{ marginBottom: 14 }} wrap="wrap">
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/mileage-reviews")}>返回复核列表</Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
      </Flex>

      <section style={cardStyle}>
        <Flex align="flex-start" gap={8} justify="space-between" wrap="wrap">
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>{review.order.orderNo} · 第 {review.cycleNo} 期</Typography.Title>
            <Typography.Text type="secondary">{review.vehicle.plateNo || review.vehicle.vin || "车辆"}</Typography.Text>
          </div>
          <Space wrap>
            {readOnly ? <Tag>只读历史</Tag> : null}
            <Tag color={presentation.color}>{presentation.label}</Tag>
          </Space>
        </Flex>
        <Alert message={guidance.kind === "ACTION" ? "请填写累计里程并上传清晰仪表盘照片。" : guidance.actionLabel} showIcon style={{ marginTop: 14 }} type={guidance.kind === "ACTION" ? "info" : "success"} />
      </section>

      <section style={cardStyle}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>复核周期与基线</Typography.Title>
        <Descriptions
          column={1}
          items={[
            { label: "复核周期", children: `${dayjs(review.periodStart).format("YYYY-MM-DD")} 至 ${dayjs(review.periodEnd).format("YYYY-MM-DD")}` },
            { label: "提交截止", children: dayjs(review.dueAt).format("YYYY-MM-DD HH:mm") },
            { label: "上期确认里程", children: `${review.baselineMileageKm.toLocaleString("zh-CN")} km` },
            { label: "提交来源", children: review.submissionSource ?? "-" },
            { label: "后台意见", children: review.reviewNote || "-" }
          ]}
        />
      </section>

      <section style={cardStyle}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>本期累计里程</Typography.Title>
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <InputNumber
            disabled={readOnly}
            min={review.baselineMileageKm}
            onChange={(value) => setMileage(value)}
            placeholder="请输入仪表盘累计里程"
            style={{ width: "100%" }}
            value={mileage}
          />
          <DatePicker disabled={readOnly} onChange={setReadingAt} showTime style={{ width: "100%" }} value={readingAt} />
          {actions.canEdit ? <Button block icon={<SaveOutlined />} loading={mutation === "draft"} onClick={saveDraft}>保存里程草稿</Button> : null}
        </Space>
      </section>

      <section style={cardStyle}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>仪表盘照片</Typography.Title>
        <Typography.Paragraph type="secondary">请确保累计里程数字清晰、完整，照片不得经过遮挡或裁切。</Typography.Paragraph>
        {actions.canEdit ? (
          <label style={uploadLabelStyle}>
            <CameraOutlined /> {mutation === "upload" ? "上传中..." : "拍照或从相册选择"}
            <input
              accept="image/*"
              capture="environment"
              disabled={Boolean(mutation)}
              onChange={(event) => void uploadEvidence(event)}
              style={{ display: "none" }}
              type="file"
            />
          </label>
        ) : null}
        <List
          dataSource={review.evidence}
          locale={{ emptyText: <Empty description="尚未上传仪表盘照片" /> }}
          renderItem={(item) => (
            <List.Item
              actions={[
                item.previewUrl ? <Button icon={<EyeOutlined />} key="preview" onClick={() => window.open(portalAssetUrl(item.previewUrl!), "_blank", "noopener,noreferrer")} type="link">预览</Button> : null,
                actions.canEdit ? <Button danger icon={<DeleteOutlined />} key="remove" loading={mutation === `remove:${item.id}`} onClick={() => void removeEvidence(item.id)} type="link">移除</Button> : null
              ].filter(Boolean)}
            >
              <List.Item.Meta description={`${formatBytes(item.sizeBytes)} · ${item.capturedAt ? dayjs(item.capturedAt).format("YYYY-MM-DD HH:mm") : "时间未记录"}`} title={item.originalName} />
            </List.Item>
          )}
        />
      </section>

      {review.status === "CONFIRMED" ? (
        <section style={cardStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>本期复核结果</Typography.Title>
          <Descriptions
            column={1}
            items={[
              { label: "本期实际行驶", children: formatKm(settlement.actualUsageKm) },
              { label: "本期可用额度", children: formatKm(settlement.allowanceKm) },
              { label: "已核销额度", children: formatKm(settlement.consumedAllowanceKm) },
              { label: "超里程", children: formatKm(settlement.overMileageKm) },
              { label: "超里程费用", children: formatMoney(settlement.overMileageAmount) }
            ]}
          />
          {settlement.overMileageBillHref ? (
            <Button block onClick={() => router.push(settlement.overMileageBillHref!)} type="primary">查看独立超里程账单</Button>
          ) : <Alert message="本期未产生超里程账单" showIcon type="success" />}
        </section>
      ) : null}

      {actions.canSubmit ? (
        <Button block icon={<SendOutlined />} loading={mutation === "submit"} onClick={submitReview} size="large" type="primary">
          提交后台复核
        </Button>
      ) : null}
    </PortalFrame>
  );
}

function PortalFrame({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "20px 12px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 760 }}>{children}</section>
    </main>
  );
}

function portalAssetUrl(path: string) {
  return `${PORTAL_API_BASE_URL.replace(/\/api$/, "")}${path}`;
}

function formatKm(value: number | null) {
  return value === null ? "-" : `${value.toLocaleString("zh-CN")} km`;
}

function formatMoney(value: number | null) {
  return value === null ? "-" : `${(value / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })} 元`;
}

function formatBytes(value?: string | null) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "-";
}

const cardStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 12,
  marginBottom: 12,
  padding: 16
};

const uploadLabelStyle = {
  alignItems: "center",
  background: "#1677ff",
  borderRadius: 8,
  color: "#ffffff",
  cursor: "pointer",
  display: "flex",
  gap: 8,
  justifyContent: "center",
  marginBottom: 12,
  minHeight: 44,
  padding: "10px 14px"
};
