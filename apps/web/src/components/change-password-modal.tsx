"use client";

import { App, Form, Input, Modal } from "antd";
import { useState } from "react";

import { ApiError } from "../lib/api";
import {
  buildChangePasswordRequest,
  changeAdminPassword,
  type ChangePasswordFormValues,
  type ChangePasswordRequest,
  ChangePasswordValidationError
} from "../lib/change-password";

type PasswordRequest = (payload: ChangePasswordRequest) => Promise<{ success: true }>;

export function submitPasswordChange(
  values: ChangePasswordFormValues,
  request: PasswordRequest = changeAdminPassword
) {
  return request(buildChangePasswordRequest(values));
}

export function ChangePasswordFormFields() {
  return (
    <>
      <Form.Item label="当前密码" name="currentPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="current-password" />
      </Form.Item>
      <Form.Item label="新密码" name="newPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item label="确认新密码" name="confirmPassword" rules={[{ min: 8, required: true }]}>
        <Input.Password autoComplete="new-password" />
      </Form.Item>
    </>
  );
}

export function ChangePasswordModal({
  onCancel,
  onChanged,
  open
}: Readonly<{ onCancel: () => void; onChanged: () => void; open: boolean }>) {
  const { message } = App.useApp();
  const [form] = Form.useForm<ChangePasswordFormValues>();
  const [submitting, setSubmitting] = useState(false);

  const cancel = () => {
    if (submitting) return;
    form.resetFields();
    onCancel();
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      await submitPasswordChange(values);
      form.resetFields();
      void message.success("密码已修改，请重新登录");
      onChanged();
    } catch (error) {
      if (error instanceof ChangePasswordValidationError || error instanceof ApiError) {
        void message.error(error.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
      okText="修改密码"
      onCancel={cancel}
      onOk={() => void submit()}
      open={open}
      title="修改密码"
    >
      <Form form={form} layout="vertical">
        <ChangePasswordFormFields />
      </Form>
    </Modal>
  );
}
