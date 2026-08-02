"use client";

import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  StopOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Divider,
  Empty,
  Flex,
  Input,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography
} from "antd";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  PORTAL_FINAL_PLAN_STATUS_LABELS,
  PORTAL_NEXT_ACTION_LABELS,
  PORTAL_PROGRESS_STATUS_LABELS,
  STATUS_LABELS
} from "../../../../constants/labels";
import { buildPortalApplicationNextActionCard } from "../../../../lib/portal-application-next-action-view-model";
import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  PortalApplicationDetail,
  PortalApplicationMaterialGroup,
  PortalApplicationProgress,
  PortalApplicationProgressStep,
  PortalFinalPlan
} from "../../../../lib/portal-types";

const MATERIAL_TYPE_OPTIONS = [
  { label: "身份证", value: "ID_CARD" },
  { label: "驾驶证", value: "DRIVER_LICENSE" },
  { label: "银行流水", value: "BANK_FLOW" },
  { label: "工作证明", value: "WORK_PROOF" },
  { label: "居住证明", value: "RESIDENCE_PROOF" },
  { label: "征信授权", value: "CREDIT_AUTH" },
  { label: "其他", value: "OTHER" }
];

export default function PortalApplicationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [application, setApplication] = useState<PortalApplicationDetail>();
  const [progress, setProgress] = useState<PortalApplicationProgress>();
  const [finalPlan, setFinalPlan] = useState<PortalFinalPlan>();
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [finalPlanSubmitting, setFinalPlanSubmitting] = useState(false);
  const [materialType, setMaterialType] = useState("ID_CARD");
  const [remark, setRemark] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  const loadApplication = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      const [row, progressRow, finalPlanRow] = await Promise.all([
        portalApiFetch<PortalApplicationDetail>(`/portal/applications/${params.id}`),
        portalApiFetch<PortalApplicationProgress>(`/portal/applications/${params.id}/progress`),
        portalApiFetch<PortalFinalPlan>(`/portal/applications/${params.id}/final-plan`)
      ]);
      setApplication(row);
      setProgress(progressRow);
      setFinalPlan(finalPlanRow);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/applications/${params.id}`)}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载申请详情");
    } finally {
      setLoading(false);
    }
  }, [message, params.id, router]);

  useEffect(() => {
    void loadApplication();
  }, [loadApplication]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  async function uploadMaterials() {
    if (!params.id || files.length === 0) {
      void message.error("请选择要上传的材料文件");
      return;
    }

    const formData = new FormData();
    formData.append("materialType", materialType);
    if (remark.trim()) {
      formData.append("remark", remark.trim());
    }
    files.forEach((file) => formData.append("files", file));

    try {
      setUploading(true);
      await portalApiFetch(`/portal/applications/${params.id}/materials`, {
        body: formData,
        method: "POST"
      });
      void message.success("材料已上传");
      setFiles([]);
      setRemark("");
      if (inputRef.current) {
        inputRef.current.value = "";
      }
      await loadApplication();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "上传材料失败");
    } finally {
      setUploading(false);
    }
  }

  function confirmCancel() {
    modal.confirm({
      content: "取消后将释放当前审核占用车辆，后续如需订阅请重新提交审核。",
      okText: "确认取消",
      onOk: cancelApplication,
      title: "取消申请",
      type: "warning"
    });
  }

  async function cancelApplication() {
    if (!params.id) {
      return;
    }

    try {
      setCanceling(true);
      await portalApiFetch(`/portal/applications/${params.id}/cancel`, { method: "POST" });
      void message.success("申请已取消");
      await loadApplication();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "取消申请失败");
    } finally {
      setCanceling(false);
    }
  }

  function openConfirmFinalPlanModal() {
    modal.confirm({
      content: "确认后将由平台生成正式订单，再进入合同签署流程。请仔细核对车辆、套餐、月租、押金和订阅周期。",
      okText: "确认最终方案",
      onOk: confirmFinalPlan,
      title: "确认最终方案",
      type: "confirm"
    });
  }

  async function confirmFinalPlan() {
    if (!params.id) {
      return;
    }

    try {
      setFinalPlanSubmitting(true);
      await portalApiFetch(`/portal/applications/${params.id}/final-plan/confirm`, { method: "POST" });
      void message.success("已确认最终方案，等待平台生成正式订单");
      await loadApplication();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "确认最终方案失败");
      throw error;
    } finally {
      setFinalPlanSubmitting(false);
    }
  }

  function openRejectFinalPlanModal() {
    let reason = "";
    modal.confirm({
      content: (
        <Input.TextArea
          autoSize={{ maxRows: 5, minRows: 3 }}
          onChange={(event) => {
            reason = event.target.value;
          }}
          placeholder="请填写暂不接受方案的原因"
        />
      ),
      okButtonProps: { danger: true },
      okText: "提交原因",
      onOk: async () => {
        if (!reason.trim()) {
          void message.error("请填写拒绝原因");
          throw new Error("reject reason required");
        }
        await rejectFinalPlan(reason.trim());
      },
      title: "暂不接受方案",
      type: "warning"
    });
  }

  async function rejectFinalPlan(reason: string) {
    if (!params.id) {
      return;
    }

    try {
      setFinalPlanSubmitting(true);
      await portalApiFetch(`/portal/applications/${params.id}/final-plan/reject`, {
        body: JSON.stringify({ reason }),
        method: "POST"
      });
      void message.success("已提交反馈，平台将继续处理");
      await loadApplication();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "提交反馈失败");
      throw error;
    } finally {
      setFinalPlanSubmitting(false);
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

  if (!application) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="申请不存在" />
      </main>
    );
  }

  const canConfirmFinalPlan = finalPlan?.finalPlanStatus === "PENDING_CONFIRM" &&
    progress?.nextAction === "CONFIRM_FINAL_PLAN";
  const canRejectFinalPlan = canConfirmFinalPlan;
  const nextActionCard = buildPortalApplicationNextActionCard(progress, application.nextStepHint);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Flex justify="space-between" style={{ marginBottom: 16 }} wrap="wrap">
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/applications")}>
            返回申请列表
          </Button>
          <Button onClick={() => router.push("/portal/catalog")}>继续选车</Button>
        </Flex>

        <section style={sectionStyle}>
          <Flex align="flex-start" justify="space-between" gap={16} wrap="wrap">
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {application.applicationNo}
              </Typography.Title>
              <Typography.Text type="secondary">{application.vehicle.displayName || "意向车辆"}</Typography.Text>
            </div>
            <Space size={[6, 6]} wrap>
              <Tag color="blue">{STATUS_LABELS[application.status] ?? application.status}</Tag>
              <Tag>{STATUS_LABELS[application.depositStatus] ?? application.depositStatus}</Tag>
              <Tag>{PORTAL_NEXT_ACTION_LABELS[progress?.nextAction ?? "WAIT_REVIEW"] ?? progress?.nextAction}</Tag>
            </Space>
          </Flex>
          <Alert
            action={nextActionCard ? (
              <Button onClick={() => router.push(nextActionCard.url)} type="link">
                {nextActionCard.label}
              </Button>
            ) : undefined}
            message={nextActionCard?.message ?? application.nextStepHint}
            showIcon
            style={{ marginTop: 16 }}
            type={nextActionCard?.tone ?? "info"}
          />
          {!application.materialComplete && application.missingMaterials.length > 0 ? (
            <Alert
              action={
                <Button
                  onClick={() => router.push(`/portal/materials?redirect=${encodeURIComponent(`/portal/applications/${application.id}`)}`)}
                  type="link"
                >
                  去补充资料
                </Button>
              }
              description={`为加快审核，请补充以下资料：${application.missingMaterials
                .map((item) => item.label)
                .join("、")}`}
              message="审核资料待补充"
              showIcon
              style={{ marginTop: 12 }}
              type="warning"
            />
          ) : null}
          {progress?.nextAction === "CONFIRM_FINAL_PLAN" ? (
            <Alert
              message="最终方案已生成，请确认车辆、套餐、月租、押金和订阅周期。"
              showIcon
              style={{ marginTop: 12 }}
              type="warning"
            />
          ) : null}
          {progress?.nextAction === "WAIT_ORDER_CREATION" ||
          progress?.nextAction === "GO_CONTRACT_PENDING_BACKOFFICE" ? (
            <Alert
              message="已确认最终方案，等待平台生成正式订单。"
              showIcon
              style={{ marginTop: 12 }}
              type="success"
            />
          ) : null}
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            申请进度
          </Typography.Title>
          {progress ? (
            <Steps
              current={Math.max(0, progress.steps.findIndex((step) => step.status === "CURRENT"))}
              direction="vertical"
              items={progress.steps.map((step) => ({
                description: <ProgressStepDescription step={step} />,
                status: mapStepStatus(step.status),
                title: step.label
              }))}
            />
          ) : (
            <Empty description="暂无进度" />
          )}
        </section>

        {progress?.nextAction === "UPLOAD_MATERIAL" ? (
          <section style={sectionStyle}>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              材料补充提示
            </Typography.Title>
            <Space direction="vertical" style={{ width: "100%" }}>
              {progress.materialSupplementHints.length > 0 ? (
                progress.materialSupplementHints.map((hint) => (
                  <Alert key={hint.materialGroupId} message={hint.materialName} description={hint.message} showIcon type="warning" />
                ))
              ) : (
                <Alert message="请根据平台提示补充材料。" showIcon type="warning" />
              )}
            </Space>
          </section>
        ) : null}

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            意向方案
          </Typography.Title>
          <Space direction="vertical" size={8}>
            <Typography.Text>
              车辆：{application.vehicle.displayName || "待确认"} · {application.vehicle.city ?? "待确认城市"}
            </Typography.Text>
            <Typography.Text>套餐：{application.plan.planName ?? "待确认"}</Typography.Text>
            <Typography.Text>周期：{application.plan.subscriptionPeriodMonths ?? "-"} 个月</Typography.Text>
            <Typography.Text>{application.plan.monthlyFeeDescription}</Typography.Text>
            <Typography.Text>{application.plan.depositDescription}</Typography.Text>
          </Space>
        </section>

        {finalPlan && finalPlan.finalPlanStatus !== "NOT_READY" ? (
          <section style={sectionStyle}>
            <Flex align="center" justify="space-between" gap={12} wrap="wrap">
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  最终方案
                </Typography.Title>
                <Typography.Text type="secondary">
                  {PORTAL_FINAL_PLAN_STATUS_LABELS[finalPlan.finalPlanStatus] ?? finalPlan.finalPlanStatus}
                </Typography.Text>
              </div>
              <Tag color={finalPlan.finalPlanStatus === "CONFIRMED" ? "green" : finalPlan.finalPlanStatus === "REJECTED" ? "red" : "gold"}>
                {PORTAL_FINAL_PLAN_STATUS_LABELS[finalPlan.finalPlanStatus] ?? finalPlan.finalPlanStatus}
              </Tag>
            </Flex>
            <Divider />
            <Descriptions
              column={1}
              items={[
                {
                  label: "车辆",
                  children: finalPlan.vehicle?.displayName || "待确认"
                },
                {
                  label: "所在城市",
                  children: finalPlan.vehicle?.city ?? "-"
                },
                {
                  label: "套餐",
                  children: finalPlan.subscriptionPlan?.planName ?? "-"
                },
                {
                  label: "订阅周期",
                  children: `${finalPlan.subscriptionPlan?.periodMonths ?? "-"} 个月`
                },
                {
                  label: "月租",
                  children: formatMoney(finalPlan.pricing?.monthlyFeeAmount)
                },
                {
                  label: "押金",
                  children: formatMoney(finalPlan.pricing?.finalDepositAmount)
                }
              ]}
            />
            {finalPlan.subscriptionPlan?.packageSummary.length ? (
              <Space size={[6, 6]} style={{ marginTop: 12 }} wrap>
                {finalPlan.subscriptionPlan.packageSummary.map((item) => (
                  <Tag key={item}>{item}</Tag>
                ))}
              </Space>
            ) : null}
            {finalPlan.changes?.length ? (
              <Space direction="vertical" style={{ marginTop: 14, width: "100%" }}>
                {finalPlan.changes.map((change) => (
                  <Alert key={change.field} message={change.label} description={change.message} showIcon type="info" />
                ))}
              </Space>
            ) : null}
            {finalPlan.importantNotes?.length ? (
              <Space direction="vertical" style={{ marginTop: 14, width: "100%" }}>
                {finalPlan.importantNotes.map((note) => (
                  <Alert key={note} message={note} showIcon type={finalPlan.finalPlanStatus === "CONFIRMED" ? "success" : "warning"} />
                ))}
              </Space>
            ) : null}
            {finalPlan.rejectedReason ? (
              <Alert message="拒绝原因" description={finalPlan.rejectedReason} showIcon style={{ marginTop: 14 }} type="warning" />
            ) : null}
            <Flex gap={10} justify="flex-end" style={{ marginTop: 16 }} wrap="wrap">
              <Button
                danger
                disabled={!canRejectFinalPlan}
                loading={finalPlanSubmitting}
                onClick={openRejectFinalPlanModal}
              >
                暂不接受方案
              </Button>
              <Button
                disabled={!canConfirmFinalPlan}
                icon={<CheckCircleOutlined />}
                loading={finalPlanSubmitting}
                onClick={openConfirmFinalPlanModal}
                type="primary"
              >
                确认最终方案
              </Button>
            </Flex>
          </section>
        ) : null}

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            审核状态
          </Typography.Title>
          <Space size={[8, 8]} wrap>
            <ReviewTag label="材料" value={application.reviewStatus.material} />
            <ReviewTag label="信用" value={application.reviewStatus.credit} />
            <ReviewTag label="产品" value={application.reviewStatus.product} />
            <ReviewTag label="车辆" value={application.reviewStatus.vehicle} />
            <ReviewTag label="方案确认" value={application.planConfirmStatus} />
          </Space>
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" wrap="wrap">
            <Typography.Title level={4} style={{ margin: 0 }}>
              申请材料
            </Typography.Title>
            <Tag>预览走接口鉴权，不暴露 OSS 地址</Tag>
          </Flex>
          <Divider />
          <Space direction="vertical" style={{ width: "100%" }}>
            <Select
              onChange={setMaterialType}
              options={MATERIAL_TYPE_OPTIONS}
              style={{ width: 220 }}
              value={materialType}
            />
            <Input.TextArea
              onChange={(event) => setRemark(event.target.value)}
              placeholder="补充说明，可选"
              rows={2}
              value={remark}
            />
            <input multiple onChange={onFileChange} ref={inputRef} type="file" />
            <Button icon={<UploadOutlined />} loading={uploading} onClick={uploadMaterials} type="primary">
              上传材料
            </Button>
          </Space>

          <Divider />
          {application.materials.length === 0 ? (
            <Empty description="暂无材料" />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              {application.materials.map((group) => (
                <MaterialGroup key={group.id} group={group} />
              ))}
            </Space>
          )}
        </section>

        <section style={sectionStyle}>
          <Flex align="center" justify="space-between" wrap="wrap">
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>
                申请操作
              </Typography.Title>
              <Typography.Text type="secondary">当前阶段支持取消待审核申请</Typography.Text>
            </div>
            <Button
              danger
              disabled={!application.canCancel}
              icon={<StopOutlined />}
              loading={canceling}
              onClick={confirmCancel}
            >
              取消申请
            </Button>
          </Flex>
        </section>
      </section>
    </main>
  );
}

function ProgressStepDescription({ step }: { step: PortalApplicationProgressStep }) {
  return (
    <Space direction="vertical" size={4}>
      <Typography.Text type="secondary">
        {PORTAL_PROGRESS_STATUS_LABELS[step.status] ?? step.status}
      </Typography.Text>
      {step.message ? <Typography.Text type="secondary">{step.message}</Typography.Text> : null}
      {step.time ? <Typography.Text type="secondary">{formatTime(step.time)}</Typography.Text> : null}
    </Space>
  );
}

function ReviewTag({ label, value }: { label: string; value: string }) {
  return (
    <Tag color={value === "APPROVED" || value === "CONFIRMED" ? "green" : value === "REJECTED" ? "red" : "blue"}>
      {label}：{STATUS_LABELS[value] ?? value}
    </Tag>
  );
}

function MaterialGroup({ group }: { group: PortalApplicationMaterialGroup }) {
  return (
    <div style={{ border: "1px solid #e5eaf2", borderRadius: 8, padding: 14 }}>
      <Flex align="center" gap={8} justify="space-between" wrap="wrap">
        <Space>
          <FileAddOutlined />
          <Typography.Text strong>{group.materialName}</Typography.Text>
          <Tag>{STATUS_LABELS[group.reviewStatus] ?? group.reviewStatus}</Tag>
        </Space>
        {group.required ? <Tag color="blue">必传</Tag> : null}
      </Flex>
      {group.reviewComment ? (
        <Alert message={group.reviewComment} style={{ marginTop: 10 }} type="warning" />
      ) : null}
      <Space direction="vertical" style={{ marginTop: 12, width: "100%" }}>
        {group.files.map((file) => (
          <Flex align="center" gap={8} justify="space-between" key={file.id} wrap="wrap">
            <Space>
              <Typography.Text>{file.fileName}</Typography.Text>
              {file.sourceLabel ? <Tag>{file.sourceLabel}</Tag> : null}
            </Space>
            <Button
              icon={<FileSearchOutlined />}
              onClick={() => window.open(buildPreviewUrl(file.previewUrl), "_blank", "noopener,noreferrer")}
              type="link"
            >
              预览
            </Button>
          </Flex>
        ))}
      </Space>
    </div>
  );
}

function mapStepStatus(status: PortalApplicationProgressStep["status"]) {
  if (status === "DONE") {
    return "finish" as const;
  }
  if (status === "FAILED") {
    return "error" as const;
  }
  if (status === "CURRENT") {
    return "process" as const;
  }
  return "wait" as const;
}

function formatMoney(amount?: number | null) {
  if (amount === null || amount === undefined) {
    return "-";
  }
  return `¥${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function buildPreviewUrl(previewUrl: string) {
  const origin = PORTAL_API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 16,
  padding: 18
};
