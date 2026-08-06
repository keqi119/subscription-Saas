"use client";

import { App, Button, Card, Input, InputNumber, Space, Tag, Typography } from "antd";
import { useState } from "react";

import {
  canRunSubscriptionJourneyAction,
  type PermissionCollection
} from "../../lib/action-guards";
import {
  allocateJourneyVehicle,
  decideJourneyFinalPlan
} from "../../lib/api";
import {
  getCurrentJourneyStepSummary,
  getJourneyStatusPresentation,
  type AdminSubscriptionJourney
} from "../../lib/subscription-journey-view-model";
import {
  runJourneyMutation,
  SubscriptionJourneyExceptionActions
} from "../order-workspace/subscription-journey-exception-actions";

export function ApplicationJourneyActions({
  journey,
  onChanged,
  permissions
}: {
  journey: AdminSubscriptionJourney;
  onChanged: () => Promise<void> | void;
  permissions: PermissionCollection;
}) {
  const { message } = App.useApp();
  const [finalPeriodMonths, setFinalPeriodMonths] = useState<number>();
  const [finalSubscriptionPlanId, setFinalSubscriptionPlanId] = useState("");
  const [finalVehicleId, setFinalVehicleId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const status = getJourneyStatusPresentation(journey.status);
  const planAvailability = canRunSubscriptionJourneyAction(
    "FINAL_PLAN_DECISION",
    journey.availableActions,
    permissions
  );
  const vehicleAvailability = canRunSubscriptionJourneyAction(
    "FINAL_VEHICLE_ALLOCATION",
    journey.availableActions,
    permissions
  );

  async function submitPlan() {
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          decideJourneyFinalPlan(journey.id, {
            finalPeriodMonths,
            finalSubscriptionPlanId: finalSubscriptionPlanId.trim() || undefined,
            finalVehicleId: finalVehicleId.trim() || undefined,
            version: journey.version
          }),
        onChanged
      );
      void message.success("最终方案已提交");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "提交最终方案失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitVehicle() {
    if (!vehicleId.trim()) {
      void message.warning("请输入车辆 ID");
      return;
    }
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          allocateJourneyVehicle(journey.id, {
            vehicleId: vehicleId.trim(),
            version: journey.version
          }),
        onChanged
      );
      void message.success("车辆分配已提交");
      await onChanged();
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "车辆分配失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      extra={<Tag color={status.color}>{status.label}</Tag>}
      title="订阅 Golden Path"
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text>{getCurrentJourneyStepSummary(journey)}</Typography.Text>
        {planAvailability.allowed ? (
          <Space wrap>
            <InputNumber
              aria-label="订阅月数"
              min={1}
              onChange={(value) => setFinalPeriodMonths(value ?? undefined)}
              placeholder="订阅月数"
              value={finalPeriodMonths}
            />
            <Input
              aria-label="订阅套餐 ID"
              onChange={(event) => setFinalSubscriptionPlanId(event.target.value)}
              placeholder="订阅套餐 ID（可选）"
              style={{ width: 240 }}
              value={finalSubscriptionPlanId}
            />
            <Input
              aria-label="最终车辆 ID"
              onChange={(event) => setFinalVehicleId(event.target.value)}
              placeholder="最终车辆 ID（可选）"
              style={{ width: 240 }}
              value={finalVehicleId}
            />
            <Button loading={submitting} onClick={() => void submitPlan()} type="primary">
              提交最终方案
            </Button>
          </Space>
        ) : null}
        {vehicleAvailability.allowed ? (
          <Space wrap>
            <Input
              aria-label="分配车辆 ID"
              onChange={(event) => setVehicleId(event.target.value)}
              placeholder="车辆 ID"
              style={{ width: 280 }}
              value={vehicleId}
            />
            <Button loading={submitting} onClick={() => void submitVehicle()} type="primary">
              确认分配车辆
            </Button>
          </Space>
        ) : null}
        <SubscriptionJourneyExceptionActions
          journey={journey}
          onChanged={onChanged}
          permissions={permissions}
        />
      </Space>
    </Card>
  );
}
