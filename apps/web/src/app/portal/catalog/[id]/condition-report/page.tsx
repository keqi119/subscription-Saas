"use client";

/* eslint-disable @next/next/no-img-element -- Vehicle report media previews are private API streams. */

import { ArrowLeftOutlined } from "@ant-design/icons";
import { Alert, App, Button, Descriptions, Empty, Flex, Space, Spin, Tag, Typography } from "antd";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../../../lib/portal-api";
import { PortalVehicleConditionReport, PortalVehicleConditionReportItem } from "../../../../../lib/portal-types";

const AREA_LABELS: Record<string, string> = {
  BATTERY: "电池",
  BRAKE: "制动",
  CHARGING: "充电系统",
  CHASSIS: "底盘",
  ELECTRONICS: "电子设备",
  EXTERIOR: "外观",
  GLASS_LIGHT: "玻璃灯光",
  INTERIOR: "内饰",
  OTHER: "其他",
  TIRE: "轮胎"
};

const SEVERITY_LABELS: Record<string, string> = {
  MAJOR: "明显",
  MINOR: "轻微",
  MODERATE: "一般",
  SAFETY_CRITICAL: "影响安全"
};

const RESULT_LABELS: Record<string, string> = {
  ABNORMAL: "异常",
  ATTENTION: "需关注",
  NORMAL: "正常",
  REPAIRED: "已修复",
  UNKNOWN: "待确认"
};

export default function PortalConditionReportPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [report, setReport] = useState<PortalVehicleConditionReport>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.id) {
      return;
    }

    setLoading(true);
    portalApiFetch<PortalVehicleConditionReport>(`/portal/catalog/vehicles/${params.id}/condition-report`)
      .then(setReport)
      .catch((error) => {
        void message.error(error instanceof PortalApiError ? error.message : "无法加载车况报告");
      })
      .finally(() => setLoading(false));
  }, [message, params.id]);

  const itemsByArea = useMemo(() => groupItemsByArea(report?.items ?? []), [report?.items]);

  if (loading) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Flex justify="center">
          <Spin />
        </Flex>
      </main>
    );
  }

  if (!report) {
    return (
      <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: 32 }}>
        <Empty description="暂无可查看的车况报告" />
      </main>
    );
  }

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 44px" }}>
      <section style={{ margin: "0 auto", maxWidth: 1040 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 16 }} wrap="wrap" gap={12}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push(`/portal/catalog/${params.id}`)}>
            返回车辆详情
          </Button>
          <Button onClick={() => router.push(`/portal/catalog/${params.id}`)} type="primary">
            返回提交审核
          </Button>
        </Flex>

        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <InfoBand>
            <Flex align="flex-start" justify="space-between" wrap="wrap" gap={12}>
              <div>
                <Typography.Title level={2} style={{ margin: 0 }}>
                  {report.vehicle.displayName}
                </Typography.Title>
                <Typography.Text type="secondary">
                  报告编号 {report.reportNo} / {formatDate(report.inspectionDate)}
                </Typography.Text>
              </div>
              <Space size={[8, 8]} wrap>
                {report.overallGrade ? <Tag color="blue">综合等级 {report.overallGrade}</Tag> : null}
                {report.inspectorOrg ? <Tag>{report.inspectorOrg}</Tag> : null}
                {report.inspectorName ? <Tag>检测人 {report.inspectorName}</Tag> : null}
              </Space>
            </Flex>
            <Typography.Paragraph style={{ marginBottom: 0, marginTop: 12 }}>
              {report.customerSummary ?? report.summary ?? "检测摘要待补充。"}
            </Typography.Paragraph>
          </InfoBand>

          <InfoBand title="事故排查">
            <Space size={[8, 8]} wrap>
              <BooleanTag label="重大事故" value={report.accident.hasMajorAccident} />
              <BooleanTag label="水泡" value={report.accident.hasFloodDamage} />
              <BooleanTag label="火烧" value={report.accident.hasFireDamage} />
              <BooleanTag label="结构件损伤" value={report.accident.hasStructuralDamage} />
            </Space>
          </InfoBand>

          <InfoBand title="电池检测">
            <Descriptions
              bordered
              column={{ lg: 3, md: 2, sm: 1, xs: 1 }}
              items={[
                { label: "SOH", children: report.battery.healthPercent ? `${report.battery.healthPercent}%` : "-" },
                { label: "循环次数", children: report.battery.cycleCount ?? "-" },
                { label: "检测日期", children: formatDate(report.battery.checkedAt) },
                {
                  label: "预估续航",
                  children: report.battery.estimatedRangeKm ? `${report.battery.estimatedRangeKm} km` : "-"
                },
                { label: "质保到期", children: formatDate(report.battery.warrantyUntil) },
                { label: "备注", children: report.battery.remark ?? "-" }
              ]}
              size="small"
            />
          </InfoBand>

          <InfoBand title="分项检测">
            {itemsByArea.length === 0 ? (
              <Empty description="暂无客户可见检测项" />
            ) : (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                {itemsByArea.map(([area, items]) => (
                  <section key={area} style={{ borderTop: "1px solid #eef1f5", paddingTop: 12 }}>
                    <Typography.Title level={5}>{AREA_LABELS[area] ?? area}</Typography.Title>
                    <Space direction="vertical" size={10} style={{ width: "100%" }}>
                      {items.map((item) => (
                        <ReportItemCard key={item.id} item={item} />
                      ))}
                    </Space>
                  </section>
                ))}
              </Space>
            )}
          </InfoBand>

          <InfoBand title="安全结论 / 整备建议">
            <Typography.Paragraph>{report.safetyConclusion ?? "安全结论待补充。"}</Typography.Paragraph>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              {report.repairSuggestion ?? "整备建议待补充。"}
            </Typography.Paragraph>
          </InfoBand>

          <Alert
            message="检测信息仅反映检测时点车辆状况，车辆实际状况可能随使用发生变化；最终以交付验收和合同约定为准。"
            showIcon
            type="info"
          />
        </Space>
      </section>
    </main>
  );
}

function ReportItemCard({ item }: Readonly<{ item: PortalVehicleConditionReportItem }>) {
  return (
    <div style={{ border: "1px solid #e5eaf2", borderRadius: 8, padding: 12 }}>
      <Flex align="flex-start" justify="space-between" wrap="wrap" gap={8}>
        <div>
          <Typography.Text strong>{item.title ?? item.partName ?? "检测项"}</Typography.Text>
          {item.partName ? <Typography.Text type="secondary"> / {item.partName}</Typography.Text> : null}
        </div>
        <Space size={[6, 6]} wrap>
          <Tag>{RESULT_LABELS[item.result] ?? item.result}</Tag>
          <Tag color={item.severity === "SAFETY_CRITICAL" ? "red" : item.severity === "MAJOR" ? "orange" : "blue"}>
            {SEVERITY_LABELS[item.severity] ?? item.severity}
          </Tag>
          {item.affectsSafety ? <Tag color="red">影响安全</Tag> : null}
          {item.repairRequired ? <Tag color="orange">需整备</Tag> : null}
        </Space>
      </Flex>
      {item.description ? <Typography.Paragraph style={{ marginTop: 8 }}>{item.description}</Typography.Paragraph> : null}
      {item.media.length > 0 ? (
        <Flex gap={8} wrap="wrap">
          {item.media.map((media) => (
            <div key={media.id} style={{ width: 132 }}>
              <img
                alt={media.caption ?? item.title ?? "车况图片"}
                src={buildPortalAssetUrl(media.previewUrl)}
                style={{ aspectRatio: "4 / 3", borderRadius: 8, objectFit: "cover", width: "100%" }}
              />
              <Typography.Text type="secondary">{media.caption ?? media.category}</Typography.Text>
            </div>
          ))}
        </Flex>
      ) : null}
    </div>
  );
}

function InfoBand({ children, title }: Readonly<{ children: ReactNode; title?: string }>) {
  return (
    <section style={{ background: "#ffffff", border: "1px solid #e5eaf2", borderRadius: 8, padding: 16 }}>
      {title ? <Typography.Title level={4}>{title}</Typography.Title> : null}
      {children}
    </section>
  );
}

function BooleanTag({ label, value }: Readonly<{ label: string; value: boolean | null }>) {
  if (value === true) {
    return <Tag color="red">{label}</Tag>;
  }
  if (value === false) {
    return <Tag color="green">未标记{label}</Tag>;
  }
  return <Tag>{label}待确认</Tag>;
}

function groupItemsByArea(items: PortalVehicleConditionReportItem[]) {
  const map = new Map<string, PortalVehicleConditionReportItem[]>();
  items.forEach((item) => {
    const rows = map.get(item.area) ?? [];
    rows.push(item);
    map.set(item.area, rows);
  });
  return Array.from(map.entries());
}

function buildPortalAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${PORTAL_API_BASE_URL.replace(/\/api$/, "")}${url}`;
}

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString().slice(0, 10);
}
