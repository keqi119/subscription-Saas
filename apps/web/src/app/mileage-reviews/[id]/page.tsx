"use client";

import {
  ArrowLeftOutlined,
  CheckOutlined,
  DeleteOutlined,
  EyeOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SaveOutlined,
  SendOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Flex,
  Input,
  InputNumber,
  List,
  Modal,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { apiFetch, API_BASE_URL } from "../../../lib/api";
import {
  buildMileageReviewSettlementView,
  getMileageReviewActions,
  getMileageReviewPresentation,
  isMileageReviewOverdue,
  validateMileageReviewSubmission,
  type MileageReviewView
} from "../../../lib/mileage-review-view-model";

export default function MileageReviewDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [review, setReview] = useState<MileageReviewView>();
  const [loading, setLoading] = useState(true);
  const [mutation, setMutation] = useState<string>();
  const [mileage, setMileage] = useState<number | null>(null);
  const [readingAt, setReadingAt] = useState<Dayjs | null>(null);
  const [fileId, setFileId] = useState("");
  const [reason, setReason] = useState("");
  const [reasonMode, setReasonMode] = useState<"RETURN" | "VOID" | null>(null);

  const applyReview = useCallback((next: MileageReviewView) => {
    setReview(next);
    setMileage(next.submittedMileageKm);
    setReadingAt(next.readingAt ? dayjs(next.readingAt) : dayjs());
  }, []);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    try {
      applyReview(await apiFetch<MileageReviewView>(`/mileage-reviews/${params.id}`));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "里程复核详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [applyReview, message, params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(path: string, body: Record<string, unknown>, method = "POST") {
    if (!review) return;
    setMutation(path);
    try {
      const next = await apiFetch<MileageReviewView>(`/mileage-reviews/${review.id}${path}`, {
        body: JSON.stringify(body),
        method
      });
      applyReview(next);
      return next;
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败，请刷新后重试");
    } finally {
      setMutation(undefined);
    }
  }

  async function saveDraft() {
    if (!review || mileage === null || !readingAt) return;
    const next = await mutate("/admin-draft", {
      lockVersion: review.lockVersion,
      readingAt: readingAt.toISOString(),
      submittedMileageKm: mileage
    }, "PUT");
    if (next) void message.success("草稿已保存");
  }

  async function submit() {
    if (!review) return;
    const errors = validateMileageReviewSubmission({
      baselineMileageKm: review.baselineMileageKm,
      evidenceCount: review.evidence.length,
      readingAt: review.readingAt,
      submittedMileageKm: review.submittedMileageKm
    });
    if (errors.length) {
      void message.warning(errors.join("；"));
      return;
    }
    const next = await mutate("/submit", { lockVersion: review.lockVersion });
    if (next) void message.success("已提交后台复核");
  }

  async function confirmReview() {
    if (!review) return;
    const next = await mutate("/confirm", {
      idempotencyKey: `admin-mileage-confirm:${review.id}:v${review.version}:${crypto.randomUUID()}`,
      lockVersion: review.lockVersion
    });
    if (next) void message.success("复核已确认并完成里程核销");
  }

  async function submitReason() {
    if (!review || !reasonMode || !reason.trim()) {
      void message.warning("请填写原因");
      return;
    }
    if (reasonMode === "RETURN") {
      const next = await mutate("/return", { lockVersion: review.lockVersion, reason: reason.trim() });
      if (next) void message.success("已退回补充资料");
    } else {
      setMutation("/void-reopen");
      try {
        const result = await apiFetch<{ replacementReview: MileageReviewView }>(
          `/mileage-reviews/${review.id}/void-reopen`,
          { body: JSON.stringify({ lockVersion: review.lockVersion, reason: reason.trim() }), method: "POST" }
        );
        void message.success("原复核已作废，已创建受控重开版本");
        router.replace(`/mileage-reviews/${result.replacementReview.id}`);
      } catch (error) {
        void message.error(error instanceof Error ? error.message : "作废重开失败");
      } finally {
        setMutation(undefined);
      }
    }
    setReason("");
    setReasonMode(null);
  }

  async function attachEvidence() {
    if (!review || !fileId.trim()) return;
    const next = await mutate("/evidence", {
      fileId: fileId.trim(),
      lockVersion: review.lockVersion
    });
    if (next) {
      setFileId("");
      void message.success("仪表盘照片已关联");
    }
  }

  async function removeEvidence(evidenceId: string) {
    if (!review) return;
    const next = await mutate(`/evidence/${evidenceId}`, { lockVersion: review.lockVersion }, "DELETE");
    if (next) void message.success("照片已移除");
  }

  if (loading) {
    return <ProtectedShell><Flex justify="center" style={{ padding: 48 }}><Spin /></Flex></ProtectedShell>;
  }
  if (!review) {
    return <ProtectedShell><Empty description="里程复核不存在或无权访问" /></ProtectedShell>;
  }

  const actions = getMileageReviewActions(review, "ADMIN");
  const presentation = getMileageReviewPresentation(review.status, isMileageReviewOverdue(review));
  const settlement = buildMileageReviewSettlementView(review);

  return (
    <ProtectedShell>
      <Space orientation="vertical" size={14} style={{ width: "100%" }}>
        <Flex justify="space-between" wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/mileage-reviews")}>返回复核队列</Button>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        </Flex>

        <Card
          extra={<Tag color={presentation.color}>{presentation.label}</Tag>}
          title={`${review.order.orderNo} · 第 ${review.cycleNo} 期 / V${review.version}`}
        >
          <Descriptions
            column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
            items={[
              { label: "车辆", children: [review.vehicle.plateNo, review.vehicle.brand, review.vehicle.model].filter(Boolean).join(" / ") || "-" },
              { label: "VIN", children: review.vehicle.vin || "-" },
              { label: "周期", children: `${dayjs(review.periodStart).format("YYYY-MM-DD")} 至 ${dayjs(review.periodEnd).format("YYYY-MM-DD")}` },
              { label: "计划复核", children: dayjs(review.scheduledReviewAt).format("YYYY-MM-DD HH:mm") },
              { label: "提交截止", children: dayjs(review.dueAt).format("YYYY-MM-DD HH:mm") },
              { label: "基线里程", children: `${review.baselineMileageKm.toLocaleString("zh-CN")} km` },
              { label: "提交来源", children: review.submissionSource ?? "-" },
              { label: "提交时间", children: review.submittedAt ? dayjs(review.submittedAt).format("YYYY-MM-DD HH:mm") : "-" },
              { label: "复核意见", children: review.reviewNote || "-" }
            ]}
          />
        </Card>

        <Card title="里程与仪表盘证据">
          {actions.canEdit ? (
            <Space orientation="vertical" size={12} style={{ width: "100%" }}>
              <Flex gap={12} wrap="wrap">
                <InputNumber min={review.baselineMileageKm} onChange={(value) => setMileage(value)} placeholder="当前累计里程" style={{ minWidth: 220 }} value={mileage} />
                <DatePicker onChange={setReadingAt} showTime style={{ minWidth: 220 }} value={readingAt} />
                <Button icon={<SaveOutlined />} loading={mutation === "/admin-draft"} onClick={saveDraft}>保存草稿</Button>
              </Flex>
              <Alert message="后台证据仅可关联当前操作人已上传且位于私有存储中的图片 File ID。" showIcon type="info" />
              <Flex gap={8} wrap="wrap">
                <Input onChange={(event) => setFileId(event.target.value)} placeholder="私有图片 File ID" style={{ maxWidth: 440 }} value={fileId} />
                <Button disabled={!fileId.trim()} loading={mutation === "/evidence"} onClick={attachEvidence}>关联照片</Button>
              </Flex>
            </Space>
          ) : null}

          <List
            dataSource={review.evidence}
            locale={{ emptyText: "尚未上传仪表盘照片" }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  item.previewUrl ? <Button icon={<EyeOutlined />} key="preview" onClick={() => window.open(apiAssetUrl(item.previewUrl!), "_blank", "noopener,noreferrer")} type="link">预览</Button> : null,
                  actions.canEdit ? <Button danger icon={<DeleteOutlined />} key="delete" onClick={() => void removeEvidence(item.id)} type="link">移除</Button> : null
                ].filter(Boolean)}
              >
                <List.Item.Meta description={`${item.submissionSource ?? "-"} · ${formatBytes(item.sizeBytes)}`} title={item.originalName} />
              </List.Item>
            )}
          />
        </Card>

        {review.status === "CONFIRMED" ? (
          <Card title="确认结算结果">
            <Descriptions
              column={{ md: 3, sm: 1, xs: 1 }}
              items={[
                { label: "本期实际行驶", children: formatKm(settlement.actualUsageKm) },
                { label: "本期可用额度", children: formatKm(settlement.allowanceKm) },
                { label: "已核销额度", children: formatKm(settlement.consumedAllowanceKm) },
                { label: "超里程", children: formatKm(settlement.overMileageKm) },
                { label: "超里程应收", children: formatMoney(settlement.overMileageAmount) },
                { label: "独立账单", children: review.overMileageBillId ? <Link href={`/billing/collections?billId=${encodeURIComponent(review.overMileageBillId)}`}>{review.overMileageBill?.billNo || review.overMileageBillId}</Link> : "未产生" },
                { label: "里程台账", children: review.mileageReadingId || "-" },
                { label: "权益核销", children: review.entitlementUsageId || "0 km，无核销流水" }
              ]}
            />
          </Card>
        ) : null}

        <Card title="可执行操作">
          <Space wrap>
            {actions.canSubmit ? <Button icon={<SendOutlined />} loading={mutation === "/submit"} onClick={submit} type="primary">提交复核</Button> : null}
            {actions.canReturn ? <Button icon={<RollbackOutlined />} onClick={() => setReasonMode("RETURN")}>退回补充</Button> : null}
            {actions.canConfirm ? <Button icon={<CheckOutlined />} loading={mutation === "/confirm"} onClick={confirmReview} type="primary">确认并结算</Button> : null}
            {actions.canVoid ? <Button danger icon={<DeleteOutlined />} onClick={() => setReasonMode("VOID")}>作废并重开</Button> : null}
            {!actions.canEdit && !actions.canConfirm && !actions.canReturn && !actions.canVoid ? <Typography.Text type="secondary">当前状态无可执行操作。</Typography.Text> : null}
          </Space>
        </Card>
      </Space>

      <Modal
        confirmLoading={mutation === "/return" || mutation === "/void-reopen"}
        okButtonProps={{ danger: reasonMode === "VOID" }}
        okText={reasonMode === "VOID" ? "确认作废并重开" : "确认退回"}
        onCancel={() => { setReason(""); setReasonMode(null); }}
        onOk={submitReason}
        open={reasonMode !== null}
        title={reasonMode === "VOID" ? "受控作废并重开" : "退回客户补充"}
      >
        {reasonMode === "VOID" ? <Alert message="已支付的超里程账单或存在后续已确认周期时，系统会拒绝作废。" showIcon style={{ marginBottom: 12 }} type="warning" /> : null}
        <Input.TextArea maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="请填写完整原因" rows={4} value={reason} />
      </Modal>
    </ProtectedShell>
  );
}

function apiAssetUrl(path: string) {
  return `${API_BASE_URL.replace(/\/api$/, "")}${path}`;
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
