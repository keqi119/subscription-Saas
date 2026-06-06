"use client";

import { Button, Tooltip } from "antd";
import type { ButtonProps } from "antd";
import type { MouseEventHandler, ReactNode } from "react";

import {
  actionAvailability,
  type ActionAvailability,
  type PermissionCollection
} from "../lib/action-guards";

export interface ActionButtonProps extends Omit<ButtonProps, "disabled" | "onClick"> {
  allowed?: boolean;
  availability?: ActionAvailability;
  children: ReactNode;
  disabledReason?: string;
  noPermissionReason?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  permission?: string | readonly string[];
  permissions?: PermissionCollection;
}

export function ActionButton({
  allowed = true,
  availability,
  children,
  disabledReason = "当前状态不允许操作",
  noPermissionReason = "无操作权限",
  onClick,
  permission,
  permissions,
  ...buttonProps
}: ActionButtonProps) {
  const resolvedAvailability =
    availability ??
    actionAvailability({
      allowed,
      disabledReason,
      noPermissionReason,
      permission,
      permissions
    });
  const disabled = !resolvedAvailability.allowed || Boolean(buttonProps.loading);
  const button = (
    <Button
      {...buttonProps}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </Button>
  );

  if (!resolvedAvailability.allowed && resolvedAvailability.reason) {
    return (
      <Tooltip title={resolvedAvailability.reason}>
        <span>{button}</span>
      </Tooltip>
    );
  }

  return button;
}
