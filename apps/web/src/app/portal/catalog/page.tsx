"use client";

/* eslint-disable @next/next/no-img-element -- Listing media previews are private API streams, not optimizer-friendly public assets. */

import { CarOutlined, SearchOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, Form, Input, List, Select, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PORTAL_API_BASE_URL, PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalCatalogVehicle, PortalModelDefinitionSummary } from "../../../lib/portal-types";

interface CatalogFilterValues {
  brand?: string;
  city?: string;
  model?: string;
  modelDefinitionId?: string;
}

export default function PortalCatalogPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<CatalogFilterValues>();
  const [loading, setLoading] = useState(false);
  const [modelDefinitions, setModelDefinitions] = useState<PortalModelDefinitionSummary[]>([]);
  const [vehicles, setVehicles] = useState<PortalCatalogVehicle[]>([]);

  const loadModelDefinitions = useCallback(async () => {
    try {
      const rows = await portalApiFetch<PortalModelDefinitionSummary[]>("/portal/catalog/model-definitions");
      setModelDefinitions(rows);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法加载车型筛选项");
    }
  }, [message]);

  const loadVehicles = useCallback(async (values: CatalogFilterValues = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      Object.entries(values).forEach(([key, value]) => {
        if (value?.trim()) {
          params.set(key, value.trim());
        }
      });
      const query = params.toString();
      const rows = await portalApiFetch<PortalCatalogVehicle[]>(
        `/portal/catalog/vehicles${query ? `?${query}` : ""}`
      );
      setVehicles(rows);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法加载商品列表");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadVehicles();
    void loadModelDefinitions();
  }, [loadModelDefinitions, loadVehicles]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 920 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>
              订阅车辆
            </Typography.Title>
            <Typography.Text type="secondary">选择车辆和订阅方案后提交审核</Typography.Text>
          </div>
          <Button onClick={() => router.push("/portal")}>我的入口</Button>
        </Flex>

        <Form<CatalogFilterValues>
          form={form}
          layout="vertical"
          onFinish={loadVehicles}
          style={{
            background: "#ffffff",
            border: "1px solid #e5eaf2",
            borderRadius: 8,
            marginBottom: 16,
            padding: 16
          }}
        >
          <Flex gap={12} wrap="wrap">
            <Form.Item label="品牌" name="brand" style={{ flex: "1 1 150px", marginBottom: 0 }}>
              <Input allowClear placeholder="例如 NIO" />
            </Form.Item>
            <Form.Item label="车型" name="model" style={{ flex: "1 1 150px", marginBottom: 0 }}>
              <Input allowClear placeholder="车型关键词" />
            </Form.Item>
            <Form.Item label="车型代码" name="modelDefinitionId" style={{ flex: "1 1 200px", marginBottom: 0 }}>
              <Select
                allowClear
                options={modelDefinitions.map((definition) => ({
                  label: `${definition.modelCode} - ${definition.customerDisplayName ?? definition.displayName}`,
                  value: definition.id
                }))}
                optionFilterProp="label"
                showSearch
              />
            </Form.Item>
            <Form.Item label="城市" name="city" style={{ flex: "1 1 150px", marginBottom: 0 }}>
              <Input allowClear placeholder="所在城市" />
            </Form.Item>
            <Form.Item label=" " style={{ marginBottom: 0 }}>
              <Button htmlType="submit" icon={<SearchOutlined />} loading={loading} type="primary">
                筛选
              </Button>
            </Form.Item>
          </Flex>
        </Form>

        <List
          dataSource={vehicles}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无可申请车辆" /> }}
          renderItem={(vehicle) => (
            <List.Item
              actions={[
                <Button key="detail" onClick={() => router.push(`/portal/catalog/${vehicle.id}`)} type="link">
                  查看详情
                </Button>
              ]}
              style={{
                background: "#ffffff",
                border: "1px solid #e5eaf2",
                borderRadius: 8,
                marginBottom: 12,
                padding: 16
              }}
            >
              <List.Item.Meta
                avatar={<VehicleCoverImage vehicle={vehicle} />}
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      {vehicle.modelYear ? `${vehicle.modelYear}款 · ` : ""}
                      {vehicle.registrationDate ? `上牌 ${formatMonth(vehicle.registrationDate)} · ` : ""}
                      {vehicle.city ?? "待确认城市"} · {vehicle.currentMileageKm.toLocaleString("zh-CN")} km
                    </Typography.Text>
                    <Space size={[8, 6]} wrap>
                      {vehicle.conditionGrade ? <Tag color="blue">车况 {vehicle.conditionGrade}</Tag> : null}
                      {vehicle.batteryHealthPercent ? (
                        <Tag color="green">电池健康度 {vehicle.batteryHealthPercent}%</Tag>
                      ) : null}
                      {vehicle.hasMajorAccident === false ? <Tag color="green">未标记重大事故</Tag> : null}
                      <Tag>押金审核后确认</Tag>
                    </Space>
                    <Space size={[6, 6]} wrap>
                      {vehicle.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </Space>
                    <Typography.Text strong>
                      {vehicle.monthlyFeeFromAmount ? `${formatYuan(vehicle.monthlyFeeFromAmount)} / 月起` : "月租审核后确认"}
                    </Typography.Text>
                  </Space>
                }
                title={
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {vehicle.shortTitle ?? vehicle.customerModelDisplayName ?? vehicle.displayName}
                    </Typography.Text>
                    {vehicle.modelDisplayName ? (
                      <Typography.Text type="secondary">{vehicle.modelDisplayName}</Typography.Text>
                    ) : null}
                    {vehicle.subtitle ? <Typography.Text type="secondary">{vehicle.subtitle}</Typography.Text> : null}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

function VehicleCoverImage({ vehicle }: Readonly<{ vehicle: PortalCatalogVehicle }>) {
  if (vehicle.coverImageUrl) {
    return (
      <img
        alt={vehicle.displayName}
        src={buildPortalAssetUrl(vehicle.coverImageUrl)}
        style={{
          aspectRatio: "4 / 3",
          borderRadius: 8,
          height: 96,
          objectFit: "cover",
          width: 128
        }}
      />
    );
  }

  return (
    <div
      style={{
        alignItems: "center",
        aspectRatio: "4 / 3",
        background: "#eef3f8",
        borderRadius: 8,
        color: "#246b99",
        display: "flex",
        height: 96,
        justifyContent: "center",
        width: 128
      }}
    >
      <CarOutlined style={{ fontSize: 28 }} />
    </div>
  );
}

function buildPortalAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${PORTAL_API_BASE_URL.replace(/\/api$/, "")}${url}`;
}

function formatMonth(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatYuan(amount: number) {
  return `¥${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 0
  })}`;
}
