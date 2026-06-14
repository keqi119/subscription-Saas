"use client";

import {
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined
} from "@ant-design/icons";
import {
  App,
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ActionButton } from "../../components/action-button";
import { ProtectedShell } from "../../components/protected-shell";
import {
  VEHICLE_ASSET_POOL_STATUS_LABELS,
  VEHICLE_ASSET_POOL_TYPE_LABELS,
  VEHICLE_ASSET_POOL_VEHICLE_STATUS_LABELS,
  VEHICLE_STATUS_LABELS,
  labelOf
} from "../../constants/labels";
import { apiFetch } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/auth";
import {
  buildQuery,
  formatDate,
  formatYuan,
  getErrorMessage,
  optionsFromLabels,
  safeText
} from "../../lib/capital-format";

interface VehicleAssetPoolRow {
  activeVehicleCount: number;
  createdAt: string;
  id: string;
  poolName: string;
  poolNo: string;
  poolStatus: string;
  poolType: string;
  purpose?: string | null;
  remark?: string | null;
  vehicleCount: number;
}

interface VehicleAssetPoolListResponse {
  items: VehicleAssetPoolRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface VehicleBrief {
  brand?: string | null;
  currentSalePriceAmount?: number | null;
  id: string;
  model?: string | null;
  plateNo?: string | null;
  purchasePriceAmount?: number | null;
  series?: string | null;
  status?: string | null;
  vehicleModel?: string | null;
  vehicleNo?: string | null;
  vin?: string | null;
}

interface PoolVehicleMembership {
  effectiveFrom: string;
  effectiveTo?: string | null;
  id: string;
  membershipStatus: string;
  poolId: string;
  remark?: string | null;
  vehicle?: VehicleBrief | null;
  vehicleId: string;
}

interface VehicleAssetPoolDetail extends VehicleAssetPoolRow {
  currentSalePriceAmountTotal: number;
  purchasePriceAmountTotal: number;
  vehicles: PoolVehicleMembership[];
}

interface PoolFilterValues {
  poolName?: string;
  poolStatus?: string;
  poolType?: string;
}

interface PoolFormValues {
  poolName: string;
  poolStatus?: string;
  poolType: string;
  purpose?: string | null;
  remark?: string | null;
}

interface AddVehicleValues {
  effectiveFrom: Dayjs;
  remark?: string | null;
  vehicleId: string;
}

interface BatchAddVehicleValues {
  effectiveFrom: Dayjs;
  remark?: string | null;
  vehicleIds?: string[];
  vehicleIdsText?: string;
}

interface RemoveVehicleValues {
  effectiveTo: Dayjs;
  remark?: string | null;
}

interface BatchResultRow {
  reason?: string | null;
  vehicleId?: string | null;
}

interface BatchAddResult {
  added?: PoolVehicleMembership[];
  addedCount: number;
  failed?: BatchResultRow[];
  failedCount: number;
  skipped?: BatchResultRow[];
  skippedCount: number;
}

const poolStatusColors: Record<string, string> = {
  ACTIVE: "green",
  ARCHIVED: "default",
  CANCELLED: "default",
  INACTIVE: "orange",
  REMOVED: "default"
};

function formatTag(labels: Record<string, string>, value?: string | null) {
  if (!value) {
    return "-";
  }
  return <Tag color={poolStatusColors[value] ?? "default"}>{labelOf(labels, value)}</Tag>;
}

function vehicleOptionLabel(vehicle: VehicleBrief) {
  return [vehicle.vehicleNo, vehicle.plateNo, vehicle.vin, vehicle.vehicleModel ?? vehicle.model]
    .filter(Boolean)
    .join(" / ");
}

function vehicleModelText(vehicle?: VehicleBrief | null) {
  if (!vehicle) {
    return "-";
  }
  return [vehicle.brand, vehicle.series, vehicle.vehicleModel ?? vehicle.model].filter(Boolean).join(" / ") || "-";
}

function parseVehicleIdsText(value?: string | null) {
  return (value ?? "")
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function VehicleAssetPoolsPage() {
  const { message, modal } = App.useApp();
  const [filterForm] = Form.useForm<PoolFilterValues>();
  const [poolForm] = Form.useForm<PoolFormValues>();
  const [addVehicleForm] = Form.useForm<AddVehicleValues>();
  const [batchAddForm] = Form.useForm<BatchAddVehicleValues>();
  const [removeVehicleForm] = Form.useForm<RemoveVehicleValues>();
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [rows, setRows] = useState<VehicleAssetPoolRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<VehicleAssetPoolDetail | null>(null);
  const [poolModalOpen, setPoolModalOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<VehicleAssetPoolRow | null>(null);
  const [addVehicleOpen, setAddVehicleOpen] = useState(false);
  const [batchAddOpen, setBatchAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PoolVehicleMembership | null>(null);
  const [batchResult, setBatchResult] = useState<BatchAddResult | null>(null);
  const [vehicleRows, setVehicleRows] = useState<VehicleBrief[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  const permissions = useMemo<Set<string>>(() => new Set(me?.user.permissions ?? []), [me]);
  const canView = permissions.has("vehicle_asset_pool:view");
  const canViewVehicles = permissions.has("vehicle:view");

  const vehicleOptions = useMemo(
    () =>
      vehicleRows.map((vehicle) => ({
        label: vehicleOptionLabel(vehicle),
        value: vehicle.id
      })),
    [vehicleRows]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const query = buildQuery(filterForm.getFieldsValue());
      const result = await apiFetch<VehicleAssetPoolListResponse>(`/vehicle-asset-pools${query}`);
      setRows(result.items);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [filterForm, message]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const nextDetail = await apiFetch<VehicleAssetPoolDetail>(`/vehicle-asset-pools/${id}`);
        setDetail(nextDetail);
        return nextDetail;
      } catch (error) {
        void message.error(getErrorMessage(error));
        return null;
      } finally {
        setDetailLoading(false);
      }
    },
    [message]
  );

  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    try {
      setVehicleRows(await apiFetch<VehicleBrief[]>("/vehicles"));
    } catch (error) {
      void message.error(getErrorMessage(error));
      setVehicleRows([]);
    } finally {
      setVehiclesLoading(false);
    }
  }, [message]);

  useEffect(() => {
    apiFetch<AuthMeResponse>("/auth/me")
      .then(setMe)
      .catch((error) => message.error(getErrorMessage(error)));
  }, [message]);

  useEffect(() => {
    if (canView) {
      void loadData();
    }
  }, [canView, loadData]);

  useEffect(() => {
    if (canViewVehicles) {
      void loadVehicles();
    }
  }, [canViewVehicles, loadVehicles]);

  function openCreatePool() {
    setEditingPool(null);
    poolForm.resetFields();
    poolForm.setFieldsValue({
      poolStatus: "ACTIVE",
      poolType: "FINANCING"
    });
    setPoolModalOpen(true);
  }

  function openEditPool(record: VehicleAssetPoolRow) {
    setEditingPool(record);
    poolForm.setFieldsValue({
      poolName: record.poolName,
      poolStatus: record.poolStatus,
      poolType: record.poolType,
      purpose: record.purpose,
      remark: record.remark
    });
    setPoolModalOpen(true);
  }

  async function submitPool(values: PoolFormValues) {
    const payload = {
      poolName: values.poolName,
      poolStatus: editingPool ? values.poolStatus : undefined,
      poolType: values.poolType,
      purpose: values.purpose,
      remark: values.remark
    };

    try {
      if (editingPool) {
        await apiFetch(`/vehicle-asset-pools/${editingPool.id}`, {
          body: JSON.stringify(payload),
          method: "PUT"
        });
        void message.success("车辆池已更新");
      } else {
        await apiFetch("/vehicle-asset-pools", {
          body: JSON.stringify(payload),
          method: "POST"
        });
        void message.success("车辆池已创建");
      }
      setPoolModalOpen(false);
      poolForm.resetFields();
      await loadData();
      const detailId = detail?.id;
      if (detailId && detailId === editingPool?.id) {
        await loadDetail(detailId);
      }
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function openDetail(record: VehicleAssetPoolRow) {
    setDetailOpen(true);
    await loadDetail(record.id);
  }

  function archivePool(record: VehicleAssetPoolRow) {
    modal.confirm({
      cancelText: "取消",
      content: "归档后不允许继续添加车辆或执行新的池化分摊。",
      okText: "确认归档",
      onOk: async () => {
        try {
          await apiFetch(`/vehicle-asset-pools/${record.id}/archive`, {
            body: JSON.stringify({ remark: "前端归档" }),
            method: "POST"
          });
          void message.success("车辆池已归档");
          await loadData();
          if (detail?.id === record.id) {
            await loadDetail(record.id);
          }
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "确认归档该车辆池？"
    });
  }

  function openAddVehicle() {
    addVehicleForm.resetFields();
    addVehicleForm.setFieldsValue({ effectiveFrom: dayjs() });
    setAddVehicleOpen(true);
  }

  async function submitAddVehicle(values: AddVehicleValues) {
    if (!detail) {
      return;
    }
    try {
      await apiFetch(`/vehicle-asset-pools/${detail.id}/vehicles`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          remark: values.remark,
          vehicleId: values.vehicleId
        }),
        method: "POST"
      });
      void message.success("车辆已加入车辆池");
      setAddVehicleOpen(false);
      addVehicleForm.resetFields();
      await Promise.all([loadData(), loadDetail(detail.id)]);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openBatchAdd() {
    batchAddForm.resetFields();
    batchAddForm.setFieldsValue({ effectiveFrom: dayjs() });
    setBatchResult(null);
    setBatchAddOpen(true);
  }

  async function submitBatchAdd(values: BatchAddVehicleValues) {
    if (!detail) {
      return;
    }
    const vehicleIds = vehicleOptions.length > 0 ? values.vehicleIds ?? [] : parseVehicleIdsText(values.vehicleIdsText);
    if (vehicleIds.length === 0) {
      void message.error("请选择或填写车辆 ID");
      return;
    }
    try {
      const result = await apiFetch<BatchAddResult>(`/vehicle-asset-pools/${detail.id}/vehicles/batch`, {
        body: JSON.stringify({
          effectiveFrom: values.effectiveFrom.format("YYYY-MM-DD"),
          remark: values.remark,
          vehicleIds
        }),
        method: "POST"
      });
      setBatchResult(result);
      void message.success("批量加入处理完成");
      await Promise.all([loadData(), loadDetail(detail.id)]);
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  function openRemoveVehicle(record: PoolVehicleMembership) {
    setRemoveTarget(record);
    removeVehicleForm.resetFields();
    removeVehicleForm.setFieldsValue({ effectiveTo: dayjs() });
  }

  async function submitRemoveVehicle() {
    if (!detail || !removeTarget) {
      return;
    }
    const values = await removeVehicleForm.validateFields();
    modal.confirm({
      cancelText: "取消",
      content: "已生成的历史融资分摊不会自动重算。",
      okText: "确认移出",
      onOk: async () => {
        try {
          await apiFetch(`/vehicle-asset-pools/${detail.id}/vehicles/${removeTarget.id}/remove`, {
            body: JSON.stringify({
              effectiveTo: values.effectiveTo.format("YYYY-MM-DD"),
              remark: values.remark
            }),
            method: "POST"
          });
          void message.success("车辆已移出车辆池");
          setRemoveTarget(null);
          removeVehicleForm.resetFields();
          await Promise.all([loadData(), loadDetail(detail.id)]);
        } catch (error) {
          void message.error(getErrorMessage(error));
        }
      },
      title: "确认将该车辆移出车辆池？"
    });
  }

  const columns: ColumnsType<VehicleAssetPoolRow> = [
    { dataIndex: "poolNo", title: "车辆池编号", width: 210 },
    { dataIndex: "poolName", title: "车辆池名称", width: 220 },
    {
      dataIndex: "poolType",
      render: (value: string) => labelOf(VEHICLE_ASSET_POOL_TYPE_LABELS, value),
      title: "类型",
      width: 140
    },
    {
      dataIndex: "poolStatus",
      render: (value: string) => formatTag(VEHICLE_ASSET_POOL_STATUS_LABELS, value),
      title: "状态",
      width: 110
    },
    { dataIndex: "vehicleCount", title: "车辆数", width: 90 },
    { dataIndex: "activeVehicleCount", title: "生效车辆数", width: 110 },
    { dataIndex: "purpose", render: safeText, title: "用途", width: 220 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 180 },
    { dataIndex: "createdAt", render: formatDate, title: "创建时间", width: 120 },
    {
      fixed: "right",
      render: (_, record) => (
        <Space>
          <ActionButton
            icon={<EyeOutlined />}
            onClick={() => openDetail(record)}
            permission="vehicle_asset_pool:view"
            permissions={permissions}
            size="small"
          >
            查看详情
          </ActionButton>
          <ActionButton
            onClick={() => openEditPool(record)}
            permission="vehicle_asset_pool:manage"
            permissions={permissions}
            size="small"
          >
            编辑
          </ActionButton>
          <ActionButton
            allowed={record.poolStatus !== "ARCHIVED"}
            disabledReason="已归档车辆池不能重复归档"
            icon={<StopOutlined />}
            onClick={() => archivePool(record)}
            permission="vehicle_asset_pool:manage"
            permissions={permissions}
            size="small"
          >
            归档
          </ActionButton>
        </Space>
      ),
      title: "操作",
      width: 260
    }
  ];

  const membershipColumns: ColumnsType<PoolVehicleMembership> = [
    { dataIndex: ["vehicle", "vin"], render: safeText, title: "VIN", width: 180 },
    { dataIndex: ["vehicle", "plateNo"], render: safeText, title: "车牌号", width: 120 },
    { dataIndex: ["vehicle", "brand"], render: safeText, title: "品牌", width: 100 },
    { dataIndex: ["vehicle", "series"], render: safeText, title: "车系", width: 120 },
    { render: (_, record) => vehicleModelText(record.vehicle), title: "车型", width: 170 },
    {
      dataIndex: ["vehicle", "status"],
      render: (value: string | null | undefined) => labelOf(VEHICLE_STATUS_LABELS, value),
      title: "车辆状态",
      width: 120
    },
    { dataIndex: ["vehicle", "purchasePriceAmount"], render: formatYuan, title: "采购价", width: 130 },
    { dataIndex: ["vehicle", "currentSalePriceAmount"], render: formatYuan, title: "当前销售价", width: 130 },
    {
      dataIndex: "membershipStatus",
      render: (value: string) => formatTag(VEHICLE_ASSET_POOL_VEHICLE_STATUS_LABELS, value),
      title: "成员状态",
      width: 110
    },
    { dataIndex: "effectiveFrom", render: formatDate, title: "生效日期", width: 120 },
    { dataIndex: "effectiveTo", render: formatDate, title: "移出日期", width: 120 },
    { dataIndex: "remark", render: safeText, title: "备注", width: 160 },
    {
      fixed: "right",
      render: (_, record) => (
        <ActionButton
          allowed={record.membershipStatus === "ACTIVE" && detail?.poolStatus === "ACTIVE"}
          disabledReason="仅生效中的池内车辆可以移出"
          onClick={() => openRemoveVehicle(record)}
          permission="vehicle_asset_pool:manage"
          permissions={permissions}
          size="small"
        >
          移出
        </ActionButton>
      ),
      title: "操作",
      width: 100
    }
  ];

  const batchResultColumns: ColumnsType<BatchResultRow> = [
    { dataIndex: "vehicleId", render: safeText, title: "车辆" },
    { dataIndex: "reason", render: safeText, title: "原因" }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
          <Typography.Title level={3} style={{ margin: 0 }}>
            车辆资产池
          </Typography.Title>
          <Space>
            <ActionButton
              icon={<PlusOutlined />}
              onClick={openCreatePool}
              permission="vehicle_asset_pool:manage"
              permissions={permissions}
              type="primary"
            >
              新增车辆池
            </ActionButton>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </Space>

        <Alert
          message="车辆资产池用于资产管理分组。FINANCING 类型车辆池可用于融资工具的池化车辆分摊；池内车辆变化不会自动重算历史融资分摊。"
          showIcon
          type="info"
        />

        {!canView ? (
          <Alert message="当前账号无车辆资产池查看权限。" showIcon type="warning" />
        ) : (
          <>
            <Form form={filterForm} layout="inline" onFinish={loadData}>
              <Form.Item label="车辆池名称" name="poolName">
                <Input allowClear placeholder="车辆池名称" />
              </Form.Item>
              <Form.Item label="车辆池类型" name="poolType">
                <Select allowClear options={optionsFromLabels(VEHICLE_ASSET_POOL_TYPE_LABELS)} style={{ width: 180 }} />
              </Form.Item>
              <Form.Item label="车辆池状态" name="poolStatus">
                <Select allowClear options={optionsFromLabels(VEHICLE_ASSET_POOL_STATUS_LABELS)} style={{ width: 150 }} />
              </Form.Item>
              <Form.Item>
                <Space>
                  <Button htmlType="submit" loading={loading}>
                    查询
                  </Button>
                  <Button
                    onClick={() => {
                      filterForm.resetFields();
                      void loadData();
                    }}
                  >
                    重置
                  </Button>
                </Space>
              </Form.Item>
            </Form>

            <Table
              columns={columns}
              dataSource={rows}
              loading={loading}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              rowKey="id"
              scroll={{ x: 1560 }}
              size="small"
            />
          </>
        )}

        <Drawer
          destroyOnHidden
          extra={
            detail ? (
              <Space>
                <ActionButton
                  allowed={detail.poolStatus === "ACTIVE"}
                  disabledReason="归档或停用车辆池不能继续添加车辆"
                  onClick={openAddVehicle}
                  permission="vehicle_asset_pool:manage"
                  permissions={permissions}
                >
                  添加车辆
                </ActionButton>
                <ActionButton
                  allowed={detail.poolStatus === "ACTIVE"}
                  disabledReason="归档或停用车辆池不能继续添加车辆"
                  onClick={openBatchAdd}
                  permission="vehicle_asset_pool:manage"
                  permissions={permissions}
                >
                  批量添加车辆
                </ActionButton>
              </Space>
            ) : null
          }
          loading={detailLoading}
          onClose={() => {
            setDetailOpen(false);
            setDetail(null);
          }}
          open={detailOpen}
          title={detail ? `${detail.poolNo} 车辆资产池详情` : "车辆资产池详情"}
          width="80vw"
        >
          {detail ? (
            <Space direction="vertical" size={20} style={{ width: "100%" }}>
              <Descriptions
                bordered
                column={2}
                items={[
                  { label: "车辆池编号", children: detail.poolNo },
                  { label: "车辆池名称", children: detail.poolName },
                  { label: "类型", children: labelOf(VEHICLE_ASSET_POOL_TYPE_LABELS, detail.poolType) },
                  { label: "状态", children: formatTag(VEHICLE_ASSET_POOL_STATUS_LABELS, detail.poolStatus) },
                  { label: "用途", children: safeText(detail.purpose) },
                  { label: "备注", children: safeText(detail.remark) },
                  { label: "创建时间", children: formatDate(detail.createdAt) }
                ]}
                title="基础信息"
              />
              <Space wrap>
                <Statistic title="车辆总数" value={detail.vehicleCount} />
                <Statistic title="生效车辆数" value={detail.activeVehicleCount} />
                <Statistic title="采购价合计" value={formatYuan(detail.purchasePriceAmountTotal)} />
                <Statistic title="当前销售价合计" value={formatYuan(detail.currentSalePriceAmountTotal)} />
              </Space>
              <Table
                columns={membershipColumns}
                dataSource={detail.vehicles}
                pagination={false}
                rowKey="id"
                scroll={{ x: 1680 }}
                size="small"
                title={() => "池内车辆列表"}
              />
            </Space>
          ) : null}
        </Drawer>

        <Modal
          destroyOnHidden
          okText="保存"
          onCancel={() => setPoolModalOpen(false)}
          onOk={() => poolForm.submit()}
          open={poolModalOpen}
          title={editingPool ? "编辑车辆池" : "新增车辆池"}
          width={640}
        >
          <Form<PoolFormValues> form={poolForm} layout="vertical" onFinish={submitPool}>
            <Form.Item label="车辆池名称" name="poolName" rules={[{ required: true, message: "请输入车辆池名称" }]}>
              <Input maxLength={128} />
            </Form.Item>
            <Form.Item label="车辆池类型" name="poolType" rules={[{ required: true, message: "请选择车辆池类型" }]}>
              <Select options={optionsFromLabels(VEHICLE_ASSET_POOL_TYPE_LABELS)} />
            </Form.Item>
            {editingPool ? (
              <Form.Item label="车辆池状态" name="poolStatus" rules={[{ required: true, message: "请选择车辆池状态" }]}>
                <Select options={optionsFromLabels(VEHICLE_ASSET_POOL_STATUS_LABELS)} />
              </Form.Item>
            ) : null}
            <Form.Item label="用途" name="purpose">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="添加"
          onCancel={() => setAddVehicleOpen(false)}
          onOk={() => addVehicleForm.submit()}
          open={addVehicleOpen}
          title="添加车辆到池"
          width={620}
        >
          <Form<AddVehicleValues> form={addVehicleForm} layout="vertical" onFinish={submitAddVehicle}>
            <Form.Item
              extra={
                vehicleOptions.length > 0
                  ? "请选择系统车辆，提交时会使用数据库车辆 ID。"
                  : "当前无法加载车辆列表，请填写系统车辆 ID（UUID），不要填写 VEH 开头的车辆编号。"
              }
              label="车辆"
              name="vehicleId"
              rules={[{ required: true, message: "请选择车辆" }]}
            >
              {vehicleOptions.length > 0 ? (
                <Select
                  loading={vehiclesLoading}
                  optionFilterProp="label"
                  options={vehicleOptions}
                  placeholder="搜索车辆编号 / 车牌 / VIN / 车型"
                  showSearch
                />
              ) : (
                <Input placeholder="系统车辆 ID（UUID）" />
              )}
            </Form.Item>
            <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          destroyOnHidden
          okText="批量添加"
          onCancel={() => setBatchAddOpen(false)}
          onOk={() => batchAddForm.submit()}
          open={batchAddOpen}
          title="批量添加车辆到池"
          width={760}
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Form<BatchAddVehicleValues> form={batchAddForm} layout="vertical" onFinish={submitBatchAdd}>
              {vehicleOptions.length > 0 ? (
                <Form.Item label="车辆列表" name="vehicleIds" rules={[{ required: true, message: "请选择车辆" }]}>
                  <Select
                    loading={vehiclesLoading}
                    mode="multiple"
                    optionFilterProp="label"
                    options={vehicleOptions}
                    placeholder="搜索并多选车辆"
                    showSearch
                  />
                </Form.Item>
              ) : (
                <Form.Item
                  extra="每行一个系统车辆 ID（UUID），不要填写 VEH 开头的车辆编号。"
                  label="车辆列表"
                  name="vehicleIdsText"
                  rules={[{ required: true, message: "请填写车辆 ID" }]}
                >
                  <Input.TextArea rows={6} />
                </Form.Item>
              )}
              <Form.Item label="生效日期" name="effectiveFrom" rules={[{ required: true, message: "请选择生效日期" }]}>
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <Input.TextArea rows={3} />
              </Form.Item>
            </Form>
            {batchResult ? (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Space wrap>
                  <Statistic title="新增数量" value={batchResult.addedCount} />
                  <Statistic title="跳过数量" value={batchResult.skippedCount} />
                  <Statistic title="失败数量" value={batchResult.failedCount} />
                </Space>
                <Table
                  columns={batchResultColumns}
                  dataSource={[
                    ...(batchResult.skipped ?? []).map((item) => ({ ...item, reason: `跳过：${item.reason ?? "-"}` })),
                    ...(batchResult.failed ?? []).map((item) => ({ ...item, reason: `失败：${item.reason ?? "-"}` }))
                  ]}
                  pagination={false}
                  rowKey={(record, index) => `${record.vehicleId ?? "row"}-${index}`}
                  size="small"
                />
              </Space>
            ) : null}
          </Space>
        </Modal>

        <Modal
          destroyOnHidden
          okText="移出"
          onCancel={() => setRemoveTarget(null)}
          onOk={submitRemoveVehicle}
          open={Boolean(removeTarget)}
          title="移出池内车辆"
        >
          <Form<RemoveVehicleValues> form={removeVehicleForm} layout="vertical">
            <Form.Item label="移出日期" name="effectiveTo" rules={[{ required: true, message: "请选择移出日期" }]}>
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
