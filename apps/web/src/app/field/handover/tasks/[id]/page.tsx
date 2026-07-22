"use client";

import { ArrowLeftOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Flex, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  getFieldHandoverSession,
  getFieldHandoverWorkOrder,
  isFieldHandoverSessionExpired,
  type FieldHandoverWorkOrderDetail
} from "../../../../../lib/field-handover-api";
import { buildFieldHandoverDetailView } from "../../../../../lib/field-handover-view-model";

const NEXT_PHASE_TEXT = "现场资料采集将在下一阶段开放";

export default function FieldHandoverTaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<FieldHandoverWorkOrderDetail | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      setErrorMessage(null);
      await getFieldHandoverSession();
      setDetail(await getFieldHandoverWorkOrder(params.id));
    } catch (error) {
      if (isFieldHandoverSessionExpired(error)) {
        router.replace("/field/handover");
        return;
      }
      setErrorMessage("无法访问该交接任务，请确认任务仍分配给当前手机号");
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const view = detail ? buildFieldHandoverDetailView(detail) : null;

  return (
    <main
      style={{
        background: "#f5f8fc",
        minHeight: "100vh",
        padding: "max(22px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))"
      }}
    >
      <section style={{ margin: "0 auto", maxWidth: 520 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/field/handover/tasks")} style={{ marginBottom: 14 }}>
          返回任务列表
        </Button>

        {loading ? (
          <Flex align="center" gap={10} justify="center" style={{ minHeight: 240 }}>
            <Spin />
            <Typography.Text>正在加载交接任务...</Typography.Text>
          </Flex>
        ) : null}

        {!loading && errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}

        {!loading && view ? (
          <Flex gap={12} vertical>
            <article
              style={{
                background: "#fff",
                border: "1px solid #dde5f0",
                borderRadius: 8,
                boxShadow: "0 8px 22px rgba(31, 71, 112, 0.06)",
                padding: 16
              }}
            >
              <Flex align="flex-start" justify="space-between" style={{ gap: 12, marginBottom: 12 }}>
                <div>
                  <Typography.Title level={2} style={{ fontSize: 22, margin: 0 }}>
                    {view.card.title}
                  </Typography.Title>
                  <Typography.Text style={{ color: "#607086" }}>{view.card.handoverTypeLabel}</Typography.Text>
                </div>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  {view.card.statusLabel}
                </Tag>
              </Flex>

              <Flex gap={8} vertical>
                <InfoRow label="预约时间" value={view.card.scheduledAtText} />
                <InfoRow label="交接地点" value={view.card.deliveryLocationText} />
                <InfoRow label="车辆" value={view.card.vehicleText} />
                <InfoRow label="车牌" value={view.card.plateText} />
                <InfoRow label="VIN" value={view.card.vinText} />
                <InfoRow label="客户" value={view.card.customerText} />
                <InfoRow label="资料清单" value={view.checklistSummary} />
              </Flex>
            </article>

            <article
              style={{
                background: "#fff",
                border: "1px solid #dde5f0",
                borderRadius: 8,
                padding: 16
              }}
            >
              <Typography.Title level={3} style={{ fontSize: 18, marginTop: 0 }}>
                现场摘要
              </Typography.Title>
              <Flex gap={8} vertical>
                {view.fieldFactRows.map((row) => (
                  <InfoRow key={row.label} label={row.label} value={row.value} />
                ))}
              </Flex>
            </article>

            <Alert
              icon={<ClockCircleOutlined />}
              message={NEXT_PHASE_TEXT}
              showIcon
              type="info"
            />
            <Button block disabled size="large">
              现场采集页即将开放
            </Button>
          </Flex>
        ) : null}
      </section>
    </main>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" style={{ gap: 12 }}>
      <Typography.Text style={{ color: "#718096", flex: "0 0 76px" }}>{label}</Typography.Text>
      <Typography.Text style={{ flex: 1, textAlign: "right", wordBreak: "break-word" }}>{value}</Typography.Text>
    </Flex>
  );
}
