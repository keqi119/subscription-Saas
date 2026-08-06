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
type PasswordChangeEffects = {
  onChanged: () => void;
  onError: (message: string) => void;
  onReset: () => void;
  onSuccess: (message: string) => void;
};

export function submitPasswordChange(
  values: ChangePasswordFormValues,
  request: PasswordRequest = changeAdminPassword
) {
  return request(buildChangePasswordRequest(values));
}

export async function performPasswordChange(
  values: ChangePasswordFormValues,
  effects: PasswordChangeEffects,
  request: PasswordRequest = changeAdminPassword
) {
  try {
    await submitPasswordChange(values, request);
    effects.onReset();
    effects.onSuccess("密码已修改，请重新登录");
    effects.onChanged();
    return true;
  } catch (error) {
    if (error instanceof ChangePasswordValidationError || error instanceof ApiError) {
      effects.onError(error.message);
    }
    return false;
  }
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
      await performPasswordChange(values, {
        onChanged,
        onError: (errorMessage) => {
          void message.error(errorMessage);
        },
        onReset: () => form.resetFields(),
        onSuccess: (successMessage) => {
          void message.success(successMessage);
        }
      });
    } catch {
      // Ant Design displays field validation failures inline.
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
