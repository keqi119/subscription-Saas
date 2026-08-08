"use client";

import { DeleteOutlined, EyeOutlined, UploadOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Form,
  Input,
  Space,
  Table,
  Tooltip,
  Typography,
  Upload
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import { useState } from "react";

import { API_BASE_URL, apiFetch } from "../../lib/api";
import { formatDateTime, getErrorMessage } from "../../lib/capital-format";
import {
  VEHICLE_LISTING_SOURCE_SECTION_LABELS,
  type VehicleListingSourceSection
} from "../../lib/vehicle-listing-workspace";

export interface PolicyDocumentRow {
  boundListingSections: VehicleListingSourceSection[];
  createdAt: string;
  description?: string | null;
  fileName: string;
  id: string;
  previewUrl: string;
}

interface PolicyDocumentPanelProps {
  documents: PolicyDocumentRow[];
  onChanged: () => Promise<void> | void;
  policyId: string;
}

interface UploadFormValues {
  description?: string | null;
}

export function PolicyDocumentPanel({
  documents,
  onChanged,
  policyId
}: PolicyDocumentPanelProps) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<UploadFormValues>();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function uploadDocuments(values: UploadFormValues) {
    const files = fileList.flatMap((file) =>
      file.originFileObj ? [file.originFileObj] : []
    );
    if (files.length === 0) {
      void message.warning("请选择保单附件");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file, file.name);
      }
      const description = values.description?.trim();
      if (description) {
        formData.append("description", description);
      }
      await apiFetch(`/vehicle-insurance-policies/${policyId}/documents`, {
        body: formData,
        method: "POST"
      });
      form.resetFields();
      setFileList([]);
      void message.success("保单附件已上传");
      await onChanged();
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  function confirmDelete(document: PolicyDocumentRow) {
    modal.confirm({
      content: `删除后仅保留审计记录，不再显示文件“${document.fileName}”。`,
      okButtonProps: { danger: true },
      okText: "确认删除",
      onOk: async () => {
        setDeletingId(document.id);
        try {
          await apiFetch(`/vehicle-documents/${document.id}`, { method: "DELETE" });
          void message.success("保单附件已删除");
          await onChanged();
        } catch (error) {
          void message.error(getErrorMessage(error));
          throw error;
        } finally {
          setDeletingId(null);
        }
      },
      title: "删除错误附件？"
    });
  }

  const columns: ColumnsType<PolicyDocumentRow> = [
    { dataIndex: "fileName", title: "文件名" },
    {
      dataIndex: "createdAt",
      render: (value: string) => formatDateTime(value),
      title: "上传时间",
      width: 170
    },
    {
      dataIndex: "description",
      render: (value?: string | null) => value || "-",
      title: "备注"
    },
    {
      render: (_, document) => {
        const boundLabels = document.boundListingSections.map(
          (section) => VEHICLE_LISTING_SOURCE_SECTION_LABELS[section]
        );
        const deleteButton = (
          <Button
            danger
            disabled={boundLabels.length > 0}
            icon={<DeleteOutlined />}
            loading={deletingId === document.id}
            onClick={() => confirmDelete(document)}
            size="small"
            type="link"
          >
            删除
          </Button>
        );
        return (
          <Space>
            <Button
              href={buildAdminPreviewUrl(document.previewUrl)}
              icon={<EyeOutlined />}
              size="small"
              target="_blank"
              type="link"
            >
              预览
            </Button>
            {boundLabels.length > 0 ? (
              <Tooltip title={`已用于${boundLabels.join("、")}，请先解除商品引用`}>
                <span>{deleteButton}</span>
              </Tooltip>
            ) : (
              deleteButton
            )}
          </Space>
        );
      },
      title: "操作",
      width: 150
    }
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        保单附件
      </Typography.Title>
      <Table
        columns={columns}
        dataSource={documents}
        pagination={false}
        rowKey="id"
        size="small"
      />
      <Form form={form} layout="vertical" onFinish={uploadDocuments}>
        <Form.Item label="备注" name="description">
          <Input.TextArea maxLength={1000} rows={2} showCount />
        </Form.Item>
        <Upload
          beforeUpload={() => false}
          fileList={fileList}
          maxCount={20}
          multiple
          onChange={({ fileList: next }) => setFileList(next)}
        >
          <Button icon={<UploadOutlined />}>选择文件（最多 20 个）</Button>
        </Upload>
        <Button
          htmlType="submit"
          loading={uploading}
          style={{ marginTop: 12 }}
          type="primary"
        >
          上传
        </Button>
      </Form>
    </Space>
  );
}

function buildAdminPreviewUrl(previewUrl: string) {
  const origin = API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}
