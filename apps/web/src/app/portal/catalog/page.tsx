"use client";

import { CarOutlined, SearchOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, Form, Input, List, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalCatalogVehicle } from "../../../lib/portal-types";

interface CatalogFilterValues {
  brand?: string;
  city?: string;
  model?: string;
}

export default function PortalCatalogPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm<CatalogFilterValues>();
  const [loading, setLoading] = useState(false);
  const [vehicles, setVehicles] = useState<PortalCatalogVehicle[]>([]);

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
  }, [loadVehicles]);

  return (
    <main style={{ background: "#f6f8fb", minHeight: "100vh", padding: "24px 16px 40px" }}>
      <section style={{ margin: "0 auto", maxWidth: 820 }}>
        <Flex align="center" justify="space-between" style={{ marginBottom: 18 }}>
          <div>
            <Typography.Title level={2} style={{ margin: 0 }}>
              订阅车辆
            </Typography.Title>
            <Typography.Text type="secondary">选择预设套餐后提交审核</Typography.Text>
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
                avatar={
                  <div
                    style={{
                      alignItems: "center",
                      background: "#eef3f8",
                      borderRadius: 8,
                      color: "#246b99",
                      display: "flex",
                      height: 72,
                      justifyContent: "center",
                      width: 96
                    }}
                  >
                    <CarOutlined style={{ fontSize: 28 }} />
                  </div>
                }
                description={
                  <Space direction="vertical" size={8}>
                    <Typography.Text type="secondary">
                      {vehicle.city ?? "待确认城市"} · {vehicle.currentMileageKm.toLocaleString("zh-CN")} km
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      {vehicle.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </Space>
                  </Space>
                }
                title={<Typography.Text strong>{vehicle.displayName}</Typography.Text>}
              />
            </List.Item>
          )}
        />
      </section>
    </main>
  );
}

