"use client";

import {
  ArrowLeftOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  StopOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Divider,
  Empty,
  Flex,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";

import { STATUS_LABELS } from "../../../../constants/labels";
import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import {
  PortalApplicationDetail,
  PortalApplicationMaterialGroup
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
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [materialType, setMaterialType] = useState("ID_CARD");
  const [remark, setRemark] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  const loadApplication = useCallback(async () => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    try {
      const row = await portalApiFetch<PortalApplicationDetail>(`/portal/applications/${params.id}`);
      setApplication(row);
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
            </Space>
          </Flex>
          <Alert message={application.nextStepHint} showIcon style={{ marginTop: 16 }} type="info" />
        </section>

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

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            审核进度
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
              <Typography.Text type="secondary">当前阶段只支持取消待审核申请</Typography.Text>
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
            <Typography.Text>{file.fileName}</Typography.Text>
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
