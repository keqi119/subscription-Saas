"use client";

import { App, Button, Input, Modal, Space, Typography } from "antd";
import { useState } from "react";

import {
  canRunSubscriptionJourneyAction,
  type PermissionCollection,
  type SubscriptionJourneyGuardAction
} from "../../lib/action-guards";
import { ApiError, recoverSubscriptionJourney } from "../../lib/api";
import {
  getSubscriptionJourneyStepPresentation,
  type AdminSubscriptionJourney
} from "../../lib/subscription-journey-view-model";

export function SubscriptionJourneyExceptionActions({
  journey,
  onChanged,
  permissions
}: {
  journey: AdminSubscriptionJourney;
  onChanged: () => Promise<void> | void;
  permissions: PermissionCollection;
}) {
  const { message, modal } = App.useApp();
  const [reasonAction, setReasonAction] = useState<"PAUSE" | "CANCEL" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const retryAvailability = canRunSubscriptionJourneyAction(
    "RETRY",
    journey.availableActions,
    permissions
  );
  const pauseAvailability = canRunSubscriptionJourneyAction(
    "PAUSE",
    journey.availableActions,
    permissions
  );
  const resumeAvailability = canRunSubscriptionJourneyAction(
    "RESUME",
    journey.availableActions,
    permissions
  );
  const cancelAvailability = canRunSubscriptionJourneyAction(
    "CANCEL",
    journey.availableActions,
    permissions
  );
  const retryConfirmation = getJourneyRetryConfirmation(journey);

  async function mutate(
    action: "retry" | "pause" | "resume" | "cancel",
    actionReason: string
  ) {
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          recoverSubscriptionJourney(journey.id, action, {
            reason: actionReason,
            version: journey.version
          }),
        onChanged
      );
      void message.success("订阅流程已更新");
      setReasonAction(null);
      setReason("");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "订阅流程操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  function confirmSimpleAction(action: "retry" | "resume") {
    const isRetry = action === "retry";
    modal.confirm({
      content: isRetry ? retryConfirmation : "恢复前会重新校验当前业务事实。",
      okText: isRetry ? "确认重试" : "确认恢复",
      onOk: () => mutate(action, isRetry ? retryConfirmation : "管理员确认恢复流程"),
      title: isRetry ? "重试失败步骤" : "恢复订阅流程"
    });
  }

  async function submitReason() {
    let normalized: string;
    try {
      normalized = requireJourneyCancelReason(
        reason,
        reasonAction === "CANCEL" ? "请输入取消原因" : "请输入暂停原因"
      );
    } catch (error) {
      void message.warning(error instanceof Error ? error.message : "请输入操作原因");
      return;
    }
    await mutate(reasonAction === "CANCEL" ? "cancel" : "pause", normalized);
  }

  return (
    <>
      <Space wrap>
        {retryAvailability.allowed ? (
          <Button loading={submitting} onClick={() => confirmSimpleAction("retry")}>
            重试失败步骤
          </Button>
        ) : null}
        {pauseAvailability.allowed ? (
          <Button onClick={() => setReasonAction("PAUSE")}>暂停流程</Button>
        ) : null}
        {resumeAvailability.allowed ? (
          <Button loading={submitting} onClick={() => confirmSimpleAction("resume")}>
            恢复流程
          </Button>
        ) : null}
        {cancelAvailability.allowed ? (
          <Button danger onClick={() => setReasonAction("CANCEL")}>
            取消流程
          </Button>
        ) : null}
      </Space>
      {retryAvailability.allowed ? (
        <Typography.Text style={{ display: "block", marginTop: 8 }} type="secondary">
          {retryConfirmation}
        </Typography.Text>
      ) : null}
      <Modal
        confirmLoading={submitting}
        destroyOnHidden
        okButtonProps={{ danger: reasonAction === "CANCEL" }}
        okText={reasonAction === "CANCEL" ? "确认取消" : "确认暂停"}
        onCancel={() => {
          setReasonAction(null);
          setReason("");
        }}
        onOk={() => void submitReason()}
        open={reasonAction !== null}
        title={reasonAction === "CANCEL" ? "取消订阅流程" : "暂停订阅流程"}
      >
        <Typography.Paragraph type="secondary">
          原因将写入审计日志；取消是终态操作。
        </Typography.Paragraph>
        <Input.TextArea
          aria-label={reasonAction === "CANCEL" ? "取消原因" : "暂停原因"}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder={reasonAction === "CANCEL" ? "请输入取消原因" : "请输入暂停原因"}
          rows={3}
          value={reason}
        />
      </Modal>
    </>
  );
}

export function getJourneyRetryConfirmation(journey: AdminSubscriptionJourney) {
  const step = getSubscriptionJourneyStepPresentation(journey.currentStepCode);
  return `将重试“${step.label}”失败步骤；系统会复用原业务幂等键。`;
}

export function requireJourneyCancelReason(value: string, message = "请输入取消原因") {
  const normalized = value.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

export async function runJourneyMutation<T>(
  mutation: () => Promise<T>,
  onStale: () => Promise<void> | void
) {
  try {
    return await mutation();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await onStale();
    }
    throw error;
  }
}

export function hasJourneyAction(
  action: SubscriptionJourneyGuardAction,
  journey: AdminSubscriptionJourney,
  permissions: PermissionCollection
) {
  return canRunSubscriptionJourneyAction(action, journey.availableActions, permissions).allowed;
}
