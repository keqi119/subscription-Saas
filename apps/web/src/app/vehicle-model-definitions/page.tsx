"use client";

import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../components/protected-shell";
import { apiFetch } from "../../lib/api";
import { buildQuery, formatDateTime, getErrorMessage } from "../../lib/capital-format";

interface VehicleModelDefinitionRow {
  batteryCapacityKwh?: number | null;
  bodyType?: string | null;
  brand: string;
  createdAt: string;
  customerDisplayName?: string | null;
  displayName: string;
  driveType?: string | null;
  enabled: boolean;
  energyType?: string | null;
  id: string;
  modelCode: string;
  modelName: string;
  modelYear?: number | null;
  officialRangeKm?: number | null;
  portalVisible: boolean;
  remark?: string | null;
  seatCount?: number | null;
  series?: string | null;
  sortOrder: number;
  updatedAt: string;
  variantName?: string | null;
}

interface ListResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface FilterValues {
  brand?: string;
  enabled?: boolean;
  keyword?: string;
  portalVisible?: boolean;
  series?: string;
}

interface ModelDefinitionFormValues {
  batteryCapacityKwh?: number | null;
  bodyType?: string | null;
  brand?: string;
  customerDisplayName?: string | null;
  displayName?: string;
  driveType?: string | null;
  enabled?: boolean;
  energyType?: string | null;
  modelCode?: string;
  modelName?: string;
  modelYear?: number | null;
  officialRangeKm?: number | null;
  portalVisible?: boolean;
  remark?: string | null;
  seatCount?: number | null;
  series?: string | null;
  sortOrder?: number;
  variantName?: string | null;
}

const yesNoOptions = [
  { label: "是", value: true },
  { label: "否", value: false }
];

const textOrDash = (value?: string | number | null) =>
  value === undefined || value === null || value === "" ? "-" : String(value);

export default function VehicleModelDefinitionsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<FilterValues>();
  const [definitionForm] = Form.useForm<ModelDefinitionFormValues>();
  const [rows, setRows] = useState<VehicleModelDefinitionRow[]>([]);
  const [editing, setEditing] = useState<VehicleModelDefinitionRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);

  const loadDefinitions = useCallback(
    async (nextPage: number, nextPageSize: number) => {
      setLoading(true);
      try {
        const result = await apiFetch<ListResponse<VehicleModelDefinitionRow>>(
          `/vehicle-model-definitions${buildQuery({
            ...filterForm.getFieldsValue(),
            page: nextPage,
            pageSize: nextPageSize
          })}`
        );
        setRows(result.items);
        setPage(result.page);
        setPageSize(result.pageSize);
        setTotal(result.total);
      } catch (error) {
        void message.error(getErrorMessage(error));
      } finally {
        setLoading(false);
      }
    },
    [filterForm, message]
  );

  useEffect(() => {
    void loadDefinitions(1, 20);
  }, [loadDefinitions]);

  const columns: ColumnsType<VehicleModelDefinitionRow> = [
      {
        dataIndex: "modelCode",
        fixed: "left",
        title: "车型代码",
        width: 120
      },
      {
        dataIndex: "displayName",
        title: "显示名称",
        width: 140
      },
      {
        dataIndex: "brand",
        title: "品牌",
        width: 100
      },
      {
        dataIndex: "series",
        render: textOrDash,
        title: "车系",
        width: 100
      },
      {
        dataIndex: "modelName",
        title: "车型",
        width: 120
      },
      {
        dataIndex: "modelYear",
        render: textOrDash,
        title: "年款",
        width: 90
      },
      {
        dataIndex: "enabled",
        render: (value: boolean) => <Tag color={value ? "green" : "default"}>{value ? "启用" : "停用"}</Tag>,
        title: "启用",
        width: 90
      },
      {
        dataIndex: "portalVisible",
        render: (value: boolean) => <Tag color={value ? "blue" : "default"}>{value ? "可见" : "隐藏"}</Tag>,
        title: "客户侧",
        width: 90
      },
      {
        dataIndex: "sortOrder",
        title: "排序",
        width: 80
      },
      {
        dataIndex: "updatedAt",
        render: formatDateTime,
        title: "更新时间",
        width: 150
      },
      {
        fixed: "right",
        render: (_, row) => (
          <Space>
            <Button icon={<EditOutlined />} onClick={() => openEdit(row)} size="small">
              编辑
            </Button>
            <Button onClick={() => toggleEnabled(row)} size="small">
              {row.enabled ? "停用" : "启用"}
            </Button>
            <Button danger icon={<DeleteOutlined />} onClick={() => confirmDelete(row)} size="small">
              归档
            </Button>
          </Space>
        ),
        title: "操作",
        width: 220
      }
  ];

  function openCreate() {
    setEditing(null);
    definitionForm.resetFields();
    definitionForm.setFieldsValue({
      enabled: true,
      portalVisible: false,
      sortOrder: 0
    });
    setFormOpen(true);
  }

  function openEdit(row: VehicleModelDefinitionRow) {
    setEditing(row);
    definitionForm.setFieldsValue({
      batteryCapacityKwh: row.batteryCapacityKwh,
      bodyType: row.bodyType,
      brand: row.brand,
      customerDisplayName: row.customerDisplayName,
      displayName: row.displayName,
      driveType: row.driveType,
      enabled: row.enabled,
      energyType: row.energyType,
      modelCode: row.modelCode,
      modelName: row.modelName,
      modelYear: row.modelYear,
      officialRangeKm: row.officialRangeKm,
      portalVisible: row.portalVisible,
      remark: row.remark,
      seatCount: row.seatCount,
      series: row.series,
      sortOrder: row.sortOrder,
      variantName: row.variantName
    });
    setFormOpen(true);
  }

  async function submitDefinition(values: ModelDefinitionFormValues) {
    if (!values.modelCode || !values.brand || !values.modelName || !values.displayName) {
      void message.warning("请填写车型代码、品牌、车型和显示名称");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        ...values,
        portalVisible: values.portalVisible ?? false,
        enabled: values.enabled ?? true,
        sortOrder: values.sortOrder ?? 0
      };

      if (editing) {
        await apiFetch(`/vehicle-model-definitions/${editing.id}`, {
          body: JSON.stringify(payload),
          method: "PATCH"
        });
      } else {
        await apiFetch("/vehicle-model-definitions", {
          body: JSON.stringify(payload),
          method: "POST"
        });
      }

      setFormOpen(false);
      void message.success(editing ? "车型代码已更新" : "车型代码已创建");
      await loadDefinitions(page, pageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(row: VehicleModelDefinitionRow) {
    try {
      await apiFetch(`/vehicle-model-definitions/${row.id}/${row.enabled ? "disable" : "enable"}`, {
        method: "POST"
      });
      void message.success(row.enabled ? "车型代码已停用" : "车型代码已启用");
      await loadDefinitions(page, pageSize);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function confirmDelete(row: VehicleModelDefinitionRow) {
    modal.confirm({
      content: `确认归档车型代码 ${row.modelCode}？`,
      okButtonProps: { danger: true },
      okText: "归档",
      onOk: async () => {
        try {
          await apiFetch(`/vehicle-model-definitions/${row.id}`, { method: "DELETE" });
          void message.success("车型代码已归档");
          await loadDefinitions(page, pageSize);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "归档车型代码"
    });
  }

  function submitFilters(values: FilterValues) {
    filterForm.setFieldsValue(values);
    void loadDefinitions(1, pageSize);
  }

  function resetFilters() {
    filterForm.resetFields();
    void loadDefinitions(1, pageSize);
  }

  function handleTableChange(pagination: TablePaginationConfig) {
    const nextPage = pagination.current ?? 1;
    const nextPageSize = pagination.pageSize ?? pageSize;
    void loadDefinitions(nextPage, nextPageSize);
  }

  return (
    <ProtectedShell>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Space align="start" style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              车型代码
            </Typography.Title>
            <Typography.Text type="secondary">车辆资产主数据维护</Typography.Text>
          </div>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => loadDefinitions(page, pageSize)} loading={loading}>
              刷新
            </Button>
            <Button icon={<PlusOutlined />} onClick={openCreate} type="primary">
              新建车型代码
            </Button>
          </Space>
        </Space>

        <Alert
          message="车辆新增和编辑通过车型主数据关联车型代码。"
          showIcon
          type="info"
        />

        <Form form={filterForm} layout="inline" onFinish={submitFilters}>
          <Form.Item name="keyword">
            <Input allowClear placeholder="搜索代码 / 名称 / 品牌" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="brand">
            <Input allowClear placeholder="品牌" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="series">
            <Input allowClear placeholder="车系" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="enabled">
            <Select allowClear options={yesNoOptions} placeholder="启用状态" style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="portalVisible">
            <Select allowClear options={yesNoOptions} placeholder="客户侧可见" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button htmlType="submit" type="primary">
                查询
              </Button>
              <Button onClick={resetFilters}>重置</Button>
            </Space>
          </Form.Item>
        </Form>

        <Table
          columns={columns}
          dataSource={rows}
          loading={loading}
          onChange={handleTableChange}
          pagination={{
            current: page,
            pageSize,
            showSizeChanger: true,
            total
          }}
          rowKey="id"
          scroll={{ x: 1500 }}
        />
      </Space>

      <Drawer
        destroyOnClose
        onClose={() => setFormOpen(false)}
        open={formOpen}
        title={editing ? "编辑车型代码" : "新建车型代码"}
        width={640}
      >
        <Form form={definitionForm} layout="vertical" onFinish={submitDefinition}>
          <Form.Item
            label="车型代码"
            name="modelCode"
            rules={[
              { required: true, message: "请输入车型代码" },
              { pattern: /^[A-Z0-9_-]+$/, message: "仅支持大写字母、数字、下划线或短横线" }
            ]}
          >
            <Input placeholder="ET5T" />
          </Form.Item>
          <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请输入品牌" }]}>
            <Input placeholder="NIO" />
          </Form.Item>
          <Form.Item label="车系" name="series">
            <Input placeholder="ET" />
          </Form.Item>
          <Form.Item label="车型" name="modelName" rules={[{ required: true, message: "请输入车型" }]}>
            <Input placeholder="ET5T" />
          </Form.Item>
          <Form.Item label="年款" name="modelYear">
            <InputNumber max={2100} min={1990} precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="版本" name="variantName">
            <Input />
          </Form.Item>
          <Form.Item label="显示名称" name="displayName" rules={[{ required: true, message: "请输入显示名称" }]}>
            <Input placeholder="ET5T" />
          </Form.Item>
          <Form.Item label="客户侧显示名称" name="customerDisplayName">
            <Input placeholder="ET5T" />
          </Form.Item>
          <Form.Item label="能源类型" name="energyType">
            <Input />
          </Form.Item>
          <Form.Item label="车身类型" name="bodyType">
            <Input />
          </Form.Item>
          <Form.Item label="座位数" name="seatCount">
            <InputNumber min={0} precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="驱动形式" name="driveType">
            <Input />
          </Form.Item>
          <Form.Item label="电池容量 kWh" name="batteryCapacityKwh">
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="官方续航 km" name="officialRangeKm">
            <InputNumber min={0} precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="排序" name="sortOrder">
            <InputNumber precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="客户侧可见" name="portalVisible" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Space>
            <Button htmlType="submit" loading={submitting} type="primary">
              保存
            </Button>
            <Button onClick={() => setFormOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Drawer>
    </ProtectedShell>
  );
}
