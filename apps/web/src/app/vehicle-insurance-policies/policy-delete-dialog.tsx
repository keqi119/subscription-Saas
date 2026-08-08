"use client";

import { Form, Input, Modal } from "antd";

export interface PolicyDeleteDialogProps {
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
  open: boolean;
  policyNo: string;
  submitting: boolean;
}

interface PolicyDeleteFormValues {
  reason: string;
}

export function normalizePolicyDeleteReason(value: string) {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 500) {
    throw new Error("删除原因长度必须为 2 到 500 个字符");
  }
  return normalized;
}

export function PolicyDeleteDialogFields() {
  return (
    <Form.Item
      label="删除原因"
      name="reason"
      rules={[
        { message: "请输入删除原因", required: true, whitespace: true },
        { max: 500, message: "删除原因长度必须为 2 到 500 个字符", min: 2 }
      ]}
    >
      <Input.TextArea
        maxLength={500}
        placeholder="例如：保单号录入错误，需重新登记"
        rows={4}
        showCount
      />
    </Form.Item>
  );
}

export function PolicyDeleteDialog({
  onCancel,
  onConfirm,
  open,
  policyNo,
  submitting
}: PolicyDeleteDialogProps) {
  const [form] = Form.useForm<PolicyDeleteFormValues>();

  async function handleFinish(values: PolicyDeleteFormValues) {
    try {
      await onConfirm(normalizePolicyDeleteReason(values.reason));
      form.resetFields();
    } catch {
      // The caller owns the API error message. Keep the reason so the operator can retry.
    }
  }

  function handleCancel() {
    if (submitting) {
      return;
    }
    form.resetFields();
    onCancel();
  }

  return (
    <Modal
      cancelButtonProps={{ disabled: submitting }}
      cancelText="取消"
      closable={!submitting}
      confirmLoading={submitting}
      destroyOnHidden
      maskClosable={!submitting}
      okButtonProps={{ danger: true }}
      okText="确认删除"
      onCancel={handleCancel}
      onOk={() => form.submit()}
      open={open}
      title={`删除错误保单 ${policyNo}`}
    >
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <PolicyDeleteDialogFields />
      </Form>
    </Modal>
  );
}
