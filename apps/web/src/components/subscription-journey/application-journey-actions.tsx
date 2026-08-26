"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Input,
  InputNumber,
  Space,
  Tag,
  Typography
} from "antd";
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
  getApplicationValidationWaitPresentation,
  getJourneyVehicleConfirmation,
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
  const [submitting, setSubmitting] = useState(false);
  const status = getJourneyStatusPresentation(journey.status);
  const vehicleConfirmation = getJourneyVehicleConfirmation(journey);
  const planAvailability = canRunSubscriptionJourneyAction(
    "FINAL_PLAN_DECISION",
    journey.availableActions,
    permissions
  );
  const vehicleAvailability = canRunSubscriptionJourneyAction(
    "LEGACY_FINAL_VEHICLE_ALLOCATION",
    journey.availableActions,
    permissions
  );
  const validationWait = getApplicationValidationWaitPresentation(journey);
  const canSubmitPlan =
    Number.isSafeInteger(finalPeriodMonths) &&
    Number(finalPeriodMonths) > 0 &&
    Boolean(finalSubscriptionPlanId.trim()) &&
    Boolean(finalVehicleId.trim());

  async function submitPlan() {
    if (!canSubmitPlan || finalPeriodMonths === undefined) {
      void message.warning("请完整填写订阅月数、订阅套餐和最终车辆");
      return;
    }
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          decideJourneyFinalPlan(journey.id, {
            finalPeriodMonths,
            finalSubscriptionPlanId: finalSubscriptionPlanId.trim(),
            finalVehicleId: finalVehicleId.trim(),
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
    const vehicleId = vehicleConfirmation.vehicleId;
    if (!vehicleId) {
      void message.warning(
        vehicleConfirmation.blockedReason ?? "最终方案缺少车辆，请返回最终方案步骤选择车辆"
      );
      return;
    }
    setSubmitting(true);
    try {
      await runJourneyMutation(
        () =>
          allocateJourneyVehicle(journey.id, {
            vehicleId,
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
        {validationWait ? (
          <Alert
            description={
              <Space orientation="vertical" size={2}>
                <Typography.Text>{validationWait.description}</Typography.Text>
                <Typography.Text type="secondary">
                  {validationWait.factVersion === null
                    ? "等待最新业务事实"
                    : `事实版本 ${validationWait.factVersion}`}
                  {validationWait.waitingAt
                    ? ` · 更新于 ${new Date(validationWait.waitingAt).toLocaleString("zh-CN", { hour12: false })}`
                    : ""}
                </Typography.Text>
              </Space>
            }
            showIcon
            title={validationWait.title}
            type={journey.currentStepStatus === "WAITING_CUSTOMER" ? "warning" : "info"}
          />
        ) : null}
        {planAvailability.allowed ? (
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              请一次填写完整方案。提交后将软锁车辆并开放客户确认。
            </Typography.Text>
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
                placeholder="订阅套餐 ID"
                style={{ width: 240 }}
                value={finalSubscriptionPlanId}
              />
              <Input
                aria-label="最终车辆 ID"
                onChange={(event) => setFinalVehicleId(event.target.value)}
                placeholder="最终车辆 ID"
                style={{ width: 240 }}
                value={finalVehicleId}
              />
              <Button
                disabled={!canSubmitPlan}
                loading={submitting}
                onClick={() => void submitPlan()}
                type="primary"
              >
                提交最终方案并软锁车辆
              </Button>
            </Space>
          </Space>
        ) : null}
        {vehicleAvailability.allowed ? (
          vehicleConfirmation.vehicleId ? (
            <Card size="small" title={vehicleConfirmation.title}>
              <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                <Descriptions
                  column={{ lg: 4, md: 2, sm: 2, xs: 1 }}
                  items={[
                    { children: vehicleConfirmation.vehicle.vehicleNo, label: "车辆编号" },
                    { children: vehicleConfirmation.vehicle.brandAndModel, label: "品牌/车型" },
                    { children: vehicleConfirmation.vehicle.plateNo, label: "车牌号" },
                    { children: vehicleConfirmation.vehicle.vin, label: "VIN" }
                  ]}
                  size="small"
                />
                <Button
                  loading={submitting}
                  onClick={() => void submitVehicle()}
                  type="primary"
                >
                  {vehicleConfirmation.actionLabel}
                </Button>
              </Space>
            </Card>
          ) : (
            <Alert
              showIcon
              title={vehicleConfirmation.blockedReason}
              type="warning"
            />
          )
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
