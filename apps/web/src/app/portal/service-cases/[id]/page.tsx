"use client";

import { ArrowLeftOutlined, UploadOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Empty, Flex, List, Space, Tag, Timeline, Typography, Upload } from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  RESCUE_TYPE_LABELS,
  INSURANCE_CLAIM_STATUS_LABELS,
  SERVICE_CASE_ACTION_TYPE_LABELS,
  SERVICE_CASE_ACTOR_TYPE_LABELS,
  SERVICE_CASE_ATTACHMENT_TYPE_LABELS,
  SERVICE_CASE_STATUS_LABELS,
  SERVICE_CASE_TYPE_LABELS,
  labelOf
} from "../../../../constants/labels";
import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import { PortalServiceCase } from "../../../../lib/portal-types";

const statusColors: Record<string, string> = {
  ACCEPTED: "blue",
  CANCELLED: "default",
  CLOSED: "green",
  IN_PROGRESS: "processing",
  RESOLVED: "green",
  SUBMITTED: "gold",
  WAITING_CUSTOMER: "orange"
};

export default function PortalServiceCaseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [detail, setDetail] = useState<PortalServiceCase>();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadDetail();
  }, [params.id]);

  function loadDetail() {
    portalApiFetch<PortalServiceCase>(`/portal/service-cases/${params.id}`)
      .then(setDetail)
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/service-cases/${params.id}`)}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载服务工单");
      })
  }

  async function uploadAttachments() {
    if (!fileList.some((file) => file.originFileObj)) {
      void message.warning("请先选择附件");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      for (const uploadFile of fileList) {
        if (uploadFile.originFileObj) {
          formData.append("files", uploadFile.originFileObj, uploadFile.name);
        }
      }
      await portalApiFetch(`/portal/service-cases/${params.id}/attachments`, {
        body: formData,
        method: "POST"
      });
      setFileList([]);
      void message.success("附件已上传");
      loadDetail();
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  function cancelCase() {
    modal.confirm({
      content: (
        <Typography.Text>
          取消后平台将停止处理当前工单，不会影响订单或车辆状态。
        </Typography.Text>
      ),
      okText: "确认取消",
      onOk: async () => {
        const reason = "客户主动取消";
        await portalApiFetch(`/portal/service-cases/${params.id}/cancel`, {
          body: JSON.stringify({ reason }),
          method: "POST"
        });
        void message.success("工单已取消");
        loadDetail();
      },
      title: "取消服务工单?"
    });
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 860 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/service-cases")} style={{ marginBottom: 12 }}>
          返回工单
        </Button>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 14,
            padding: 18
          }}
        >
          <Flex align="flex-start" justify="space-between" gap={12}>
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {detail?.caseNo ?? "服务工单"}
              </Typography.Title>
              <Space size={[6, 6]} style={{ marginTop: 8 }} wrap>
                <Tag color="blue">{labelOf(SERVICE_CASE_TYPE_LABELS, detail?.caseType ?? "")}</Tag>
                <Tag color={statusColors[detail?.caseStatus ?? ""] ?? "default"}>
                  {labelOf(SERVICE_CASE_STATUS_LABELS, detail?.caseStatus ?? "")}
                </Tag>
              </Space>
            </div>
            {detail?.canCancel ? (
              <Button danger onClick={cancelCase}>
                取消工单
              </Button>
            ) : null}
          </Flex>
        </section>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 14,
            padding: 18
          }}
        >
          <Typography.Title level={4}>工单信息</Typography.Title>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="订单">{detail?.order?.orderNo ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="车辆">{detail?.vehicle?.displayName ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="联系人">{detail?.contactName ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="联系电话">{detail?.contactPhone ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="位置">{detail?.locationText ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="发生时间">{formatTime(detail?.occurredAt)}</Descriptions.Item>
            {detail?.caseType === "RESCUE_REQUEST" ? (
              <>
                <Descriptions.Item label="救援类型">
                  {labelOf(RESCUE_TYPE_LABELS, detail.rescueType ?? "")}
                </Descriptions.Item>
                <Descriptions.Item label="救援地址">{detail.rescueAddress ?? "-"}</Descriptions.Item>
              </>
            ) : (
              <Descriptions.Item label="保险报案号">{detail?.insuranceReportNo ?? "-"}</Descriptions.Item>
            )}
            <Descriptions.Item label="描述">{detail?.description ?? "-"}</Descriptions.Item>
          </Descriptions>
        </section>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 14,
            padding: 18
          }}
        >
          <Typography.Title level={4}>保险理赔</Typography.Title>
          <List
            dataSource={detail?.insuranceClaims ?? []}
            locale={{ emptyText: <Empty description="暂无保险理赔记录" /> }}
            renderItem={(claim) => (
              <List.Item>
                <List.Item.Meta
                  description={[
                    claim.insurerClaimNo ? `保险公司案件号 ${claim.insurerClaimNo}` : null,
                    claim.submittedAt ? `提交 ${formatTime(claim.submittedAt)}` : null,
                    claim.closedAt ? `结案 ${formatTime(claim.closedAt)}` : null
                  ].filter(Boolean).join(" / ")}
                  title={
                    <Space wrap>
                      <Typography.Text>{claim.claimNo}</Typography.Text>
                      <Tag>{labelOf(INSURANCE_CLAIM_STATUS_LABELS, claim.claimStatus)}</Tag>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </section>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 14,
            padding: 18
          }}
        >
          <Typography.Title level={4}>附件</Typography.Title>
          <List
            dataSource={detail?.attachments ?? []}
            locale={{ emptyText: <Empty description="暂无附件" /> }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="preview"
                    onClick={() => window.open(buildPreviewUrl(item.previewUrl), "_blank", "noopener,noreferrer")}
                    type="link"
                  >
                    预览
                  </Button>
                ]}
              >
                <List.Item.Meta
                  description={`${labelOf(SERVICE_CASE_ATTACHMENT_TYPE_LABELS, item.attachmentType)} · ${formatTime(item.createdAt)}`}
                  title={item.fileName}
                />
              </List.Item>
            )}
          />

          {detail && !["CLOSED", "CANCELLED"].includes(detail.caseStatus) ? (
            <Space direction="vertical" style={{ marginTop: 12, width: "100%" }}>
              <Upload
                beforeUpload={() => false}
                fileList={fileList}
                multiple
                onChange={({ fileList: nextFileList }) => setFileList(nextFileList)}
              >
                <Button icon={<UploadOutlined />}>选择附件</Button>
              </Upload>
              <Button disabled={fileList.length === 0} loading={uploading} onClick={uploadAttachments} type="primary">
                上传附件
              </Button>
            </Space>
          ) : null}
        </section>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            padding: 18
          }}
        >
          <Typography.Title level={4}>处理进度</Typography.Title>
          {detail?.actions.length ? (
            <Timeline
              items={detail.actions.map((action) => ({
                children: (
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>{labelOf(SERVICE_CASE_ACTION_TYPE_LABELS, action.actionType)}</Typography.Text>
                    <Typography.Text type="secondary">
                      {formatTime(action.createdAt)} · {labelOf(SERVICE_CASE_ACTOR_TYPE_LABELS, action.actorType)}
                      {action.actorName ? ` / ${action.actorName}` : ""}
                    </Typography.Text>
                    {action.remark ? <Typography.Text>{action.remark}</Typography.Text> : null}
                  </Space>
                )
              }))}
            />
          ) : (
            <Empty description="暂无处理记录" />
          )}
        </section>
      </section>
    </main>
  );
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function buildPreviewUrl(previewUrl: string) {
  const origin = PORTAL_API_BASE_URL.replace(/\/api$/, "");
  return `${origin}${previewUrl}`;
}
