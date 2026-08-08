"use client";

import { FileImageOutlined, UploadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  List,
  Progress,
  Row,
  Spin,
  Tag,
  Typography,
  Upload
} from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import { useCallback, useEffect, useMemo, useState } from "react";

import { API_BASE_URL, ApiError, apiFetch } from "../../lib/api";
import {
  RIGHTS_DOCUMENT_LABELS,
  buildVehicleDocumentBatchFormData,
  canArchiveDocumentBatch,
  getActiveBatchFileCount,
  getDocumentBatchFileLimit,
  getOtherInternalDocumentBatches,
  getRightsDocumentCompleteness,
  getRightsDocumentGroups,
  isAdditiveRightsDocumentType,
  type RightsDocumentType,
  type VehicleDocumentBatchView
} from "../../lib/vehicle-document-workspace";
import type { VehicleWorkspaceTabProps } from "./vehicle-workspace-types";

interface VehicleListingSourceBindingView {
  document: {
    id: string;
  };
  id: string;
  section: "CONFIGURATION_SHEET" | "CONDITION_REPORT";
  vehicleId: string;
}

const OTHER_INTERNAL_DOCUMENT_LABELS: Record<string, string> = {
  INSPECTION_CERTIFICATE: "年检材料",
  OTHER: "其他材料",
  VEHICLE_AUTHORIZATION: "车辆授权材料"
};

export function VehicleDocumentsTab({
  onVehicleChanged,
  permissions,
  vehicle
}: Readonly<VehicleWorkspaceTabProps>) {
  const vehicleId = vehicle.id;
  const canManage = permissions.has("vehicle_document:manage");
  const [batches, setBatches] = useState<VehicleDocumentBatchView[]>([]);
  const [bindings, setBindings] = useState<VehicleListingSourceBindingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<RightsDocumentType | null>(null);
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [archivingBatchId, setArchivingBatchId] = useState<string | null>(null);

  const loadWorkspace = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const [nextBatches, nextBindings] = await Promise.all([
          apiFetch<VehicleDocumentBatchView[]>(
            `/vehicles/${encodeURIComponent(vehicleId)}/document-batches`,
            { signal }
          ),
          apiFetch<VehicleListingSourceBindingView[]>(
            `/vehicles/${encodeURIComponent(vehicleId)}/listing-source-bindings`,
            { signal }
          )
        ]);
        setBatches(nextBatches);
        setBindings(nextBindings);
      } catch (loadError) {
        if (!signal?.aborted) {
          setError(errorMessage(loadError));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [vehicleId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [loadWorkspace]);

  const groups = useMemo(() => getRightsDocumentGroups(batches), [batches]);
  const completeness = useMemo(() => getRightsDocumentCompleteness(batches), [batches]);
  const otherBatches = useMemo(() => getOtherInternalDocumentBatches(batches), [batches]);
  const boundDocumentLabels = useMemo(
    () =>
      new Map(
        bindings.map((binding) => [
          binding.document.id,
          binding.section === "CONFIGURATION_SHEET"
            ? "商品配置单已引用"
            : "商品车况报告已引用"
        ])
      ),
    [bindings]
  );
  const boundDocumentIds = useMemo(
    () => new Set(boundDocumentLabels.keys()),
    [boundDocumentLabels]
  );
  const selectedGroup = selectedType
    ? groups.find((group) => group.documentType === selectedType) ?? null
    : null;
  const fileLimit = selectedType ? getDocumentBatchFileLimit(selectedType) : 1;

  async function uploadBatch() {
    if (!selectedType) {
      return;
    }
    const files = uploadFiles.flatMap((file) => (file.originFileObj ? [file.originFileObj] : []));
    if (files.length === 0) {
      setError("请至少选择一个文件");
      return;
    }

    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const body = buildVehicleDocumentBatchFormData(selectedType, files);
      await apiFetch(`/vehicles/${encodeURIComponent(vehicleId)}/document-batches`, {
        body,
        method: "POST"
      });
      setUploadFiles([]);
      setNotice("权证批次上传成功");
      await Promise.all([loadWorkspace(), onVehicleChanged()]);
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setUploading(false);
    }
  }

  async function archiveBatch(batchId: string) {
    setArchivingBatchId(batchId);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/vehicle-document-batches/${encodeURIComponent(batchId)}/archive`, {
        method: "POST"
      });
      setNotice("权证批次已归档");
      await Promise.all([loadWorkspace(), onVehicleChanged()]);
    } catch (archiveError) {
      setError(errorMessage(archiveError));
    } finally {
      setArchivingBatchId(null);
    }
  }

  return (
    <Flex data-vehicle-documents-tab="true" gap={16} vertical>
      {error ? <Alert closable message={error} onClose={() => setError(null)} type="error" /> : null}
      {notice ? <Alert closable message={notice} onClose={() => setNotice(null)} type="success" /> : null}
      <Card title="权证完整度">
        <Flex align="center" gap={16} wrap>
          <Progress
            percent={Math.round((completeness.completed / completeness.total) * 100)}
            size={[240, 12]}
          />
          <Typography.Text strong>
            {completeness.completed} / {completeness.total} 类已齐全
          </Typography.Text>
        </Flex>
      </Card>

      <Spin spinning={loading}>
        <Row gutter={[16, 16]}>
          {groups.map((group) => {
            const latest = group.batches[0];
            const activeFileCount = latest ? getActiveBatchFileCount(latest) : 0;
            return (
              <Col key={group.documentType} lg={6} md={8} sm={12} xs={24}>
                <Card
                  actions={[
                    <Button key="detail" onClick={() => setSelectedType(group.documentType)} type="link">
                      查看版本与上传
                    </Button>
                  ]}
                  extra={activeFileCount > 0 ? <Tag color="green">已齐全</Tag> : <Tag>缺失</Tag>}
                  style={{ height: "100%" }}
                  title={group.label}
                >
                  {latest ? (
                    <Descriptions column={1} size="small">
                      <Descriptions.Item label="最新版本">V{latest.versionNo}</Descriptions.Item>
                      <Descriptions.Item label="有效文件">{activeFileCount} 个</Descriptions.Item>
                      <Descriptions.Item label="上传时间">{formatDateTime(latest.createdAt)}</Descriptions.Item>
                    </Descriptions>
                  ) : (
                    <Empty description="尚未上传" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  )}
                </Card>
              </Col>
            );
          })}
        </Row>
      </Spin>

      <Card title="其他内部材料">
        {otherBatches.length === 0 ? (
          <Empty description="暂无其他内部材料" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            dataSource={otherBatches}
            renderItem={(batch) => (
              <List.Item>
                <List.Item.Meta
                  avatar={<FileImageOutlined />}
                  description={`V${batch.versionNo} · ${getActiveBatchFileCount(batch)} 个文件 · ${formatDateTime(batch.createdAt)}`}
                  title={OTHER_INTERNAL_DOCUMENT_LABELS[batch.documentType] ?? batch.documentType}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Drawer
        destroyOnHidden
        onClose={() => {
          setSelectedType(null);
          setUploadFiles([]);
        }}
        open={Boolean(selectedGroup)}
        size="large"
        title={selectedGroup ? RIGHTS_DOCUMENT_LABELS[selectedGroup.documentType] : "权证资料"}
      >
        {selectedGroup ? (
          <Flex gap={16} vertical>
            {isAdditiveRightsDocumentType(selectedGroup.documentType) ? (
              <Alert message="支付凭证为追加型资料，新批次不会替换历史有效回单。" type="info" />
            ) : null}

            {canManage ? (
              <Card title="上传新批次">
                <Flex gap={12} vertical>
                  <Upload
                    accept="image/*,application/pdf"
                    beforeUpload={() => false}
                    fileList={uploadFiles}
                    maxCount={fileLimit}
                    multiple={fileLimit > 1}
                    onChange={({ fileList }) => setUploadFiles(fileList.slice(-fileLimit))}
                  >
                    <Button icon={<UploadOutlined />}>选择文件（最多 {fileLimit} 个）</Button>
                  </Upload>
                  <Button
                    disabled={uploadFiles.length === 0}
                    loading={uploading}
                    onClick={() => void uploadBatch()}
                    type="primary"
                  >
                    上传为一个批次
                  </Button>
                </Flex>
              </Card>
            ) : null}

            <Card title="版本历史">
              {selectedGroup.batches.length === 0 ? (
                <Empty description="暂无版本" />
              ) : (
                <List
                  dataSource={selectedGroup.batches}
                  renderItem={(batch) => {
                    const archiveEnabled = canArchiveDocumentBatch(batch, boundDocumentIds);
                    const hasBoundDocument = batch.items.some((document) =>
                      boundDocumentIds.has(document.id)
                    );
                    return (
                      <List.Item
                        actions={
                          canManage
                            ? [
                                <Button
                                  danger
                                  disabled={!archiveEnabled}
                                  key="archive"
                                  loading={archivingBatchId === batch.id}
                                  onClick={() => void archiveBatch(batch.id)}
                                  size="small"
                                >
                                  {archiveEnabled
                                    ? "归档批次"
                                    : hasBoundDocument
                                      ? "已引用，需先解除绑定"
                                      : "本批次已归档"}
                                </Button>
                              ]
                            : undefined
                        }
                      >
                        <List.Item.Meta
                          description={
                            <Flex gap={8} vertical>
                              <Typography.Text type="secondary">
                                {formatDateTime(batch.createdAt)} · 上传人 {batch.uploadedBy ?? "-"}
                              </Typography.Text>
                              {batch.items.map((document) => (
                                <Flex align="center" gap={8} key={document.id} wrap>
                                  <a
                                    href={buildAdminAssetUrl(document.previewUrl)}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    {document.originalName ?? document.fileName}
                                  </a>
                                  <Tag>{document.documentStatus}</Tag>
                                  {boundDocumentLabels.has(document.id) ? (
                                    <Tag color="blue">{boundDocumentLabels.get(document.id)}</Tag>
                                  ) : null}
                                </Flex>
                              ))}
                            </Flex>
                          }
                          title={`V${batch.versionNo} · ${getActiveBatchFileCount(batch)} 个有效文件`}
                        />
                      </List.Item>
                    );
                  }}
                />
              )}
            </Card>
          </Flex>
        ) : null}
      </Drawer>
    </Flex>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "权证资料操作失败";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function buildAdminAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${API_BASE_URL.replace(/\/api$/, "")}${url}`;
}
