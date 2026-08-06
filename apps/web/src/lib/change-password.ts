import { apiFetch } from "./api";

export interface ChangePasswordFormValues {
  confirmPassword: string;
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export type ChangePasswordValidationCode =
  | "CURRENT_PASSWORD_TOO_SHORT"
  | "NEW_PASSWORD_TOO_SHORT"
  | "PASSWORD_CONFIRMATION_MISMATCH"
  | "PASSWORD_REUSE_NOT_ALLOWED"
  | "PASSWORD_TOO_LONG";

export class ChangePasswordValidationError extends Error {
  constructor(
    readonly code: ChangePasswordValidationCode,
    message: string
  ) {
    super(message);
  }
}

export function buildChangePasswordRequest(
  values: ChangePasswordFormValues
): ChangePasswordRequest {
  if (values.currentPassword.length < 8) {
    throw new ChangePasswordValidationError("CURRENT_PASSWORD_TOO_SHORT", "当前密码至少 8 位");
  }
  if (values.newPassword.length < 8) {
    throw new ChangePasswordValidationError("NEW_PASSWORD_TOO_SHORT", "新密码至少 8 位");
  }
  if (new TextEncoder().encode(values.newPassword).byteLength > 72) {
    throw new ChangePasswordValidationError(
      "PASSWORD_TOO_LONG",
      "新密码最多 72 个 UTF-8 字节"
    );
  }
  if (values.currentPassword === values.newPassword) {
    throw new ChangePasswordValidationError(
      "PASSWORD_REUSE_NOT_ALLOWED",
      "新密码不能与当前密码相同"
    );
  }
  if (values.newPassword !== values.confirmPassword) {
    throw new ChangePasswordValidationError(
      "PASSWORD_CONFIRMATION_MISMATCH",
      "两次输入的新密码不一致"
    );
  }
  return { currentPassword: values.currentPassword, newPassword: values.newPassword };
}

export function changeAdminPassword(request: ChangePasswordRequest) {
  return apiFetch<{ success: true }>("/auth/change-password", {
    body: JSON.stringify(request),
    method: "POST"
  });
}
