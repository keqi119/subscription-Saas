"use client";

import { AlertOutlined, ArrowLeftOutlined, InboxOutlined, ToolOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  DatePicker,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Typography,
  Upload
} from "antd";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs, { type Dayjs } from "dayjs";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { RESCUE_TYPE_LABELS, SERVICE_CASE_TYPE_LABELS, labelOf } from "../../../../constants/labels";
import { PortalApiError, portalApiFetch } from "../../../../lib/portal-api";
import { PortalOrderListItem, PortalPagedResponse, PortalServiceCase } from "../../../../lib/portal-types";

interface ServiceCaseFormValues {
  accidentHasInjury?: boolean;
  accidentPoliceReported?: boolean;
  contactName?: string;
  contactPhone?: string;
  description?: string;
  insuranceReportNo?: string;
  locationText?: string;
  occurredAt?: Dayjs;
  orderId?: string;
  rescueAddress?: string;
  rescueType?: string;
  title?: string;
}

const rescueTypeOptions = Object.entries(RESCUE_TYPE_LABELS).map(([value, label]) => ({ label, value }));

function PortalNewServiceCaseContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [form] = Form.useForm<ServiceCaseFormValues>();
  const [orders, setOrders] = useState<PortalOrderListItem[]>([]);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [loading, setLoading] = useState(false);
  const caseType = useMemo(() => {
    const value = searchParams.get("type");
    return value === "RESCUE_REQUEST" ? "RESCUE_REQUEST" : "ACCIDENT_REPORT";
  }, [searchParams]);

  useEffect(() => {
    portalApiFetch<PortalPagedResponse<PortalOrderListItem>>("/portal/orders")
      .then((result) => setOrders(result.items))
      .catch((error) => {
        if (error instanceof PortalApiError && error.status === 401) {
          router.replace(`/portal/login?redirect=${encodeURIComponent(`/portal/service-cases/new?type=${caseType}`)}`);
          return;
        }
        void message.error(error instanceof PortalApiError ? error.message : "无法加载订单");
      });
  }, [caseType, message, router]);

  async function submit(values: ServiceCaseFormValues) {
    if (!values.orderId) {
      void message.error("请选择订单");
      return;
    }

    setLoading(true);
    try {
      const serviceCase = await portalApiFetch<PortalServiceCase>("/portal/service-cases", {
        body: JSON.stringify({
          ...values,
          caseType,
          occurredAt: values.occurredAt ? values.occurredAt.toISOString() : undefined
        }),
        method: "POST"
      });

      if (fileList.some((file) => file.originFileObj)) {
        const formData = new FormData();
        for (const uploadFile of fileList) {
          if (uploadFile.originFileObj) {
            formData.append("files", uploadFile.originFileObj, uploadFile.name);
          }
        }
        await portalApiFetch(`/portal/service-cases/${serviceCase.id}/attachments`, {
          body: formData,
          method: "POST"
        });
      }

      void message.success("服务工单已提交");
      router.push(`/portal/service-cases/${serviceCase.id}`);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "提交失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 760 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/portal/service-cases")} style={{ marginBottom: 12 }}>
          返回工单
        </Button>

        <section
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            padding: 18
          }}
        >
          <Space align="center" style={{ marginBottom: 18 }}>
            {caseType === "ACCIDENT_REPORT" ? <AlertOutlined /> : <ToolOutlined />}
            <div>
              <Typography.Title level={2} style={{ margin: 0 }}>
                {labelOf(SERVICE_CASE_TYPE_LABELS, caseType)}
              </Typography.Title>
              <Typography.Text type="secondary">请选择订阅订单并补充服务信息</Typography.Text>
            </div>
          </Space>

          <Form form={form} layout="vertical" onFinish={submit}>
            <Form.Item label="订单" name="orderId" rules={[{ message: "请选择订单", required: true }]}>
              <Select
                options={orders.map((order) => ({
                  label: `${order.orderNo} · ${order.vehicleSummary?.displayName ?? "车辆待确认"}`,
                  value: order.id
                }))}
                placeholder="请选择订单"
              />
            </Form.Item>

            <Form.Item label="标题" name="title">
              <Input maxLength={128} placeholder={caseType === "ACCIDENT_REPORT" ? "车辆发生剐蹭" : "车辆无法启动"} />
            </Form.Item>

            <Form.Item label="联系人" name="contactName">
              <Input maxLength={64} placeholder="联系人姓名" />
            </Form.Item>

            <Form.Item label="联系电话" name="contactPhone">
              <Input maxLength={32} placeholder="联系电话" />
            </Form.Item>

            <Form.Item label="位置" name="locationText">
              <Input maxLength={255} placeholder="请输入当前位置或事故地点" />
            </Form.Item>

            {caseType === "ACCIDENT_REPORT" ? (
              <>
                <Form.Item label="事故时间" name="occurredAt">
                  <DatePicker
                    format="YYYY-MM-DD HH:mm"
                    showTime
                    style={{ width: "100%" }}
                    maxDate={dayjs()}
                  />
                </Form.Item>
                <Form.Item
                  label="是否有人伤"
                  name="accidentHasInjury"
                  rules={[{ message: "请选择是否有人伤", required: true }]}
                >
                  <Radio.Group
                    options={[
                      { label: "否", value: false },
                      { label: "是", value: true }
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label="是否已报警"
                  name="accidentPoliceReported"
                  rules={[{ message: "请选择是否已报警", required: true }]}
                >
                  <Radio.Group
                    options={[
                      { label: "否", value: false },
                      { label: "是", value: true }
                    ]}
                  />
                </Form.Item>
                <Form.Item label="保险报案号" name="insuranceReportNo">
                  <Input maxLength={128} placeholder="可选" />
                </Form.Item>
              </>
            ) : (
              <>
                <Form.Item
                  label="救援类型"
                  name="rescueType"
                  rules={[{ message: "请选择救援类型", required: true }]}
                >
                  <Select options={rescueTypeOptions} placeholder="请选择救援类型" />
                </Form.Item>
                <Form.Item
                  label="救援地址"
                  name="rescueAddress"
                  rules={[{ message: "请输入救援地址", required: true }]}
                >
                  <Input maxLength={255} placeholder="请输入救援地址" />
                </Form.Item>
              </>
            )}

            <Form.Item label="描述" name="description">
              <Input.TextArea maxLength={1000} placeholder="请描述现场情况" rows={4} />
            </Form.Item>

            <Form.Item label="图片 / 附件">
              <Upload.Dragger
                beforeUpload={() => false}
                fileList={fileList}
                multiple
                onChange={({ fileList: nextFileList }) => setFileList(nextFileList)}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">点击或拖拽上传图片 / 文件</p>
                <p className="ant-upload-hint">第一版暂不支持视频上传</p>
              </Upload.Dragger>
            </Form.Item>

            <Button block htmlType="submit" loading={loading} type="primary">
              提交工单
            </Button>
          </Form>
        </section>
      </section>
    </main>
  );
}

export default function PortalNewServiceCasePage() {
  return (
    <Suspense
      fallback={
        <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
          <section style={{ margin: "0 auto", maxWidth: 760 }}>
            <section
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                padding: 18
              }}
            >
              <Typography.Text type="secondary">正在加载...</Typography.Text>
            </section>
          </section>
        </main>
      }
    >
      <PortalNewServiceCaseContent />
    </Suspense>
  );
}
