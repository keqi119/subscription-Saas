"use client";

import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  FileSearchOutlined,
  InboxOutlined,
  UploadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Divider,
  Empty,
  Flex,
  Progress,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import { useRouter } from "next/navigation";
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import {
  PortalMaterialCompleteness,
  PortalProfileMaterial,
  PortalProfileMaterialRequirement
} from "../../../lib/portal-types";

export default function PortalMaterialsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [requirements, setRequirements] = useState<PortalProfileMaterialRequirement[]>([]);
  const [materials, setMaterials] = useState<PortalProfileMaterial[]>([]);
  const [completeness, setCompleteness] = useState<PortalMaterialCompleteness>();
  const [loading, setLoading] = useState(true);
  const [uploadingType, setUploadingType] = useState<string>();
  const [redirect, setRedirect] = useState("/portal");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRedirect(params.get("redirect") || "/portal");
  }, []);

  const loadMaterials = useCallback(async () => {
    setLoading(true);
    try {
      const [requirementRows, materialRows, completenessRow] = await Promise.all([
        portalApiFetch<PortalProfileMaterialRequirement[]>("/portal/profile/material-requirements"),
        portalApiFetch<PortalProfileMaterial[]>("/portal/profile/materials"),
        portalApiFetch<PortalMaterialCompleteness>("/portal/profile/material-completeness")
      ]);
      setRequirements(requirementRows);
      setMaterials(materialRows);
      setCompleteness(completenessRow);
    } catch (error) {
      if (error instanceof PortalApiError && error.status === 401) {
        router.replace(`/portal/login?redirect=${encodeURIComponent("/portal/materials")}`);
        return;
      }
      void message.error(error instanceof PortalApiError ? error.message : "无法加载客户资料");
    } finally {
      setLoading(false);
    }
  }, [message, router]);

  useEffect(() => {
    void loadMaterials();
  }, [loadMaterials]);

  const activeMaterialsByType = useMemo(() => {
    const rows = new Map<string, PortalProfileMaterial>();
    materials
      .filter((material) => material.materialStatus === "ACTIVE")
      .forEach((material) => rows.set(material.materialType, material));
    return rows;
  }, [materials]);

  async function uploadMaterial(type: string, file?: File) {
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append("materialType", type);
    formData.append("files", file);

    try {
      setUploadingType(type);
      await portalApiFetch<PortalProfileMaterial>("/portal/profile/materials", {
        body: formData,
        method: "POST"
      });
      void message.success("资料已上传");
      await loadMaterials();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "上传资料失败");
    } finally {
      setUploadingType(undefined);
    }
  }

  async function deleteMaterial(material: PortalProfileMaterial) {
    try {
      setUploadingType(material.materialType);
      await portalApiFetch(`/portal/profile/materials/${material.id}`, { method: "DELETE" });
      void message.success("资料已归档");
      await loadMaterials();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "删除资料失败");
    } finally {
      setUploadingType(undefined);
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

  const percent = completeness
    ? Math.round((completeness.completedCount / completeness.requiredCount) * 100)
    : 0;

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(redirect)} style={{ marginBottom: 16 }}>
          返回上一页
        </Button>

        <section style={sectionStyle}>
          <Flex align="center" gap={16} justify="space-between" wrap="wrap">
            <div>
              <Typography.Title level={3} style={{ margin: 0 }}>
                我的资料
              </Typography.Title>
              <Typography.Text type="secondary">
                资料仅用于订阅审核。提交审核后，平台工作人员会根据资料完整性和风控结果确认最终方案。
              </Typography.Text>
            </div>
            {completeness?.complete ? <Tag color="green">资料完整</Tag> : <Tag color="gold">待补充资料</Tag>}
          </Flex>
          <Divider />
          <Progress percent={percent} />
          <Typography.Text type="secondary">
            已完成 {completeness?.completedCount ?? 0} / {completeness?.requiredCount ?? requirements.length} 项必需资料
          </Typography.Text>
          {completeness && !completeness.complete ? (
            <Alert
              message="审核资料待补充"
              description={`建议补充：${completeness.missingMaterials.map((item) => item.label).join("、")}`}
              showIcon
              style={{ marginTop: 14 }}
              type="warning"
            />
          ) : null}
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            必需资料
          </Typography.Title>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {requirements.map((requirement) => (
              <MaterialRequirementRow
                key={requirement.type}
                material={activeMaterialsByType.get(requirement.type)}
                onDelete={deleteMaterial}
                onPreview={openPreview}
                onUpload={uploadMaterial}
                requirement={requirement}
                uploading={uploadingType === requirement.type}
              />
            ))}
          </Space>
        </section>

        <section style={sectionStyle}>
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            其他资料
          </Typography.Title>
          <Flex gap={10} style={{ marginBottom: 12 }} wrap="wrap">
            <UploadInput
              label="上传其他资料"
              onChange={(event) => void uploadMaterial("OTHER", event.target.files?.[0])}
              uploading={uploadingType === "OTHER"}
            />
          </Flex>
          {materials.filter((material) => material.materialType === "OTHER").length === 0 ? (
            <Empty description="暂无其他资料" />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              {materials
                .filter((material) => material.materialType === "OTHER")
                .map((material) => (
                  <MaterialFileRow
                    key={material.id}
                    material={material}
                    onDelete={deleteMaterial}
                    onPreview={openPreview}
                    uploading={uploadingType === material.materialType}
                  />
                ))}
            </Space>
          )}
        </section>
      </section>
    </main>
  );
}

function MaterialRequirementRow({
  material,
  onDelete,
  onPreview,
  onUpload,
  requirement,
  uploading
}: Readonly<{
  material?: PortalProfileMaterial;
  onDelete: (material: PortalProfileMaterial) => Promise<void>;
  onPreview: (material: PortalProfileMaterial) => void;
  onUpload: (type: string, file?: File) => Promise<void>;
  requirement: PortalProfileMaterialRequirement;
  uploading: boolean;
}>) {
  return (
    <div style={{ border: "1px solid #e5eaf2", borderRadius: 8, padding: 14 }}>
      <Flex align="center" gap={12} justify="space-between" wrap="wrap">
        <Space>
          {material ? <CheckCircleOutlined style={{ color: "#16a34a" }} /> : <InboxOutlined style={{ color: "#d48806" }} />}
          <div>
            <Typography.Text strong>{requirement.label}</Typography.Text>
            <div>
              <Tag color={requirement.required ? "blue" : "default"}>{requirement.required ? "必需" : "可选"}</Tag>
              {material ? <Tag color="green">{material.materialStatusLabel}</Tag> : <Tag color="gold">未上传</Tag>}
            </div>
          </div>
        </Space>
        <Space wrap>
          {material ? (
            <>
              <Button icon={<FileSearchOutlined />} onClick={() => onPreview(material)}>
                预览
              </Button>
              <Button danger onClick={() => void onDelete(material)}>
                归档
              </Button>
            </>
          ) : null}
          <UploadInput
            label={material ? "替换" : "上传"}
            onChange={(event) => void onUpload(requirement.type, event.target.files?.[0])}
            uploading={uploading}
          />
        </Space>
      </Flex>
      {material ? (
        <Typography.Text type="secondary">
          {material.fileName} · {formatFileSize(material.fileSize)}
        </Typography.Text>
      ) : null}
    </div>
  );
}

function MaterialFileRow({
  material,
  onDelete,
  onPreview,
  uploading
}: Readonly<{
  material: PortalProfileMaterial;
  onDelete: (material: PortalProfileMaterial) => Promise<void>;
  onPreview: (material: PortalProfileMaterial) => void;
  uploading: boolean;
}>) {
  return (
    <Flex align="center" gap={10} justify="space-between" style={{ border: "1px solid #e5eaf2", borderRadius: 8, padding: 12 }} wrap="wrap">
      <Space direction="vertical" size={2}>
        <Typography.Text strong>{material.fileName}</Typography.Text>
        <Typography.Text type="secondary">{formatFileSize(material.fileSize)}</Typography.Text>
      </Space>
      <Space>
        <Button icon={<FileSearchOutlined />} onClick={() => onPreview(material)}>
          预览
        </Button>
        <Button danger loading={uploading} onClick={() => void onDelete(material)}>
          归档
        </Button>
      </Space>
    </Flex>
  );
}

function UploadInput({
  label,
  onChange,
  uploading
}: Readonly<{
  label: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  uploading: boolean;
}>) {
  return (
    <Button icon={<UploadOutlined />} loading={uploading}>
      <label style={{ cursor: "pointer" }}>
        {label}
        <input accept="image/*,application/pdf" hidden onChange={onChange} type="file" />
      </label>
    </Button>
  );
}

function openPreview(material: PortalProfileMaterial) {
  window.open(buildPreviewUrl(material.previewUrl), "_blank", "noopener,noreferrer");
}

function buildPreviewUrl(previewUrl: string) {
  const origin = PORTAL_API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}

function formatFileSize(size?: number | null) {
  if (!size) {
    return "-";
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const sectionStyle = {
  background: "#ffffff",
  border: "1px solid #e5eaf2",
  borderRadius: 8,
  marginBottom: 16,
  padding: 18
};
