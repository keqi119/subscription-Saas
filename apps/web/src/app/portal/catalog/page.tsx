"use client";

import { SearchOutlined } from "@ant-design/icons";
import { App, Button, Empty, Flex, Form, Input, List, Select, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PortalApiError, portalApiFetch } from "../../../lib/portal-api";
import { PortalCatalogVehicle, PortalModelDefinitionSummary } from "../../../lib/portal-types";
import styles from "./catalog-page.module.css";
import { PortalCatalogCard } from "./portal-catalog-card";
import {
  countAppliedCatalogFilters,
  PortalCatalogFilterPanel
} from "./portal-catalog-filter-panel";

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [appliedFilterCount, setAppliedFilterCount] = useState(0);

  const loadModelDefinitions = useCallback(async () => {
    try {
      const rows = await portalApiFetch<PortalModelDefinitionSummary[]>("/portal/catalog/model-definitions");
      setModelDefinitions(rows);
    } catch (error) {
      void message.error(error instanceof PortalApiError ? error.message : "无法加载车型筛选项");
    }
  }, [message]);

  const applyFilters = async (values: CatalogFilterValues) => {
    setAppliedFilterCount(countAppliedCatalogFilters(values));
    await loadVehicles(values);
  };

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
    <main className={styles.main}>
      <section className={styles.container}>
        <div className={styles.pageHeader}>
          <div className={styles.pageHeading}>
            <Typography.Title className={styles.pageTitle} level={2}>
              订阅车辆
            </Typography.Title>
            <Typography.Text type="secondary">选择车辆和订阅方案后提交审核</Typography.Text>
          </div>
          <Button onClick={() => router.push("/portal")}>我的入口</Button>
        </div>

        <PortalCatalogFilterPanel
          activeCount={appliedFilterCount}
          onToggle={() => setFiltersOpen((current) => !current)}
          open={filtersOpen}
        >
          <Form<CatalogFilterValues>
            className={styles.filterForm}
            form={form}
            layout="vertical"
            onFinish={applyFilters}
          >
            <Flex className={styles.filterFields}>
              <Form.Item className={styles.filterItem} label="品牌" name="brand">
                <Input allowClear placeholder="例如 NIO" />
              </Form.Item>
              <Form.Item className={styles.filterItem} label="车型" name="model">
                <Input allowClear placeholder="车型关键词" />
              </Form.Item>
              <Form.Item
                className={styles.filterItemWide}
                label="车型代码"
                name="modelDefinitionId"
              >
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
              <Form.Item className={styles.filterItem} label="城市" name="city">
                <Input allowClear placeholder="所在城市" />
              </Form.Item>
              <Form.Item className={styles.filterAction} label=" ">
                <Button
                  htmlType="submit"
                  icon={<SearchOutlined />}
                  loading={loading}
                  type="primary"
                >
                  筛选
                </Button>
              </Form.Item>
            </Flex>
          </Form>
        </PortalCatalogFilterPanel>

        <List
          className={styles.list}
          dataSource={vehicles}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无可申请车辆" /> }}
          renderItem={(vehicle) => (
            <PortalCatalogCard
              onDetails={(selected) => router.push(`/portal/catalog/${selected.id}`)}
              vehicle={vehicle}
            />
          )}
        />
      </section>
    </main>
  );
}
