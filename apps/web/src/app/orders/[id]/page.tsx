"use client";

import { ArrowLeftOutlined } from "@ant-design/icons";
import { App, Button, Descriptions, Form, Input, Modal, Space, Spin, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ProtectedShell } from "../../../components/protected-shell";
import { ORDER_CHANGE_TYPE_LABELS, STATUS_LABELS, labelOf } from "../../../constants/labels";
import { apiFetch, ApiError } from "../../../lib/api";

interface OrderDetail {
  application?: { applicationNo: string; id: string } | null;
  contract?: { contractNo: string; id: string; status: string } | null;
  createdAt: string;
  customer: { name: string; mobile: string };
  depositAmount: number;
  id: string;
  mileageLimitKm: number;
  monthlyFeeAmount: number;
  orderNo: string;
  orderStatus: string;
  periodMonths: number;
  quote?: { quoteNo: string; id: string } | null;
  quoteSnapshot?: unknown;
  vehicleModel: string;
  vehiclePurchasePriceAmount: number;
}

interface OrderChangeRow {
  changeType: string;
  createdAt: string;
  creator?: { name: string } | null;
  id: string;
  reason: string;
  status: string;
}

function formatYuan(value: number) {
  return `¥${(value / 100).toFixed(2)}`;
}

function formatTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function getErrorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : "操作失败，请稍后重试";
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { message } = App.useApp();
  const [changeForm] = Form.useForm<{ reason: string }>();
  const [changeModalOpen, setChangeModalOpen] = useState(false);
  const [changes, setChanges] = useState<OrderChangeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<OrderDetail | null>(null);

  const loadOrder = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOrder, nextChanges] = await Promise.all([
        apiFetch<OrderDetail>(`/orders/${params.id}`),
        apiFetch<OrderChangeRow[]>(`/orders/${params.id}/changes`).catch(() => [])
      ]);
      setOrder(nextOrder);
      setChanges(nextChanges);
    } catch (error) {
      void message.error(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [message, params.id]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  async function generateContract() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/generate-contract`, { method: "POST" });
      void message.success("合同已生成");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function cancelOrder() {
    if (!order) {
      return;
    }
    try {
      await apiFetch(`/orders/${order.id}/cancel`, {
        body: JSON.stringify({ reason: "运营取消订单" }),
        method: "POST"
      });
      void message.success("订单已取消");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function createChange() {
    if (!order) {
      return;
    }
    const values = await changeForm.validateFields();
    try {
      await apiFetch(`/orders/${order.id}/changes`, {
        body: JSON.stringify({
          changeType: "PLAN_CHANGE",
          reason: values.reason
        }),
        method: "POST"
      });
      void message.success("变更申请已创建");
      setChangeModalOpen(false);
      changeForm.resetFields();
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  async function reviewChange(changeId: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/order-changes/${changeId}/${action}`, { method: "POST" });
      void message.success(action === "approve" ? "订单变更已通过" : "订单变更已拒绝");
      await loadOrder();
    } catch (error) {
      void message.error(getErrorMessage(error));
    }
  }

  const changeColumns: ColumnsType<OrderChangeRow> = [
    { dataIndex: "changeType", render: (value: string) => labelOf(ORDER_CHANGE_TYPE_LABELS, value), title: "变更类型" },
    { dataIndex: "reason", title: "变更原因" },
    { dataIndex: "status", render: (value: string) => <Tag>{labelOf(STATUS_LABELS, value)}</Tag>, title: "状态" },
    { dataIndex: "creator", render: (value?: OrderChangeRow["creator"]) => value?.name ?? "-", title: "创建人" },
    { dataIndex: "createdAt", render: formatTime, title: "创建时间" },
    {
      render: (_, record) =>
        record.status === "PENDING" ? (
          <Space>
            <Button onClick={() => reviewChange(record.id, "approve")} size="small" type="primary">
              通过
            </Button>
            <Button danger onClick={() => reviewChange(record.id, "reject")} size="small">
              拒绝
            </Button>
          </Space>
        ) : (
          "-"
        ),
      title: "操作"
    }
  ];

  return (
    <ProtectedShell>
      <Space direction="vertical" size={20} style={{ width: "100%" }}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <Space>
            <Button aria-label="返回订单列表" icon={<ArrowLeftOutlined />} onClick={() => router.push("/orders")} />
            <Typography.Title level={4} style={{ margin: 0 }}>
              {order?.orderNo ?? "订阅订单详情"}
            </Typography.Title>
            {order ? <Tag color="blue">{labelOf(STATUS_LABELS, order.orderStatus)}</Tag> : null}
          </Space>
          {order ? (
            <Space>
              {order.orderStatus === "PENDING_CONTRACT" ? (
                <Button onClick={generateContract} type="primary">
                  生成合同
                </Button>
              ) : null}
              {order.contract ? (
                <Button onClick={() => router.push(`/contracts/${order.contract?.id}`)}>查看合同</Button>
              ) : null}
              <Button onClick={() => setChangeModalOpen(true)}>创建变更申请</Button>
              {["PENDING_CONTRACT", "PENDING_SIGN", "PENDING_PAYMENT"].includes(order.orderStatus) ? (
                <Button danger onClick={cancelOrder}>
                  取消订单
                </Button>
              ) : null}
            </Space>
          ) : null}
        </Space>

        {loading ? (
          <Spin />
        ) : (
          <Descriptions
            bordered
            column={3}
            items={
              order
              ? [
                  { label: "订单编号", children: order.orderNo },
                  { label: "客户信息", children: `${order.customer.name} / ${order.customer.mobile}` },
                  {
                    label: "关联进件",
                    children: order.application ? (
                      <Link href={`/applications/${order.application.id}`}>{order.application.applicationNo}</Link>
                    ) : "-"
                  },
                  {
                    label: "关联报价",
                    children: order.quote ? <Link href={`/quotes/${order.quote.id}`}>{order.quote.quoteNo}</Link> : "-"
                  },
                  { label: "车型", children: order.vehicleModel },
                  { label: "车辆采购价", children: formatYuan(order.vehiclePurchasePriceAmount) },
                  { label: "月费", children: formatYuan(order.monthlyFeeAmount) },
                  { label: "押金", children: formatYuan(order.depositAmount) },
                  { label: "订阅周期", children: `${order.periodMonths} 个月` },
                  { label: "月里程额度", children: `${order.mileageLimitKm} km` },
                  { label: "订单状态", children: <Tag>{labelOf(STATUS_LABELS, order.orderStatus)}</Tag> },
                  {
                    label: "合同信息",
                    children: order.contract ? (
                      <Link href={`/contracts/${order.contract.id}`}>{order.contract.contractNo}</Link>
                    ) : "-"
                  },
                  { label: "创建时间", children: formatTime(order.createdAt) }
                ]
              : []
            }
          />
        )}

        <Typography.Title level={5} style={{ margin: 0 }}>
          报价快照
        </Typography.Title>
        <pre style={{ background: "#f6f7f9", margin: 0, overflow: "auto", padding: 16 }}>
          {order?.quoteSnapshot ? JSON.stringify(order.quoteSnapshot, null, 2) : "-"}
        </pre>

        <Typography.Title level={5} style={{ margin: 0 }}>
          订单变更记录
        </Typography.Title>
        <Table columns={changeColumns} dataSource={changes} pagination={false} rowKey="id" />

        <Modal
          onCancel={() => setChangeModalOpen(false)}
          onOk={createChange}
          open={changeModalOpen}
          title="创建变更申请"
        >
          <Form form={changeForm} layout="vertical">
            <Form.Item label="变更类型">
              <Input disabled value="方案变更" />
            </Form.Item>
            <Form.Item label="变更原因" name="reason" rules={[{ required: true, message: "请填写变更原因" }]}>
              <Input.TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      </Space>
    </ProtectedShell>
  );
}
