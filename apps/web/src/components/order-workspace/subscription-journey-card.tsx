"use client";

import { App, Button, Card, Input, Modal, Space, Tag, Timeline, Typography } from "antd";
import { useState } from "react";

import {
  canRunSubscriptionJourneyAction,
  type PermissionCollection
} from "../../lib/action-guards";
import { decideJourneyDeliveryEvidence } from "../../lib/api";
import {
  getCurrentJourneyStepSummary,
  getJourneyStatusPresentation,
  getSafeJourneyExceptionMessage,
  getStepStatusPresentation,
  getSubscriptionJourneyStepPresentation,
  parseJourneyManualTaskInput,
  type AdminSubscriptionJourney
} from "../../lib/subscription-journey-view-model";
import {
  runJourneyMutation,
  SubscriptionJourneyExceptionActions
} from "./subscription-journey-exception-actions";

export function SubscriptionJourneyCard({
  journey,
  onChanged,
  permissions
}: {
  journey: AdminSubscriptionJourney;
  onChanged: () => Promise<void> | void;
  permissions: PermissionCollection;
}) {
  const { message } = App.useApp();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const status = getJourneyStatusPresentation(journey.status);
  const evidenceAvailability = canRunSubscriptionJourneyAction(
    "DELIVERY_EVIDENCE_DECISION",
    journey.availableActions,
    permissions
  );
  const taskInput = journey.currentTask
    ? parseJourneyManualTaskInput(journey.currentTask)
    : null;

  async function decideEvidence(decision: "APPROVED" | "REJECTED") {
    if (!taskInput || taskInput.kind !== "DELIVERY_EVIDENCE_DECISION") {
      void message.error("交付证据任务数据不可用，请刷新后重试");
      return;
    }
    const notes = rejectReason.trim();
    if (decision === "REJECTED" && !notes) {
      void message.warning("请输入驳回原因");
      return;
    }
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          decideJourneyDeliveryEvidence(journey.id, {
            decision,
            manifestHash: taskInput.manifestHash,
            notes: notes || undefined,
            version: journey.version,
            workOrderId: taskInput.workOrderId
          }),
        onChanged
      );
      setRejectOpen(false);
      setRejectReason("");
      void message.success(decision === "APPROVED" ? "交付证据已通过" : "交付证据已驳回");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "交付证据复核失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      extra={<Tag color={status.color}>{status.label}</Tag>}
      title="订阅 Golden Path"
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Typography.Text strong>{getCurrentJourneyStepSummary(journey)}</Typography.Text>
        <Timeline
          items={journey.steps.map((step) => {
            const stepView = getSubscriptionJourneyStepPresentation(step.code);
            const statusView = getStepStatusPresentation(step.status);
            return {
              children: (
                <Space wrap>
                  <Typography.Text>{stepView.label}</Typography.Text>
                  <Tag color={statusView.color}>{statusView.label}</Tag>
                  {step.attemptCount > 1 ? (
                    <Typography.Text type="secondary">尝试 {step.attemptCount} 次</Typography.Text>
                  ) : null}
                </Space>
              ),
              color: statusView.color === "default" ? "gray" : statusView.color
            };
          })}
        />
        {journey.exceptions
          .filter((exception) => exception.status === "OPEN")
          .map((exception) => (
            <Typography.Text key={exception.id} type="danger">
              {getSafeJourneyExceptionMessage(exception)}
            </Typography.Text>
          ))}
        {evidenceAvailability.allowed ? (
          <Space wrap>
            <Button loading={submitting} onClick={() => void decideEvidence("APPROVED")} type="primary">
              通过证据
            </Button>
            <Button danger onClick={() => setRejectOpen(true)}>
              驳回证据
            </Button>
          </Space>
        ) : null}
        <SubscriptionJourneyExceptionActions
          journey={journey}
          onChanged={onChanged}
          permissions={permissions}
        />
      </Space>
      <Modal
        confirmLoading={submitting}
        destroyOnHidden
        okButtonProps={{ danger: true }}
        okText="确认驳回"
        onCancel={() => setRejectOpen(false)}
        onOk={() => void decideEvidence("REJECTED")}
        open={rejectOpen}
        title="驳回交付证据"
      >
        <Input.TextArea
          aria-label="交付证据驳回原因"
          maxLength={500}
          onChange={(event) => setRejectReason(event.target.value)}
          placeholder="请输入驳回原因"
          rows={3}
          value={rejectReason}
        />
      </Modal>
    </Card>
  );
}
